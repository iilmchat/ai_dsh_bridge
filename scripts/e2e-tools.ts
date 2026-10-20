/**
 * Диагностический e2e: как модель отвечает DSML, когда в prompt есть tools.
 *
 * Запускается пользователем: `pnpm e2e:tools` (живой) или
 * `pnpm e2e:tools -- --prompt-only` (только Prompt Builder, без сети).
 *
 * Выводит prompt (первые 2000 символов), полный ответ модели, извлечённые
 * `tool_calls` и warnings; пишет лог в `docs/captures/e2e-tools-*.log`.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadAuthAsync, type Auth } from '../src/config.js';
import {
  createChatSessionAsync,
  sendChatAsync,
  validateSessionAsync,
  type ChatSession,
  type ClientDependencies,
  type DeepSeekEvent,
} from '../src/deepseek/client.js';
import {
  AuthExpiredError,
  DeepSeekNonSseError,
} from '../src/deepseek/errors.js';
import type { ChatCompletionRequest } from '../src/deepseek/types.js';
import { parseDsml } from '../src/translate/dsml-parser.js';
import { buildPromptAsync } from '../src/translate/prompt.js';
import type { OpenAiMessage, OpenAiTool, OpenAiToolCall } from '../src/translate/types.js';
import {
  assembleText,
  describeError,
  formatEvent,
  formatLogTimestamp,
  redactSecrets,
} from './e2e-deepseek.js';

/** Зависимости скрипта (для unit-тестов). */
export interface E2EToolsDependencies {
  readonly loadAuth?: () => Promise<Auth>;
  readonly validateSession?: (auth: Auth) => Promise<boolean>;
  readonly createChatSession?: (auth: Auth) => Promise<ChatSession>;
  readonly buildPrompt?: typeof buildPromptAsync;
  readonly sendChat?: (
    request: Omit<ChatCompletionRequest, 'chat_session_id'>,
    auth: Auth,
    chatSessionId: string,
    clientDependencies?: ClientDependencies,
  ) => AsyncIterable<DeepSeekEvent>;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
  readonly writeLog?: (path: string, content: string) => Promise<void>;
  readonly logDirectory?: string;
  readonly promptOnly?: boolean;
  readonly verbose?: boolean;
  readonly date?: Date;
}

/** Результат прогона. */
export interface E2EToolsResult {
  readonly prompt: string;
  readonly text: string;
  readonly toolCalls: readonly OpenAiToolCall[];
  readonly warnings: readonly string[];
  readonly logPath: string;
}

/** Сообщения диагностического запроса. */
const MESSAGES: readonly OpenAiMessage[] = [
  { role: 'user', content: 'Выполни команду ls -la в текущей директории.' },
];

/** Инструмент `bash` для диагностики DSML. */
const TOOLS: readonly OpenAiTool[] = [
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Выполняет shell-команду',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Команда' },
        },
        required: ['command'],
      },
    },
  },
];

/** Двузначное число с ведущим нулём. */
const pad = (value: number): string => String(value).padStart(2, '0');

/**
 * Имя лога с точностью до секунды: `YYYY-MM-DD-HH-mm-ss`.
 * @param date Момент запуска.
 */
export const formatLogTimestampWithSeconds = (date: Date): string =>
  `${formatLogTimestamp(date)}-${pad(date.getSeconds())}`;

/** Запись лога по умолчанию. */
const defaultWriteLog = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
};

/** Печать в stdout. */
const defaultLog = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

/**
 * Полный прогон: Prompt Builder → DeepSeek → сборка текста → parseDsml.
 *
 * @param dependencies Зависимости (для unit-тестов).
 * @returns prompt, текст, tool_calls, warnings, путь к логу.
 * @throws AuthExpiredError/DeepSeekApiError/DeepSeekNonSseError и др.
 */
export const runE2EToolsAsync = async (
  dependencies: E2EToolsDependencies = {},
): Promise<E2EToolsResult> => {
  const logLine = dependencies.log ?? defaultLog;
  const date = dependencies.date ?? new Date();
  const logPath = join(
    dependencies.logDirectory ?? resolve('docs/captures'),
    `e2e-tools-${formatLogTimestampWithSeconds(date)}.log`,
  );
  const writeLog = dependencies.writeLog ?? defaultWriteLog;
  const buildPrompt = dependencies.buildPrompt ?? buildPromptAsync;
  const promptOnly = dependencies.promptOnly === true;
  const verbose = dependencies.verbose === true;
  const now = dependencies.now ?? ((): number => performance.now());
  const loadAuth = dependencies.loadAuth ?? ((): Promise<Auth> => loadAuthAsync());
  const validateSession =
    dependencies.validateSession ??
    ((auth: Auth): Promise<boolean> => validateSessionAsync(auth));
  const createChatSession =
    dependencies.createChatSession ??
    ((auth: Auth): Promise<ChatSession> => createChatSessionAsync(auth));
  const sendChat =
    dependencies.sendChat ??
    ((
      request: Omit<ChatCompletionRequest, 'chat_session_id'>,
      auth: Auth,
      chatSessionId: string,
      clientDependencies?: ClientDependencies,
    ) => sendChatAsync(request, auth, chatSessionId, clientDependencies));

  const lines: string[] = [];
  const record = (line: string): void => {
    lines.push(line);
    logLine(line);
  };
  const logOnly = (line: string): void => {
    lines.push(line);
  };
  const startedAt = now();
  const writeLogSafe = async (): Promise<void> => {
    try {
      await writeLog(logPath, `${redactSecrets(lines.join('\n'))}\n`);
    } catch (error: unknown) {
      process.stderr.write(
        `[e2e-tools] не удалось записать лог ${logPath}: ${describeError(error)}\n`,
      );
    }
  };

  try {
    record('[1] buildPrompt: messages + tools');
    const built = buildPrompt({ messages: MESSAGES, tools: TOOLS });
    record(
      `[2] prompt: ${String(built.prompt.length)} chars; toolsInjected=${built.toolsInjected.join(',') || '—'}`,
    );
    record('----- PROMPT (first 2000 chars) -----');
    record(built.prompt.slice(0, 2000));
    record('----- END PROMPT -----');

    if (promptOnly) {
      record('[3] mode: prompt-only (DeepSeek не вызывается)');
      await writeLogSafe();
      return { prompt: built.prompt, text: '', toolCalls: [], warnings: [], logPath };
    }

    record('[3] mode: live');
    const auth = await loadAuth();
    const valid = await validateSession(auth);
    if (!valid) {
      record('[4] validateSession → FAIL');
      throw new AuthExpiredError('Сессия невалидна. Повторите pnpm webauth.');
    }
    record('[4] validateSession → OK');

    const chatSession = await createChatSession(auth);
    record(`[5] createChatSession → id=${chatSession.id}`);

    const request: Omit<ChatCompletionRequest, 'chat_session_id'> = {
      parent_message_id: null,
      model_type: 'default',
      prompt: built.prompt,
      ref_file_ids: [],
      thinking_enabled: false,
      search_enabled: false,
      action: null,
      preempt: false,
    };

    record('[6] sendChatAsync → DeepSeek');
    const clientDependencies: ClientDependencies = {
      onChallenge: (challenge) => {
        record(`  [6.1] challenge difficulty=${String(challenge.difficulty)}`);
      },
      onPowSolved: (info) => {
        record(`  [6.2] PoW answer=${String(info.answer)} in ${String(info.elapsedMs)}ms`);
      },
      onCompletionStatus: (statusCode) => {
        record(`  [6.3] POST /api/v0/chat/completion → ${String(statusCode)}`);
      },
    };

    const events: DeepSeekEvent[] = [];
    let eventHeaderPrinted = false;
    for await (const event of sendChat(request, auth, chatSession.id, clientDependencies)) {
      events.push(event);
      if (verbose) {
        if (!eventHeaderPrinted) {
          record('[verbose] SSE events:');
          eventHeaderPrinted = true;
        }
        record(`  ${formatEvent(event, true)}`);
      }
    }

    const text = assembleText(events);
    record('[7] assembled text:');
    record(text);

    const parsed = parseDsml(text);
    record(
      `[8] parseDsml → tool_calls=${String(parsed.tool_calls.length)}, warnings=${String(parsed.warnings.length)}`,
    );
    record('tool_calls:');
    record(JSON.stringify(parsed.tool_calls, null, 2));
    if (parsed.warnings.length > 0) {
      record(`warnings: ${JSON.stringify(parsed.warnings)}`);
    }

    const totalMs = Math.round(now() - startedAt);
    logOnly(`--- e2e-tools summary: ${String(totalMs)} ms ---`);
    await writeLogSafe();
    return {
      prompt: built.prompt,
      text,
      toolCalls: parsed.tool_calls,
      warnings: parsed.warnings,
      logPath,
    };
  } catch (error: unknown) {
    if (error instanceof DeepSeekNonSseError) {
      record('[5.1] Non-SSE response:');
      record(`  Status: ${String(error.diagnostics.status)}`);
      record(`  Content-Type: ${error.diagnostics.contentType ?? '<none>'}`);
      record(`  Body preview: ${error.diagnostics.bodyPreview}`);
    }
    logOnly(`[ERROR] ${describeError(error)}`);
    await writeLogSafe();
    throw error;
  }
};

/**
 * Определяет, запущен ли модуль напрямую (`pnpm e2e:tools`).
 */
const isDirectExecution = (): boolean => {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  return pathToFileURL(resolve(entry)).href === import.meta.url;
};

if (isDirectExecution()) {
  const promptOnly = process.argv.includes('--prompt-only');
  const verbose = process.argv.includes('--verbose');
  try {
    const result = await runE2EToolsAsync({ promptOnly, verbose });
    process.stdout.write(`\n[e2e-tools] лог: ${result.logPath}\n`);
  } catch (error: unknown) {
    process.stderr.write(`\n[e2e-tools] ${describeError(error)}\n`);
    process.exitCode = 1;
  }
}
