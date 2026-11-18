/**
 * Ошибки Google-провайдеров.
 *
 * Отделены от ошибок DeepSeek, чтобы обработчик мог отличить «сессия Google
 * не захвачена» (нужен `pnpm webauth:google`) от «upstream ответил ошибкой».
 */

/** `google-auth.json` не найден: cookie-сессия ещё не захвачена. */
export class GoogleAuthNotFoundError extends Error {
  public override readonly name = 'GoogleAuthNotFoundError';

  public constructor(message = 'google-auth.json не найден. Запустите pnpm webauth:google.') {
    super(message);
  }
}

/** `google-auth.json` повреждён или не соответствует схеме. */
export class GoogleAuthError extends Error {
  public override readonly name = 'GoogleAuthError';

  public constructor(message: string) {
    super(message);
  }
}

/** Пользователь не вошёл в gemini.google.com за отведённое время. */
export class GoogleWebauthTimeoutError extends Error {
  public override readonly name = 'GoogleWebauthTimeoutError';

  public constructor(
    message = 'Истекло время ожидания входа (5 минут). Запустите pnpm webauth:google и войдите в gemini.google.com.',
  ) {
    super(message);
  }
}
