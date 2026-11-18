/**
 * Общие HTTP-утилиты Google-провайдеров.
 *
 * Особенность Google: `/app` и `StreamGenerate` отдают ~30 КБ заголовков
 * (несколько `Set-Cookie`), что превышает лимит стандартного `fetch`
 * (undici, 16 КБ) и приводит к `HeadersOverflowError`. Поэтому запросы идут
 * через `undici.Client` с увеличенным `maxHeaderSize`; ответ приводится к
 * узкому интерфейсу `HttpResponseLike`, который структурно совместим с
 * `Response` (в тестах подменяется обычным `Response`).
 */
import { Client } from 'undici';

/** Максимальный размер заголовков ответа Google (наблюдалось ~30 КБ). */
const MAX_HEADER_SIZE = 512 * 1024;

/** Ответ upstream, нужный провайдерам (подмножество `Response`). */
export interface HttpResponseLike {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

/** Функция HTTP-запроса (по умолчанию — `googleRequestAsync`). */
export type FetchAsync = (url: string, init: RequestInit) => Promise<HttpResponseLike>;

/** Заголовки запроса в том виде, в каком их принимает `RequestInit`. */
type RequestHeaders = NonNullable<RequestInit['headers']>;

/**
 * Приводит заголовки к объекту без приведения типов.
 * @param headers Заголовки запроса.
 */
const toHeaderRecord = (headers: RequestHeaders | undefined): Record<string, string> => {
  if (headers === undefined) {
    return {};
  }
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  const result: Record<string, string> = {};
  if (Array.isArray(headers)) {
    for (const [name, value] of headers) {
      if (typeof name === 'string' && typeof value === 'string') {
        result[name] = value;
      }
    }
    return result;
  }
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === 'string') {
      result[name] = value;
    }
  }
  return result;
};

/**
 * Выполняет один HTTP-запрос к Google через `undici.Client`.
 *
 * Соединение закрывается после чтения тела: провайдер делает 1–2 запроса на
 * turn, поэтому переиспользование сокета не критично, а утечек нет.
 * Редиректы не следуются: для Google 3xx означает «сессия истекла», и
 * провайдер сообщает об этом как 401 (KI-1017).
 *
 * @param url Абсолютный URL.
 * @param init Метод, заголовки, тело и сигнал отмены.
 * @returns Статус, `ok` и текст ответа.
 */
export const googleRequestAsync: FetchAsync = async (url, init) => {
  const { origin, pathname, search } = new URL(url);
  const client = new Client(origin, { maxHeaderSize: MAX_HEADER_SIZE });
  try {
    const method = init.method === 'POST' ? 'POST' : 'GET';
    const body =
      typeof init.body === 'string'
        ? init.body
        : init.body instanceof Uint8Array
          ? init.body
          : undefined;
    const response = await client.request({
      method,
      path: `${pathname}${search}`,
      headers: toHeaderRecord(init.headers),
      ...(body === undefined ? {} : { body }),
      ...(init.signal === undefined || init.signal === null ? {} : { signal: init.signal }),
    });
    const text = await response.body.text();
    return {
      ok: response.statusCode >= 200 && response.statusCode < 300,
      status: response.statusCode,
      text: async (): Promise<string> => text,
    };
  } finally {
    await client.close();
  }
};

/**
 * Комбинирует внешний сигнал отмены с таймаутом запроса.
 * @param signal Сигнал клиента (может отсутствовать).
 * @param timeoutMs Таймаут запроса, мс.
 * @returns Сигнал для запроса.
 */
export const combineSignals = (signal: AbortSignal | undefined, timeoutMs: number): AbortSignal => {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
};

/**
 * Проверяет, что ошибка — отмена/таймаут HTTP-запроса.
 * @param error Перехваченная ошибка.
 */
export const isAbortError = (error: unknown): boolean => {
  if (!(error instanceof Error)) {
    return false;
  }
  if (error.name === 'AbortError' || error.name === 'TimeoutError') {
    return true;
  }
  if ('code' in error && typeof error.code === 'string') {
    return (
      error.code === 'UND_ERR_ABORTED' ||
      error.code === 'UND_ERR_HEADERS_TIMEOUT' ||
      error.code === 'UND_ERR_BODY_TIMEOUT'
    );
  }
  return false;
};

/**
 * Безопасно извлекает текст ошибки (без стеков и секретов).
 * @param error Перехваченная ошибка.
 */
export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
