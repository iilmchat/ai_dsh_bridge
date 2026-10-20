/**
 * HTTP-клиент DeepSeek (L3).
 *
 * Отправляет `POST /api/v0/chat/completion` с PoW-заголовком
 * `x-ds-pow-response` и разбирает SSE-поток JSON-патчей в
 * типизированные `DeepSeekEvent` (DESIGN § 4, § 5.3, § 6.3).
 *
 * Важно: challenge запрашивается под `target_path` конкретного эндпоинта
 * (`/api/v0/chat/completion`); PoW нельзя кэшировать между эндпоинтами.
 */
import { request } from 'undici';
import { z } from 'zod';
import type { Auth } from '../config.js';
import { encodePowResponse, solvePowAsync, type SolvePowOptions } from './pow.js';
import { AuthExpiredError, DeepSeekApiError, DeepSeekNonSseError, type NonSseResponseDiagnostics } from './errors.js';
import {
  PowChallengeSchema,
  type ChatCompletionRequest,
  type PowChallenge,
  type PowResponse,
} from './types.js';

/** Базовый URL DeepSeek по умолчанию. */
export const DEEPSEEK_BASE_URL = 'https://chat.deepseek.com';

/** `target_path` для PoW перед chat completion. */
export const CHAT_COMPLETION_TARGET_PATH = '/api/v0/chat/completion';

/** Сколько попыток делать при `40301 INVALID_POW_RESPONSE`/сетевых сбоях. */
const DEFAULT_MAX_ATTEMPTS = 3;

/** Событие SSE-потока DeepSeek. */
export type DeepSeekEvent =
  | { readonly type: 'ready'; readonly requestMessageId: number; readonly responseMessageId: number }
  | { readonly type: 'text'; readonly content: string }
  | {
      readonly type: 'patch';
      readonly path: string;
      readonly op: 'APPEND' | 'SET' | 'BATCH';
      readonly value: unknown;
    }
  | { readonly type: 'status'; readonly status: 'FINISHED' | 'WIP' }
  | { readonly type: 'title'; readonly content: string }
  | { readonly type: 'close' }
  | { readonly type: 'error'; readonly code: number; readonly message: string };

/** Минимальный HTTP-ответ, нужный клиенту (упрощает мок undici в тестах). */
export interface HttpClientResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: AsyncIterable<Buffer | Uint8Array | string>;
}

/** Функция HTTP-запроса (по умолчанию `undici.request`). */
export type HttpClientAsync = (
  url: string,
  init: {
    readonly method: 'GET' | 'POST';
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: string;
  },
) => Promise<HttpClientResponse>;

/** Зависимости клиента; все опциональны и подменяются в тестах. */
export interface ClientDependencies {
  readonly httpClient?: HttpClientAsync;
  readonly solvePow?: (challenge: PowChallenge, options?: SolvePowOptions) => Promise<PowResponse>;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly baseUrl?: string;
  readonly maxAttempts?: number;
  readonly onPowSolved?: (info: { readonly answer: number; readonly elapsedMs: number }) => void;
  /** Вызывается после получения PoW-challenge (для e2e-логирования). */
  readonly onChallenge?: (challenge: PowChallenge) => void;
  /** Вызывается с фактическими заголовками completion-запроса (для e2e). */
  readonly onRequestHeaders?: (headers: Readonly<Record<string, string>>) => void;
  /** Вызывается с HTTP-статусом completion-ответа (для e2e). */
  readonly onCompletionStatus?: (statusCode: number) => void;
}

/** Конверт ошибки DeepSeek (`HTTP 200` + `code !== 0` в теле). */
const ApiEnvelopeSchema = z.object({
  code: z.number(),
  msg: z.string().optional(),
});

/** Конверт ответа `create_pow_challenge`. */
const ChallengeEnvelopeSchema = z.object({
  code: z.number(),
  msg: z.string().optional(),
  data: z
    .object({
      biz_data: z.object({ challenge: PowChallengeSchema }).optional(),
      challenge: PowChallengeSchema.optional(),
    })
    .optional(),
  challenge: PowChallengeSchema.optional(),
});

/** Конверт ответа `chat_session/create` (id может лежать в разных полях). */
const ChatSessionEnvelopeSchema = z.object({
  code: z.number(),
  msg: z.string().optional(),
  data: z
    .object({
      biz_data: z
        .object({
          chat_session: z.object({ id: z.string().min(1) }).optional(),
          id: z.string().min(1).optional(),
          chat_session_id: z.string().min(1).optional(),
        })
        .optional(),
    })
    .optional(),
});

/** Проверяет, что значение — объект (type guard для `unknown`). */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** `data: {"v": "текст"}` — append-фрагмент. */
const TextPayloadSchema = z.object({ v: z.string() }).strict();

/** `data: {"v": {...}}` — начальный полный объект ответа. */
const FullResponsePayloadSchema = z.object({ v: z.record(z.string(), z.unknown()) }).strict();

/** `data: {"p": "...", "o": "...", "v": ...}` — JSON Patch. */
const PathPatchPayloadSchema = z.object({
  p: z.string(),
  o: z.enum(['APPEND', 'SET', 'BATCH']),
  v: z.unknown(),
});

/** `event: ready` payload. */
const ReadyPayloadSchema = z.object({
  request_message_id: z.number(),
  response_message_id: z.number(),
});

/** `event: title` payload. */
const TitlePayloadSchema = z.object({ content: z.string() });

/** Задержка (для ретраев). */
const sleepAsync = (milliseconds: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });

/** Экспоненциальная задержка перед повтором. */
const retryDelayMs = (attempt: number): number => 250 * 2 ** (attempt - 1);

/**
 * Приводит заголовки undici к нижнему регистру и строковому виду.
 * @param headers Сырые заголовки ответа.
 */
const normalizeHeaders = (
  headers: Record<string, string | string[] | undefined>,
): Record<string, string | string[] | undefined> => {
  const normalized: Record<string, string | string[] | undefined> = {};
  for (const [name, value] of Object.entries(headers)) {
    normalized[name.toLowerCase()] = value;
  }
  return normalized;
};

/**
 * HTTP-клиент по умолчанию на базе `undici.request`.
 * @param url Полный URL.
 * @param init Метод, заголовки и тело.
 */
const defaultHttpClient: HttpClientAsync = async (url, init) => {
  const response = await request(url, {
    method: init.method,
    headers: init.headers,
    ...(init.body === undefined ? {} : { body: init.body }),
  });
  return {
    statusCode: response.statusCode,
    headers: normalizeHeaders(response.headers),
    body: response.body as AsyncIterable<Buffer | Uint8Array | string>,
  };
};

/**
 * Возвращает значение заголовка (первое, если массив).
 * @param headers Заголовки ответа.
 * @param name Имя в нижнем регистре.
 */
const getHeader = (
  headers: Readonly<Record<string, string | string[] | undefined>>,
  name: string,
): string | undefined => {
  const value = headers[name];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
};

/**
 * Читает тело ответа целиком.
 * @param body Поток тела.
 */
const readBodyAsync = async (
  body: AsyncIterable<Buffer | Uint8Array | string>,
): Promise<string> => {
  const decoder = new TextDecoder();
  let text = '';
  for await (const chunk of body) {
    text += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
  }
  text += decoder.decode();
  return text;
};

/**
 * Освобождает тело ответа (чтобы undici не держал соединение).
 * @param body Поток тела.
 */
const drainBodyAsync = async (
  body: AsyncIterable<Buffer | Uint8Array | string>,
): Promise<void> => {
  try {
    await readBodyAsync(body);
  } catch {
    // Тело уже закрыто/недоступно — не мешает повтору.
  }
};

/**
 * Собирает строку cookie из сохранённой сессии.
 * @param auth Сессия.
 */
const buildCookie = (auth: Auth): string => {
  const parts = [`ds_session_id=${auth.dsSessionId}`];
  if (auth.awsWafToken !== undefined) {
    parts.push(`aws-waf-token=${auth.awsWafToken}`);
  }
  return parts.join('; ');
};

/**
 * Заголовки авторизации для запросов DeepSeek.
 * @param auth Сессия.
 */
const buildAuthHeaders = (auth: Auth): Record<string, string> => ({
  accept: 'application/json',
  authorization: `Bearer ${auth.bearerToken}`,
  cookie: buildCookie(auth),
});

/** Заголовки, которые нельзя включать в диагностику. */
const SENSITIVE_HEADER_NAMES = new Set(['authorization', 'cookie', 'x-ds-pow-response']);

/** Признаки секретов в теле ответа: при обнаружении превью заменяется целиком. */
const SENSITIVE_BODY_PATTERN = /(token|bearer|cookie|session)/iu;

/**
 * Убирает секретные заголовки из диагностики запроса.
 * @param headers Заголовки completion-запроса.
 */
const sanitizeRequestHeaders = (
  headers: Readonly<Record<string, string>>,
): Record<string, string> => {
  const sanitized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!SENSITIVE_HEADER_NAMES.has(name.toLowerCase())) {
      sanitized[name] = value;
    }
  }
  return sanitized;
};

/**
 * Формирует безопасное превью тела не-SSE ответа.
 *
 * Для JSON оставляет безопасные поля `code`/`msg`/`error`, а также
 * `biz_code`/`biz_msg` из `data.biz_data` — туда DeepSeek кладёт
 * бизнес-ошибки. Для не-JSON применяет прежнее правило маскировки по
 * признакам секрета.
 *
 * @param body Тело ответа целиком.
 * @returns Превью до 500 символов.
 */
export const safeBodyPreview = (body: string): string => {
  try {
    const parsed: unknown = JSON.parse(body);
    if (isRecord(parsed)) {
      const safe: Record<string, unknown> = {
        code: parsed['code'],
        msg: parsed['msg'],
        error: parsed['error'],
      };
      const data = parsed['data'];
      if (isRecord(data)) {
        const bizData = data['biz_data'];
        if (isRecord(bizData)) {
          safe['biz_code'] = bizData['biz_code'];
          safe['biz_msg'] = bizData['biz_msg'];
        }
      }
      const serialized = JSON.stringify(safe) ?? '{}';
      return serialized.length > 500 ? serialized.slice(0, 500) : serialized;
    }
  } catch {
    // Не JSON — переходим к проверке признаков секретов.
  }
  if (SENSITIVE_BODY_PATTERN.test(body)) {
    return '<REDACTED: non-JSON body contains secret markers>';
  }
  return body.slice(0, 500);
};

/** Созданная чат-сессия DeepSeek. */
export interface ChatSession {
  readonly id: string;
}

/**
 * Создаёт новую чат-сессию в DeepSeek.
 *
 * DeepSeek Web API требует валидный `chat_session_id` для `/completion`.
 * Случайный UUID не принимается — сессия должна быть создана заранее через
 * `POST /api/v0/chat_session/create`.
 *
 * @param auth Сессия (Bearer + cookie).
 * @param dependencies Зависимости клиента (для тестов).
 * @returns `{ id }` — UUID созданной сессии.
 * @throws AuthExpiredError при 401.
 * @throws DeepSeekApiError если `code !== 0` или нет id в ответе.
 */
export const createChatSessionAsync = async (
  auth: Auth,
  dependencies: ClientDependencies = {},
): Promise<ChatSession> => {
  const httpClient = dependencies.httpClient ?? defaultHttpClient;
  const baseUrl = (dependencies.baseUrl ?? DEEPSEEK_BASE_URL).replace(/\/+$/, '');
  const response = await httpClient(`${baseUrl}/api/v0/chat_session/create`, {
    method: 'POST',
    headers: { ...buildAuthHeaders(auth), 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (response.statusCode === 401) {
    await drainBodyAsync(response.body);
    throw new AuthExpiredError();
  }
  const text = await readBodyAsync(response.body);
  if (response.statusCode !== 200) {
    throw new DeepSeekApiError(response.statusCode, text.slice(0, 200));
  }
  const envelope = ChatSessionEnvelopeSchema.safeParse(safeJsonParse(text));
  if (!envelope.success) {
    throw new DeepSeekApiError(-1, 'Некорректный ответ chat_session/create');
  }
  if (envelope.data.code !== 0) {
    throw new DeepSeekApiError(
      envelope.data.code,
      envelope.data.msg ?? 'create_chat_session failed',
    );
  }
  const bizData = envelope.data.data?.biz_data;
  const id = bizData?.chat_session?.id ?? bizData?.id ?? bizData?.chat_session_id;
  if (id === undefined) {
    throw new DeepSeekApiError(-1, 'chat_session/create: в ответе отсутствует id сессии');
  }
  return { id };
};

/**
 * Запрашивает PoW-challenge под `target_path` chat completion.
 * @param auth Сессия.
 * @param dependencies Зависимости клиента.
 */
const requestPowChallengeAsync = async (
  auth: Auth,
  dependencies: Required<Pick<ClientDependencies, 'httpClient' | 'baseUrl'>>,
): Promise<PowChallenge> => {
  const response = await dependencies.httpClient(
    `${dependencies.baseUrl}/api/v0/chat/create_pow_challenge`,
    {
      method: 'POST',
      headers: { ...buildAuthHeaders(auth), 'content-type': 'application/json' },
      body: JSON.stringify({ target_path: CHAT_COMPLETION_TARGET_PATH }),
    },
  );
  if (response.statusCode === 401) {
    await drainBodyAsync(response.body);
    throw new AuthExpiredError();
  }
  const text = await readBodyAsync(response.body);
  if (response.statusCode !== 200) {
    throw new DeepSeekApiError(response.statusCode, text.slice(0, 200));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new DeepSeekApiError(-1, 'create_pow_challenge вернул не-JSON');
  }
  const envelope = ChallengeEnvelopeSchema.safeParse(parsed);
  if (!envelope.success) {
    throw new DeepSeekApiError(-1, 'Некорректный ответ create_pow_challenge');
  }
  if (envelope.data.code !== 0) {
    throw new DeepSeekApiError(envelope.data.code, envelope.data.msg ?? '');
  }
  const challenge =
    envelope.data.data?.biz_data?.challenge ??
    envelope.data.data?.challenge ??
    envelope.data.challenge;
  if (challenge === undefined) {
    throw new DeepSeekApiError(-1, 'challenge отсутствует в ответе DeepSeek');
  }
  return challenge;
};

/**
 * Парсит один SSE-блок (`event:` + строки `data:`) в события.
 * @param eventName Имя события из `event:`.
 * @param dataLines Накопленные строки `data:`.
 */
export const parseSseEvent = (
  eventName: string | undefined,
  dataLines: readonly string[],
): DeepSeekEvent[] => {
  if (dataLines.length === 0) {
    return [];
  }
  const data = dataLines.join('\n');
  if (data === '[DONE]') {
    return [{ type: 'close' }];
  }
  if (eventName === 'ready') {
    const ready = ReadyPayloadSchema.safeParse(safeJsonParse(data));
    return ready.success
      ? [
          {
            type: 'ready',
            requestMessageId: ready.data.request_message_id,
            responseMessageId: ready.data.response_message_id,
          },
        ]
      : [];
  }
  if (eventName === 'title') {
    const title = TitlePayloadSchema.safeParse(safeJsonParse(data));
    return title.success ? [{ type: 'title', content: title.data.content }] : [];
  }
  if (eventName === 'close') {
    return [{ type: 'close' }];
  }
  if (eventName === 'update_session' || eventName !== undefined) {
    return [];
  }

  const payload = safeJsonParse(data);
  if (payload === undefined) {
    return [];
  }
  const error = ApiEnvelopeSchema.safeParse(payload);
  if (error.success && error.data.code !== 0) {
    return [{ type: 'error', code: error.data.code, message: error.data.msg ?? '' }];
  }
  // Патч проверяем раньше текста: `{p,o,v}` содержит `v`, но это не текст.
  const patch = PathPatchPayloadSchema.safeParse(payload);
  if (patch.success) {
    if (patch.data.p === 'response/status' && (patch.data.v === 'FINISHED' || patch.data.v === 'WIP')) {
      return [{ type: 'status', status: patch.data.v }];
    }
    return [{ type: 'patch', path: patch.data.p, op: patch.data.o, value: patch.data.v }];
  }
  const text = TextPayloadSchema.safeParse(payload);
  if (text.success) {
    return [{ type: 'text', content: text.data.v }];
  }
  const fullResponse = FullResponsePayloadSchema.safeParse(payload);
  if (fullResponse.success) {
    return [{ type: 'patch', path: 'response', op: 'SET', value: fullResponse.data.v }];
  }
  return [];
};

/**
 * Безопасно разбирает JSON, возвращая `undefined` при ошибке.
 * @param text JSON-строка.
 */
const safeJsonParse = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

/**
 * Потоковый SSE-парсер DeepSeek.
 *
 * Понимает `event:`/`data:`-строки, JSON Patch (`p`/`o`/`v`), текстовые
 * фрагменты (`v`), ошибки (`code`), `ready`/`title`/`close`.
 *
 * @param body Поток тела ответа.
 * @yields События `DeepSeekEvent`.
 */
export async function* parseSseStreamAsync(
  body: AsyncIterable<Buffer | Uint8Array | string>,
): AsyncGenerator<DeepSeekEvent> {
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName: string | undefined;
  let dataLines: string[] = [];

  const flush = (): DeepSeekEvent[] => {
    const events = parseSseEvent(eventName, dataLines);
    eventName = undefined;
    dataLines = [];
    return events;
  };

  for await (const chunk of body) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      let line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.endsWith('\r')) {
        line = line.slice(0, -1);
      }
      if (line === '') {
        if (dataLines.length > 0 || eventName !== undefined) {
          for (const event of flush()) {
            yield event;
          }
        }
      } else if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
      newlineIndex = buffer.indexOf('\n');
    }
  }

  buffer += decoder.decode();
  let tail = buffer;
  if (tail.endsWith('\r')) {
    tail = tail.slice(0, -1);
  }
  if (tail.startsWith('data:')) {
    dataLines.push(tail.slice(5).trimStart());
  }
  if (dataLines.length > 0 || eventName !== undefined) {
    for (const event of flush()) {
      yield event;
    }
  }
}

/**
 * Открывает SSE-поток chat completion: PoW-challenge → решение →
 * `x-ds-pow-response` → POST. Повторяет до `maxAttempts` раз при
 * `40301 INVALID_POW_RESPONSE` и сетевых ошибках.
 *
 * @param chatRequest Тело запроса.
 * @param auth Сессия.
 * @param dependencies Зависимости клиента.
 * @returns Ответ с SSE-потоком.
 * @throws AuthExpiredError при 401.
 * @throws DeepSeekApiError при прочих бизнес-ошибках.
 */
export const openCompletionStreamAsync = async (
  chatRequest: ChatCompletionRequest,
  auth: Auth,
  dependencies: ClientDependencies = {},
): Promise<HttpClientResponse> => {
  const httpClient = dependencies.httpClient ?? defaultHttpClient;
  const solvePow = dependencies.solvePow ?? solvePowAsync;
  const sleep = dependencies.sleep ?? sleepAsync;
  const baseUrl = (dependencies.baseUrl ?? DEEPSEEK_BASE_URL).replace(/\/+$/, '');
  const maxAttempts = dependencies.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const resolved = { httpClient, baseUrl };
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const challenge = await requestPowChallengeAsync(auth, resolved);
      dependencies.onChallenge?.(challenge);
      const pow = await solvePow(challenge, {
        targetPath: CHAT_COMPLETION_TARGET_PATH,
        onSolved: (info) => {
          dependencies.onPowSolved?.(info);
        },
      });
      const completionHeaders: Record<string, string> = {
        ...buildAuthHeaders(auth),
        accept: 'text/event-stream',
        'content-type': 'application/json',
        'x-ds-pow-response': encodePowResponse(pow),
      };
      dependencies.onRequestHeaders?.(completionHeaders);
      const response = await httpClient(`${baseUrl}${CHAT_COMPLETION_TARGET_PATH}`, {
        method: 'POST',
        headers: completionHeaders,
        body: JSON.stringify(chatRequest),
      });
      dependencies.onCompletionStatus?.(response.statusCode);

      if (response.statusCode === 401) {
        await drainBodyAsync(response.body);
        throw new AuthExpiredError();
      }
      if (response.statusCode !== 200) {
        await drainBodyAsync(response.body);
        throw new DeepSeekApiError(response.statusCode, `HTTP ${String(response.statusCode)}`);
      }

      const contentType = getHeader(response.headers, 'content-type') ?? null;
      if (contentType !== null && contentType.includes('text/event-stream')) {
        return response;
      }

      const text = await readBodyAsync(response.body);
      const envelope = ApiEnvelopeSchema.safeParse(safeJsonParse(text));
      if (envelope.success && envelope.data.code === 40301) {
        throw new DeepSeekApiError(40301, envelope.data.msg ?? 'INVALID_POW_RESPONSE');
      }
      if (envelope.success && envelope.data.code !== 0) {
        throw new DeepSeekApiError(envelope.data.code, envelope.data.msg ?? '');
      }
      const diagnostics: NonSseResponseDiagnostics = {
        status: response.statusCode,
        contentType,
        bodyPreview: safeBodyPreview(text),
        requestUrl: `${baseUrl}${CHAT_COMPLETION_TARGET_PATH}`,
        requestHeaders: sanitizeRequestHeaders(completionHeaders),
      };
      throw new DeepSeekNonSseError(diagnostics);
    } catch (error: unknown) {
      if (error instanceof AuthExpiredError) {
        throw error;
      }
      if (error instanceof DeepSeekNonSseError) {
        throw error;
      }
      if (error instanceof DeepSeekApiError && error.code !== 40301) {
        throw error;
      }
      lastError = error;
      if (attempt >= maxAttempts) {
        break;
      }
      await sleep(retryDelayMs(attempt));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new DeepSeekApiError(-1, 'Не удалось выполнить запрос к DeepSeek');
};

/**
 * Отправляет сообщение в DeepSeek и стримит типизированные события.
 *
 * `chatSessionId` должен быть создан заранее через `createChatSessionAsync`:
 * случайный UUID DeepSeek не принимает.
 *
 * @param chatRequest Тело запроса без `chat_session_id`.
 * @param auth Сессия.
 * @param chatSessionId Созданная сессия DeepSeek.
 * @param dependencies Зависимости клиента.
 * @yields `DeepSeekEvent` из SSE-потока.
 */
export async function* sendChatAsync(
  chatRequest: Omit<ChatCompletionRequest, 'chat_session_id'>,
  auth: Auth,
  chatSessionId: string,
  dependencies: ClientDependencies = {},
): AsyncGenerator<DeepSeekEvent> {
  const fullRequest: ChatCompletionRequest = {
    ...chatRequest,
    chat_session_id: chatSessionId,
  };
  const response = await openCompletionStreamAsync(fullRequest, auth, dependencies);
  yield* parseSseStreamAsync(response.body);
}

/**
 * Проверяет валидность сохранённой сессии через `GET /api/v0/users/current`.
 * @param auth Сессия.
 * @param dependencies Зависимости клиента (для тестов).
 * @returns `true`, если HTTP 200 и `code === 0`.
 */
export const validateSessionAsync = async (
  auth: Auth,
  dependencies: ClientDependencies = {},
): Promise<boolean> => {
  const httpClient = dependencies.httpClient ?? defaultHttpClient;
  const baseUrl = (dependencies.baseUrl ?? DEEPSEEK_BASE_URL).replace(/\/+$/, '');
  try {
    const response = await httpClient(`${baseUrl}/api/v0/users/current`, {
      method: 'GET',
      headers: buildAuthHeaders(auth),
    });
    if (response.statusCode !== 200) {
      await drainBodyAsync(response.body);
      return false;
    }
    const text = await readBodyAsync(response.body);
    const envelope = ApiEnvelopeSchema.safeParse(safeJsonParse(text));
    return envelope.success && envelope.data.code === 0;
  } catch {
    return false;
  }
};
