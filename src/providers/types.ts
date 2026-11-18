/**
 * Контракт провайдера моделей (L3).
 *
 * Слой L2 (Prompt Builder + DSML-парсер) общий: любой провайдер получает
 * готовую системную инструкцию и текстовый транскрипт и возвращает текст,
 * который затем разбирается DSML-парсером (ARCHITECTURE § 8.1). Контракт
 * намеренно минимальный: не-streaming результат + usage, потому что
 * `POST /v1/chat/completions` собирает ответ целиком перед SSE (DESIGN § 5.3).
 */

/** Идентификаторы upstream-провайдеров, подключённых к шлюзу. */
export type ProviderId = 'deepseek-web' | 'google-gemini-api' | 'google-gemini-web';

/** Токены, израсходованные провайдером (0 — если upstream их не сообщает). */
export interface ProviderUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
}

/** Usage по умолчанию: веб-чат Google не отдаёт токены. */
export const ZERO_USAGE: ProviderUsage = { promptTokens: 0, completionTokens: 0 };

/** Запрос на завершение, уже переведённый в текстовый формат (L2). */
export interface ProviderCompletionRequest {
  /** Имя модели upstream (например, `gemini-2.5-flash`). */
  readonly upstreamModel: string;
  /** Системная инструкция: system-сообщения DSH + DSML-инструкция. */
  readonly system: string;
  /** Транскрипт диалога в разметке `[USER]`/`[ASSISTANT]`/`[TOOL_RESULT]`. */
  readonly conversation: string;
  /** Температура из запроса DSH (если задана). */
  readonly temperature?: number | undefined;
  /** Лимит выходных токенов из запроса DSH (если задан). */
  readonly maxOutputTokens?: number | undefined;
  /** Сигнал отмены запроса (например, клиент отключился). */
  readonly signal?: AbortSignal | undefined;
}

/** Результат завершения: текст для DSML-парсера и usage. */
export interface ProviderCompletionResult {
  readonly text: string;
  readonly usage: ProviderUsage;
}

/**
 * Провайдер моделей.
 *
 * `isConfiguredAsync` не бросает: он проверяет только наличие учётных данных
 * (API-ключ, `google-auth.json`), чтобы `GET /v1/models` и диагностика могли
 * отличить «не настроен» от «настроен, но upstream ответил ошибкой».
 */
export interface ChatProvider {
  readonly id: ProviderId;
  /** Проверяет, заданы ли учётные данные провайдера. */
  isConfiguredAsync(): Promise<boolean>;
  /** Выполняет запрос к upstream и возвращает полный текст ответа. */
  completeAsync(request: ProviderCompletionRequest): Promise<ProviderCompletionResult>;
}

/** Учётные данные провайдера не заданы (нужна настройка, а не повтор). */
export class ProviderNotConfiguredError extends Error {
  public override readonly name = 'ProviderNotConfiguredError';

  public constructor(message: string) {
    super(message);
  }
}

/**
 * Upstream ответил ошибкой.
 *
 * `status` — HTTP-статус для клиента (DSH), уже смапленный с учётом политики
 * шлюза: 401 — нужна повторная авторизация, 503 — временный сбой upstream,
 * 502 — прочие ошибки.
 */
export class ProviderRequestError extends Error {
  public override readonly name = 'ProviderRequestError';

  public constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}
