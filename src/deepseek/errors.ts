/**
 * Ошибки слоёв L3 (DeepSeek Client) и аутентификации.
 *
 * Все ошибки — наследники `Error` с машиночитаемым `name`, чтобы вызывающий
 * код мог различать сетевые сбои, истёкшую сессию и нерешённый PoW
 * (RULES § 1: типизированные границы).
 */

/** Сессия DeepSeek истекла или невалидна: нужно повторить `pnpm webauth`. */
export class AuthExpiredError extends Error {
  public override readonly name = 'AuthExpiredError';

  public constructor(message = 'Сессия DeepSeek истекла. Запустите pnpm webauth.') {
    super(message);
  }
}

/** Файл `auth.json` не найден: сессия ещё не захвачена. */
export class AuthNotFoundError extends Error {
  public override readonly name = 'AuthNotFoundError';

  public constructor(message = 'auth.json не найден. Запустите pnpm webauth.') {
    super(message);
  }
}

/** PoW-решатель не нашёл `answer` в пределах `difficulty`. */
export class PowNotSolvedError extends Error {
  public override readonly name = 'PowNotSolvedError';

  public constructor(message = 'PoW не решён в пределах difficulty.') {
    super(message);
  }
}

/** DeepSeek не обработал загруженный файл за отведённое время. */
export class FileProcessingTimeoutError extends Error {
  public override readonly name = 'FileProcessingTimeoutError';

  public constructor(message = 'DeepSeek не обработал файл за отведённое время.') {
    super(message);
  }
}

/** DeepSeek вернул бизнес-ошибку (`code !== 0`) в теле ответа. */
export class DeepSeekApiError extends Error {
  public override readonly name = 'DeepSeekApiError';

  public constructor(
    public readonly code: number,
    public readonly apiMessage: string,
  ) {
    super(`DeepSeek API error ${code}: ${apiMessage}`);
  }
}

/** Диагностика не-SSE ответа DeepSeek (для отладки живого e2e). */
export interface NonSseResponseDiagnostics {
  /** HTTP-статус. */
  readonly status: number;
  /** `Content-Type` ответа (или `null`, если заголовка нет). */
  readonly contentType: string | null;
  /** Первые 500 символов тела либо `<REDACTED>` при подозрении на секрет. */
  readonly bodyPreview: string;
  /** URL запроса completion. */
  readonly requestUrl: string;
  /** Заголовки запроса без `authorization`/`cookie`/`x-ds-pow-response`. */
  readonly requestHeaders: Readonly<Record<string, string>>;
}

/**
 * DeepSeek ответил не SSE-потоком (например, JSON-ошибкой с HTTP 200).
 * Содержит диагностику: статус, Content-Type, превью тела, URL и заголовки
 * запроса (без секретов).
 */
export class DeepSeekNonSseError extends Error {
  public override readonly name = 'DeepSeekNonSseError';
  public readonly diagnostics: NonSseResponseDiagnostics;

  public constructor(diagnostics: NonSseResponseDiagnostics) {
    super(
      `DeepSeek вернул не-SSE ответ (status=${String(diagnostics.status)}, contentType=${diagnostics.contentType ?? 'unknown'})`,
    );
    this.diagnostics = diagnostics;
  }
}

/** Google Chrome не найден в стандартных путях. */
export class ChromeNotFoundError extends Error {
  public override readonly name = 'ChromeNotFoundError';

  public constructor(message = 'Google Chrome не найден. Установите Google Chrome.') {
    super(message);
  }
}

/** Не удалось извлечь сессию (cookie/токен) из браузера. */
export class TokenExtractionError extends Error {
  public override readonly name = 'TokenExtractionError';

  public constructor(message = 'Не удалось извлечь токен DeepSeek. Войдите в chat.deepseek.com и повторите pnpm webauth.') {
    super(message);
  }
}

/** Пользователь не вошёл в DeepSeek за отведённое время. */
export class WebauthTimeoutError extends Error {
  public override readonly name = 'WebauthTimeoutError';

  public constructor(message = 'Истекло время ожидания входа (5 минут). Запустите pnpm webauth и войдите в chat.deepseek.com.') {
    super(message);
  }
}

/** Операция отменена через AbortSignal. */
export class AbortError extends Error {
  public override readonly name = 'AbortError';

  public constructor(message = 'Операция отменена.') {
    super(message);
  }
}
