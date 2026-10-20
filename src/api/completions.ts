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
  fetchFilesAsync,
  sendChatAsync,
  uploadFileAsync,
  validateSessionAsync,
  type ChatSession,
  type ClientDependencies,
  type DeepSeekEvent,
  type FileInfo,
  type UploadedFile,
  type UploadFileInput,
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
import {
  ChatCompletionRequestSchema,
  type ChatCompletionRequestBody,
} from './completions.schema.js';

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
  /** Загрузка изображения в DeepSeek (по умолчанию `uploadFileAsync`). */
  readonly uploadFile?: (auth: Auth, file: UploadFileInput) => Promise<UploadedFile>;
  /** Ожидание готовности файлов (по умолчанию `fetchFilesAsync`). */
  readonly fetchFiles?: (auth: Auth, fileIds: readonly string[]) => Promise<readonly FileInfo[]>;
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

/** Максимальный размер входного изображения (10 МиБ, DESIGN § 3.5). */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Таймаут скачивания изображения по `http(s)`, мс. */
const IMAGE_DOWNLOAD_TIMEOUT_MS = 15_000;

/** `data:image/png;base64,...` (пробелы и переводы строк в base64 допустимы). */
const DATA_URL_PATTERN = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/iu;

/** Ошибка входного изображения (некорректный `image_url`). */
class ImageInputError extends Error {
  public override readonly name = 'ImageInputError';

  public constructor(message: string) {
    super(message);
  }
}

/**
 * Извлекает `image_url` из `content`-частей сообщений (S3).
 * Строковый `content` и части `text` не дают изображений.
 *
 * @param messages Сообщения запроса.
 * @returns URL изображений в порядке сообщений.
 */
const extractImageUrls = (messages: ChatCompletionRequestBody['messages']): string[] => {
  const urls: string[] = [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) {
      continue;
    }
    for (const part of message.content) {
      if (part.type === 'image_url') {
        urls.push(part.image_url.url);
      }
    }
  }
  return urls;
};

/**
 * Определяет расширение файла по MIME-типу.
 * @param mimeType MIME-тип изображения.
 */
const extensionForMimeType = (mimeType: string): string => {
  const subtype = mimeType.toLowerCase().split('/')[1] ?? 'png';
  const normalized = subtype === 'jpeg' ? 'jpg' : subtype === 'svg+xml' ? 'svg' : subtype;
  const safe = normalized.replaceAll(/[^a-z0-9]/gu, '');
  return safe === '' ? 'png' : safe;
};

/**
 * Собирает имя файла для multipart по порядковому номеру и MIME-типу.
 * @param index Индекс изображения.
 * @param mimeType MIME-тип.
 */
const imageFileName = (index: number, mimeType: string): string =>
  `image-${String(index + 1)}.${extensionForMimeType(mimeType)}`;

/**
 * Декодирует `data:image/...;base64,...` в данные для `upload_file`.
 * @param url data-URL изображения.
 * @param index Индекс изображения (для имени файла).
 */
const decodeDataUrlImage = (url: string, index: number): UploadFileInput => {
  const match = DATA_URL_PATTERN.exec(url);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw new ImageInputError(
      'image_url: поддерживаются data:image/<mime>;base64,... и http(s)-URL',
    );
  }
  const mimeType = match[1].toLowerCase();
  const data = Buffer.from(match[2], 'base64');
  if (data.length === 0) {
    throw new ImageInputError('image_url: пустые данные изображения');
  }
  if (data.length > MAX_IMAGE_BYTES) {
    throw new ImageInputError('image_url: изображение больше 10 МиБ');
  }
  return { data, mimeType, fileName: imageFileName(index, mimeType) };
};

/**
 * Загружает изображение по `image_url` (data-URL или http(s)-URL).
 * @param url URL изображения.
 * @param index Индекс изображения (для имени файла).
 */
const loadImageAsync = async (url: string, index: number): Promise<UploadFileInput> => {
  if (url.startsWith('data:')) {
    return decodeDataUrlImage(url, index);
  }
  if (!/^https?:\/\//iu.test(url)) {
    throw new ImageInputError(
      'image_url: неподдерживаемая схема (ожидается data:image/...;base64,... или http(s))',
    );
  }
  let response: Response;
  try {
    response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(IMAGE_DOWNLOAD_TIMEOUT_MS),
    });
  } catch {
    throw new ImageInputError('image_url: не удалось скачать изображение');
  }
  if (!response.ok) {
    throw new ImageInputError(`image_url: HTTP ${String(response.status)} при скачивании`);
  }
  const contentType =
    (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (!contentType.startsWith('image/')) {
    throw new ImageInputError('image_url: ответ не является изображением');
  }
  const data = new Uint8Array(await response.arrayBuffer());
  if (data.length === 0) {
    throw new ImageInputError('image_url: пустые данные изображения');
  }
  if (data.length > MAX_IMAGE_BYTES) {
    throw new ImageInputError('image_url: изображение больше 10 МиБ');
  }
  return { data, mimeType: contentType, fileName: imageFileName(index, contentType) };
};

/**
 * Загружает все изображения из `messages`.
 * @param messages Сообщения запроса.
 * @returns Входные данные для `upload_file`.
 */
const loadImagesAsync = async (
  messages: ChatCompletionRequestBody['messages'],
): Promise<UploadFileInput[]> => {
  const urls = extractImageUrls(messages);
  const images: UploadFileInput[] = [];
  for (const [index, url] of urls.entries()) {
    images.push(await loadImageAsync(url, index));
  }
  return images;
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
  const uploadFile =
    dependencies.uploadFile ??
    ((auth: Auth, file: UploadFileInput): Promise<UploadedFile> => uploadFileAsync(auth, file));
  const fetchFiles =
    dependencies.fetchFiles ??
    ((auth: Auth, fileIds: readonly string[]): Promise<readonly FileInfo[]> =>
      fetchFilesAsync(auth, fileIds));
  const now = dependencies.now ?? ((): number => Date.now());
  const generateId = dependencies.generateId ?? defaultGenerateId;

  app.post('/v1/chat/completions', async (request, reply) => {
    const parsed = ChatCompletionRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, 'invalid_request_error', parsed.error.message);
    }
    const body = parsed.data;

    // Временная диагностика: включается только DEBUG_MESSAGES=1.
    if (process.env.DEBUG_MESSAGES === '1') {
      request.log.info(
        {
          messages: body.messages.map((message) => ({
            role: message.role,
            contentType: typeof message.content === 'string' ? 'string' : typeof message.content,
            contentLength: typeof message.content === 'string' ? message.content.length : null,
            contentPreview:
              typeof message.content === 'string' ? message.content.slice(0, 150) : null,
            toolCallId: message.tool_call_id,
            hasToolCalls: Array.isArray(message.tool_calls) && message.tool_calls.length > 0,
          })),
        },
        'Incoming messages from DSH',
      );
    }

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

    // S3: изображения из `content` (data:base64 и http(s)) готовим заранее —
    // ошибки входного image_url возвращаем как 400 до похода в DeepSeek.
    let images: UploadFileInput[];
    try {
      images = await loadImagesAsync(body.messages);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return sendError(reply, 400, 'invalid_request_error', message);
    }

    let assembled: AssembledText;
    let parsedDsml: ParsedDsml;
    try {
      const refFileIds: string[] = [];
      for (const image of images) {
        const uploaded = await uploadFile(auth, image);
        refFileIds.push(uploaded.id);
      }
      if (refFileIds.length > 0) {
        await fetchFiles(auth, refFileIds);
      }
      const chatSession = await createChatSession(auth);
      const completionRequest: Omit<DeepSeekCompletionRequest, 'chat_session_id'> = {
        parent_message_id: null,
        // Захват 2026-10-20: при изображении клиент отправляет model_type
        // "default", а картинка передаётся через ref_file_ids (не "vision").
        model_type: body.model === 'deepseek-web-reasoner' ? 'reasoner' : 'default',
        prompt,
        ref_file_ids: refFileIds,
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
    let content: string | null = parsedDsml.text === '' ? null : parsedDsml.text;
    const toolCalls: OpenAiToolCall[] = parsedDsml.tool_calls;

    // DSH падает на «completed response with no content», поэтому при пустом
    // ответе без tool_calls синтезируем минимальный текст.
    if (content === null && toolCalls.length === 0) {
      const hadToolResult = body.messages.some((message) => message.role === 'tool');
      if (hadToolResult) {
        const lastTool = body.messages.toReversed().find((message) => message.role === 'tool');
        const toolContent = lastTool?.content;
        content =
          typeof toolContent === 'string' && toolContent !== ''
            ? `Результат: ${toolContent.slice(0, 500)}`
            : 'Готово. Инструмент выполнен.';
      } else {
        content = 'Готово.';
      }
      request.log.warn('DeepSeek вернул пустой content, синтезирован fallback');
    }

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
