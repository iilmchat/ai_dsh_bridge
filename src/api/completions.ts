/**
 * Обработчик `POST /v1/chat/completions` (K1 non-streaming + K2 stream).
 *
 * Поток: Zod-валидация → auth → Prompt Builder → DeepSeek (session, PoW,
 * SSE) → сборка текста → DSML-парсер → OpenAI JSON или SSE-поток.
 *
 * Для `stream: true` текст сначала накапливается целиком (DSML нельзя
 * разобрать до закрытия блока), затем отдаётся OpenAI SSE с корректными
 * чанками `tool_calls` (DESIGN § 5.3).
 */
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { loadAuthAsync, type Auth } from '../config.js';
import {
  createChatSessionAsync,
  sendChatAsync,
  validateSessionAsync,
  type ChatSession,
  type ClientDependencies,
  type DeepSeekEvent,
} from '../deepseek/client.js';
import {
  AuthExpiredError,
  AuthNotFoundError,
  DeepSeekApiError,
  DeepSeekNonSseError,
} from '../deepseek/errors.js';
import type { ChatCompletionRequest as DeepSeekCompletionRequest } from '../deepseek/types.js';
import { assembleTextFromEvents, type AssembledText } from '../translate/assemble.js';
import { parseDsml, type ParsedDsml } from '../translate/dsml-parser.js';
import { buildPromptAsync } from '../translate/prompt.js';
import { writeOpenAiSse } from '../translate/sse-writer.js';
import type {
  ChatCompletionResponse,
  OpenAiMessage,
  OpenAiToolCall,
} from '../translate/types.js';
import { ChatCompletionRequestSchema } from './completions.schema.js';

/** Зависимости обработчика (для unit-тестов). */
export interface CompletionsDependencies {
  readonly loadAuth?: () => Promise<Auth>;
  readonly validateSession?: (auth: Auth) => Promise<boolean>;
  readonly createChatSession?: (auth: Auth) => Promise<ChatSession>;
  readonly sendChat?: (
    request: Omit<DeepSeekCompletionRequest, 'chat_session_id'>,
    auth: Auth,
    chatSessionId: string,
    clientDependencies?: ClientDependencies,
  ) => AsyncIterable<DeepSeekEvent>;
  readonly assembleText?: (events: AsyncIterable<DeepSeekEvent>) => Promise<AssembledText>;
  readonly now?: () => number;
  readonly generateId?: () => string;
}

/** Ошибка OpenAI-формата. */
const sendError = (
  reply: FastifyReply,
  status: number,
  type: string,
  message: string,
): FastifyReply => reply.status(status).send({ error: { type, message } });

/** Генерирует `id` ответа (24 hex-символа). */
const defaultGenerateId = (): string => randomBytes(12).toString('hex');

/**
 * Определяет HTTP-статус для ошибки upstream.
 * @param error Ошибка DeepSeek/сети.
 */
const upstreamStatus = (error: unknown): number => {
  if (error instanceof AuthExpiredError || error instanceof AuthNotFoundError) {
    return 401;
  }
  if (error instanceof DeepSeekApiError) {
    return error.code === 429 || (error.code >= 500 && error.code < 600) ? 503 : 502;
  }
  return 502;
};

/**
 * Регистрирует маршрут `POST /v1/chat/completions`.
 *
 * @param app Fastify-инстанс.
 * @param dependencies Зависимости (по умолчанию — реальные клиенты).
 */
export const registerCompletionsRoute = async (
  app: FastifyInstance,
  dependencies: CompletionsDependencies = {},
): Promise<void> => {
  const loadAuth = dependencies.loadAuth ?? ((): Promise<Auth> => loadAuthAsync());
  const validateSession =
    dependencies.validateSession ?? ((auth: Auth): Promise<boolean> => validateSessionAsync(auth));
  const createChatSession =
    dependencies.createChatSession ??
    ((auth: Auth): Promise<ChatSession> => createChatSessionAsync(auth));
  const sendChat =
    dependencies.sendChat ??
    ((
      request: Omit<DeepSeekCompletionRequest, 'chat_session_id'>,
      auth: Auth,
      chatSessionId: string,
      clientDependencies?: ClientDependencies,
    ) => sendChatAsync(request, auth, chatSessionId, clientDependencies));
  const assembleText = dependencies.assembleText ?? assembleTextFromEvents;
  const now = dependencies.now ?? ((): number => Date.now());
  const generateId = dependencies.generateId ?? defaultGenerateId;

  app.post('/v1/chat/completions', async (request, reply) => {
    const parsed = ChatCompletionRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, 'invalid_request_error', parsed.error.message);
    }
    const body = parsed.data;

    let auth: Auth;
    try {
      auth = await loadAuth();
    } catch {
      return sendError(reply, 401, 'auth_error', 'Запустите pnpm webauth');
    }

    const sessionValid = await validateSession(auth);
    if (!sessionValid) {
      return sendError(reply, 401, 'auth_expired', 'Сессия истекла, запустите pnpm webauth');
    }

    let prompt: string;
    try {
      prompt = buildPromptAsync({
        messages: body.messages,
        tools: body.tools,
        toolChoice: body.tool_choice,
      }).prompt;
    } catch (error: unknown) {
      return sendError(reply, 400, 'invalid_request_error', String(error));
    }

    let assembled: AssembledText;
    let parsedDsml: ParsedDsml;
    try {
      const chatSession = await createChatSession(auth);
      const completionRequest: Omit<DeepSeekCompletionRequest, 'chat_session_id'> = {
        parent_message_id: null,
        model_type: body.model === 'deepseek-web-reasoner' ? 'reasoner' : 'default',
        prompt,
        ref_file_ids: [],
        thinking_enabled: body.model === 'deepseek-web-reasoner',
        search_enabled: false,
        action: null,
        preempt: false,
      };
      assembled = await assembleText(sendChat(completionRequest, auth, chatSession.id));
      parsedDsml = parseDsml(assembled.text);
    } catch (error: unknown) {
      const status = upstreamStatus(error);
      const message =
        error instanceof DeepSeekNonSseError
          ? `DeepSeek вернул не-SSE ответ: ${error.diagnostics.bodyPreview}`
          : String(error);
      return sendError(
        reply,
        status,
        status === 503 ? 'upstream_unavailable' : 'upstream_error',
        message,
      );
    }

    const responseId = `chatcmpl-${generateId()}`;
    const created = Math.floor(now() / 1000);
    const usage = {
      prompt_tokens: 0,
      completion_tokens: assembled.tokenUsage ?? 0,
      total_tokens: assembled.tokenUsage ?? 0,
    };
    const content = parsedDsml.text === '' ? null : parsedDsml.text;
    const toolCalls: OpenAiToolCall[] = parsedDsml.tool_calls;

    if (body.stream) {
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const sse = writeOpenAiSse({
        id: responseId,
        model: body.model,
        content,
        toolCalls,
        created,
        usage,
        includeUsage: body.stream_options?.include_usage === true,
      });
      try {
        for (const chunk of sse) {
          reply.raw.write(chunk);
        }
      } finally {
        reply.raw.end();
      }
      return reply;
    }

    const message: OpenAiMessage & { tool_calls?: OpenAiToolCall[] } = {
      role: 'assistant',
      content,
    };
    if (toolCalls.length > 0) {
      message.tool_calls = toolCalls;
    }

    const response: ChatCompletionResponse = {
      id: responseId,
      object: 'chat.completion',
      created,
      model: body.model,
      choices: [
        {
          index: 0,
          message,
          finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
        },
      ],
      usage,
    };
    return reply.send(response);
  });
};
