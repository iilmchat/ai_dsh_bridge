/**
 * Одноразовый живой e2e DeepSeek Client.
 *
 * Запускается пользователем после `pnpm webauth`:
 *   pnpm e2e:deepseek [--verbose]
 *
 * Проверяет: сессию, PoW-challenge, solvePow, POST completion, SSE-поток,
 * сборку текста и `status: FINISHED`. Пишет лог в
 * `docs/captures/e2e-<YYYY-MM-DD-HH-mm>.log` с редактированием секретов.
 *
 * Скрипт НЕ запускается автоматически в тестах/CI (нет auth.json).
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
  AuthNotFoundError,
  DeepSeekApiError,
  DeepSeekNonSseError,
  type NonSseResponseDiagnostics,
} from '../src/deepseek/errors.js';
import type { ChatCompletionRequest } from '../src/deepseek/types.js';

/** Зависимости e2e-скрипта; все опциональны и подменяются в unit-тестах. */
export interface E2EDependencies {
  readonly loadAuth?: () => Promise<Auth>;
  readonly validateSession?: (auth: Auth) => Promise<boolean>;
  readonly createChatSession?: (auth: Auth) => Promise<ChatSession>;
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
  readonly verbose?: boolean;
  readonly date?: Date;
}

/** Результат успешного прогона. */
export interface E2EResult {
  readonly ok: boolean;
  readonly text: string;
  readonly events: readonly DeepSeekEvent[];
  readonly logPath: string;
}

/** Проверяет, что значение — объект (type guard для `unknown`). */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** Двузначное число с ведущим нулём. */
const pad = (value: number): string => String(value).padStart(2, '0');

/**
 * Формирует имя лога `YYYY-MM-DD-HH-mm` по локальному времени.
 * @param date Момент запуска.
 */
export const formatLogTimestamp = (date: Date): string => {
  return [
    String(date.getFullYear()),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    pad(date.getHours()),
    pad(date.getMinutes()),
  ].join('-');
};

/**
 * Удаляет секреты из строк лога.
 * @param text Текст для записи в лог.
 * @returns Текст с `<REDACTED>` вместо токенов/cookie/PoW.
 */
export const redactSecrets = (text: string): string =>
  text
    .replace(/(authorization\s*:\s*)[^\r\n]+/giu, '$1<REDACTED>')
    .replace(/(cookie\s*:\s*)[^\r\n]+/giu, '$1<REDACTED>')
    .replace(/(x-ds-pow-response\s*:\s*)[^\r\n]+/giu, '$1<REDACTED>')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gu, 'Bearer <REDACTED>');

/**
 * Человекочитаемое описание ошибки для консоли/лога.
 * @param error Перехваченная ошибка.
 */
export const describeError = (error: unknown): string => {
  if (error instanceof DeepSeekApiError) {
    return error.code === 40_301
      ? `PoW отклонён: ${String(error.code)} ${error.apiMessage}`
      : `DeepSeek API error ${String(error.code)}: ${error.apiMessage}`;
  }
  if (error instanceof AuthExpiredError) {
    return 'Сессия истекла, повторите pnpm webauth.';
  }
  if (error instanceof AuthNotFoundError) {
    return 'auth.json не найден. Запустите pnpm webauth.';
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
};

/**
 * Безопасный JSON.stringify (для произвольных значений событий).
 * @param value Значение.
 */
const asJson = (value: unknown): string => JSON.stringify(value) ?? 'undefined';

/**
 * Собирает текст ответа из событий SSE (initial SET + APPEND + text).
 * @param events События потока.
 * @returns Собранный текст ассистента.
 */
export const assembleText = (events: readonly DeepSeekEvent[]): string => {
  let text = '';
  for (const event of events) {
    if (event.type === 'text') {
      text += event.content;
      continue;
    }
    if (event.type !== 'patch') {
      continue;
    }
    if (event.op === 'SET' && event.path === 'response') {
      const initial = extractInitialFragments(event.value);
      if (initial !== undefined) {
        text += initial;
      }
      continue;
    }
    if (event.op === 'APPEND' && event.path.endsWith('/content') && typeof event.value === 'string') {
      text += event.value;
    }
  }
  return text;
};

/**
 * Извлекает содержимое фрагментов RESPONSE из начального объекта ответа.
 * @param payload Значение patch `{response: {fragments: [...]}}`.
 */
const extractInitialFragments = (payload: unknown): string | undefined => {
  if (!isRecord(payload)) {
    return undefined;
  }
  const response = payload['response'];
  if (!isRecord(response)) {
    return undefined;
  }
  const fragments = response['fragments'];
  if (!Array.isArray(fragments)) {
    return undefined;
  }
  let content = '';
  for (const fragment of fragments) {
    if (!isRecord(fragment) || fragment['type'] !== 'RESPONSE') {
      continue;
    }
    const value = fragment['content'];
    if (typeof value === 'string') {
      content += value;
    }
  }
  return content;
};

/**
 * Форматирует событие для консоли/лога.
 * @param event Событие.
 * @param verbose Печатать полный JSON.
 */
export const formatEvent = (event: DeepSeekEvent, verbose: boolean): string => {
  if (verbose) {
    return asJson(event);
  }
  switch (event.type) {
    case 'ready':
      return `event: ready {"request_message_id":${String(event.requestMessageId)},"response_message_id":${String(event.responseMessageId)}}`;
    case 'text':
      return `event: text  ${asJson(event.content)}`;
    case 'patch':
      return `event: patch ${event.path} ${event.op} ${asJson(event.value).slice(0, 160)}`;
    case 'status':
      return `event: status "${event.status}"`;
    case 'title':
      return `event: title ${asJson(event.content)}`;
    case 'close':
      return 'event: close';
    case 'error':
      return `event: error ${String(event.code)} ${event.message}`;
    default:
      return asJson(event);
  }
};

/**
 * Тело запроса e2e (как в ТЗ: `prompt: "привет"`, search выключен).
 * `chat_session_id` подставляется в `sendChatAsync` из созданной сессии.
 */
export const buildChatRequest = (): Omit<ChatCompletionRequest, 'chat_session_id'> => ({
  parent_message_id: null,
  model_type: 'default',
  prompt: 'привет',
  ref_file_ids: [],
  thinking_enabled: false,
  search_enabled: false,
  action: null,
  preempt: false,
});

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
 * Печатает диагностику не-SSE ответа DeepSeek (секреты уже вырезаны).
 * @param record Функция записи строки (консоль + лог).
 * @param diagnostics Диагностика из `DeepSeekNonSseError`.
 */
const recordNonSseDiagnostics = (
  record: (line: string) => void,
  diagnostics: NonSseResponseDiagnostics,
): void => {
  record('[5.1] Non-SSE response:');
  record(`  Status: ${String(diagnostics.status)}`);
  record(`  Content-Type: ${diagnostics.contentType ?? '<none>'}`);
  record(`  Request URL: ${diagnostics.requestUrl}`);
  record(`  Request headers: ${asJson(diagnostics.requestHeaders)}`);
  record(`  Body preview (first 500 chars): ${diagnostics.bodyPreview}`);
};

/**
 * Полный e2e-сценарий: сессия → PoW → completion → SSE → сборка текста → лог.
 *
 * @param dependencies Зависимости (для unit-тестов).
 * @returns Результат: ok, собранный текст, события, путь к логу.
 * @throws AuthExpiredError если сессия невалидна.
 * @throws DeepSeekApiError если DeepSeek вернул бизнес-ошибку.
 * @throws DeepSeekNonSseError если ответ не SSE (с диагностикой).
 */
export const runE2EAsync = async (dependencies: E2EDependencies = {}): Promise<E2EResult> => {
  const now = dependencies.now ?? ((): number => performance.now());
  const logLine = dependencies.log ?? defaultLog;
  const verbose = dependencies.verbose === true;
  const date = dependencies.date ?? new Date();
  const logDirectory = dependencies.logDirectory ?? resolve('docs/captures');
  const logPath = join(logDirectory, `e2e-${formatLogTimestamp(date)}.log`);
  const writeLog = dependencies.writeLog ?? defaultWriteLog;
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
        `[e2e] не удалось записать лог ${logPath}: ${describeError(error)}\n`,
      );
    }
  };

  try {
    const auth = await loadAuth();

    const validateStartedAt = now();
    const valid = await validateSession(auth);
    const validateMs = Math.round(now() - validateStartedAt);
    if (!valid) {
      record(`[1] validateSession → FAIL (${String(validateMs)} ms)`);
      throw new AuthExpiredError('Сессия невалидна. Повторите pnpm webauth.');
    }
    record(`[1] validateSession → OK (${String(validateMs)} ms)`);

    const chatSession = await createChatSession(auth);
    record(`[2] createChatSession → id=${chatSession.id}`);
    const chatRequest = buildChatRequest();
    const events: DeepSeekEvent[] = [];
    let streamHeaderPrinted = false;

    const clientDependencies: ClientDependencies = {
      onChallenge: (challenge) => {
        record(
          `[3] createPowChallenge → challenge=${challenge.challenge.slice(0, 16)}... difficulty=${String(challenge.difficulty)}`,
        );
      },
      onPowSolved: (info) => {
        record(`[4] solvePow → answer=${String(info.answer)} in ${String(info.elapsedMs)}ms`);
      },
      onRequestHeaders: (headers) => {
        if (verbose) {
          const printable = Object.entries(headers)
            .map(([name, value]) => `${name}: ${value}`)
            .join('; ');
          record(`[verbose] headers: ${redactSecrets(printable)}`);
        }
      },
      onCompletionStatus: (statusCode) => {
        record(`[5] POST /api/v0/chat/completion → ${String(statusCode)}`);
      },
    };

    for await (const event of sendChat(chatRequest, auth, chatSession.id, clientDependencies)) {
      events.push(event);
      if (!streamHeaderPrinted) {
        record('[6] SSE stream:');
        streamHeaderPrinted = true;
      }
      record(`  ${formatEvent(event, verbose)}`);
    }

    const text = assembleText(events);
    record(`[7] Assembled text: ${asJson(text)}`);

    const ready = events.find((event) => event.type === 'ready');
    const hasText = events.some((event) => event.type === 'text');
    const finished = events.some(
      (event) => event.type === 'status' && event.status === 'FINISHED',
    );
    if (ready === undefined || !hasText || !finished || text.trim().length === 0) {
      throw new Error(
        `E2E FAILED: ready=${String(ready !== undefined)}, text=${String(hasText)}, finished=${String(finished)}, assembledLen=${String(text.length)}`,
      );
    }
    record('[8] E2E OK');

    const totalMs = Math.round(now() - startedAt);
    logOnly('--- e2e summary ---');
    logOnly(`total: ${String(totalMs)} ms; events: ${String(events.length)}; text length: ${String(text.length)}`);
    await writeLogSafe();
    return { ok: true, text, events, logPath };
  } catch (error: unknown) {
    if (error instanceof DeepSeekNonSseError) {
      recordNonSseDiagnostics(record, error.diagnostics);
    }
    logOnly(`[ERROR] ${describeError(error)}`);
    await writeLogSafe();
    throw error;
  }
};

/**
 * Определяет, запущен ли модуль напрямую (`pnpm e2e:deepseek`).
 */
const isDirectExecution = (): boolean => {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  return pathToFileURL(resolve(entry)).href === import.meta.url;
};

if (isDirectExecution()) {
  const verbose = process.argv.includes('--verbose');
  try {
    const result = await runE2EAsync({ verbose });
    process.stdout.write(`\n[e2e] лог: ${result.logPath}\n`);
  } catch (error: unknown) {
    process.stderr.write(`\n[e2e] ${describeError(error)}\n`);
    process.exitCode = 1;
  }
}
