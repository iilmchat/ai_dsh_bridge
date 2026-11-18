/**
 * Общие HTTP-утилиты Google-провайдеров.
 *
 * Сеть в проекте всегда вызывается с отменой и таймаутом (RULES § 4.4), а
 * `fetch` подменяется в тестах — поэтому тип и комбинирование сигналов живут
 * в одном месте.
 */

/** Функция HTTP-запроса (по умолчанию глобальный `fetch`). */
export type FetchAsync = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Комбинирует внешний сигнал отмены с таймаутом запроса.
 * @param signal Сигнал клиента (может отсутствовать).
 * @param timeoutMs Таймаут запроса, мс.
 * @returns Сигнал для `fetch`.
 */
export const combineSignals = (signal: AbortSignal | undefined, timeoutMs: number): AbortSignal => {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
};

/**
 * Проверяет, что ошибка — отмена/таймаут `fetch`.
 * @param error Перехваченная ошибка.
 */
export const isAbortError = (error: unknown): boolean =>
  error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');

/**
 * Безопасно извлекает текст ошибки (без стеков и секретов).
 * @param error Перехваченная ошибка.
 */
export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
