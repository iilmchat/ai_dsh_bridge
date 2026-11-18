/**
 * Сессия Google для веб-чата `gemini.google.com`.
 *
 * Хранится вне репозитория в `google-auth.json` (права `0600`). В отличие от
 * DeepSeek, веб-чату Google нужны только cookie домена `google.com`; access
 * token `SNlM0e` не сохраняется, а извлекается из страницы `/app` при первом
 * запросе и кэшируется в памяти провайдера — токен меняется чаще cookie.
 */
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { GoogleAuthError, GoogleAuthNotFoundError } from './errors.js';

/** Путь к `google-auth.json` по умолчанию (вне репозитория). */
export const GOOGLE_AUTH_FILE_DEFAULT = join(homedir(), '.ai-dsh-bridge', 'google-auth.json');

/** Имя cookie, без которой веб-чат не авторизует запрос. */
export const REQUIRED_GOOGLE_COOKIE = '__Secure-1PSID';

/**
 * Схема `google-auth.json`.
 *
 * `z.strictObject`: лишние поля означают рассинхрон версий (RULES § 1.5).
 */
export const GoogleAuthFileSchema = z.strictObject({
  cookies: z
    .record(z.string(), z.string().min(1))
    .refine((cookies) => (cookies[REQUIRED_GOOGLE_COOKIE] ?? '') !== '', {
      message: `cookies должны содержать ${REQUIRED_GOOGLE_COOKIE}`,
    }),
  savedAt: z.string().min(1),
});

/** Захваченная cookie-сессия Google. */
export type GoogleAuth = z.infer<typeof GoogleAuthFileSchema>;

/** Проверяет, что значение — объект (type guard для `unknown`). */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** Проверяет, что ошибка — Node-ошибка файловой системы с кодом. */
const hasErrorCode = (value: unknown): value is { readonly code: string } =>
  isRecord(value) && typeof value['code'] === 'string';

/**
 * Загружает и валидирует `google-auth.json`.
 *
 * @param authFile Путь к файлу (по умолчанию `GOOGLE_AUTH_FILE` из окружения).
 * @returns Cookie-сессия Google.
 * @throws GoogleAuthNotFoundError если файла нет.
 * @throws GoogleAuthError если файл повреждён или не проходит схему.
 */
export const loadGoogleAuthAsync = async (
  authFile: string = GOOGLE_AUTH_FILE_DEFAULT,
): Promise<GoogleAuth> => {
  let raw: string;
  try {
    raw = await readFile(authFile, 'utf8');
  } catch (error: unknown) {
    if (hasErrorCode(error) && error.code === 'ENOENT') {
      throw new GoogleAuthNotFoundError(
        `google-auth.json не найден (${authFile}). Запустите pnpm webauth:google.`,
      );
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new GoogleAuthError(
      `google-auth.json повреждён: ${authFile}. Повторите pnpm webauth:google.`,
    );
  }

  const result = GoogleAuthFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new GoogleAuthError(
      `google-auth.json не соответствует схеме (${authFile}). Повторите pnpm webauth:google.`,
    );
  }
  return result.data;
};

/**
 * Сохраняет cookie-сессию в `google-auth.json` (права `0600`).
 * @param auth Сессия.
 * @param authFile Путь к файлу.
 */
export const saveGoogleAuthAsync = async (
  auth: GoogleAuth,
  authFile: string = GOOGLE_AUTH_FILE_DEFAULT,
): Promise<void> => {
  await mkdir(dirname(authFile), { recursive: true });
  await writeFile(authFile, `${JSON.stringify(auth, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  try {
    await chmod(authFile, 0o600);
  } catch {
    // Windows: chmod не управляет ACL — файл всё равно вне репозитория.
  }
};

/**
 * Собирает значение заголовка `Cookie` из сохранённых пар.
 * @param cookies Cookie-сессия Google.
 * @returns Строка вида `name=value; name2=value2`.
 */
export const cookieHeaderValue = (cookies: Readonly<Record<string, string>>): string =>
  Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
