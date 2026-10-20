/**
 * Конфигурация AI DSH Bridge.
 *
 * Все значения приходят из переменных окружения и валидируются Zod-схемой
 * на границе процесса (RULES § 1: Zod на всех границах ввода).
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { AuthNotFoundError, TokenExtractionError } from './deepseek/errors.js';

/** Каталог пользовательских файлов шлюза по умолчанию. */
const DEFAULT_HOME_DIR = join(homedir(), '.ai-dsh-bridge');

/** Уровни логирования, поддерживаемые pino внутри Fastify. */
const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

/** Тип уровня логирования. */
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * Схема переменных окружения.
 *
 * `DEBUG` намеренно строковый enum: в `.env` и в процессе окружения значения
 * всегда строки. `PORT` приводится к числу через `z.coerce`.
 */
const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3456),
  DEBUG: z.enum(['0', '1']).default('0'),
  DEBUG_DIR: z.string().min(1).default(join(DEFAULT_HOME_DIR, 'debug')),
  DEEPSEEK_BASE_URL: z.url().default('https://chat.deepseek.com'),
  AUTH_FILE: z.string().min(1).default(join(DEFAULT_HOME_DIR, 'auth.json')),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
});

/** Валидированная конфигурация шлюза. */
export interface BridgeConfig {
  /** Порт HTTP-сервера (loopback). */
  readonly port: number;
  /** Режим отладки: включается только значением `DEBUG=1`. */
  readonly debug: boolean;
  /** Каталог для «сырых» ответов DeepSeek (вне git). */
  readonly debugDir: string;
  /** Базовый URL `chat.deepseek.com`. */
  readonly baseUrl: string;
  /** Путь к `auth.json` с захваченной сессией. */
  readonly authFile: string;
  /** Уровень логирования Fastify/pino. */
  readonly logLevel: LogLevel;
}

/**
 * Раскрывает `~` в начале пути и делает относительные пути абсолютными.
 * @param value Путь из переменной окружения.
 * @returns Абсолютный путь.
 */
const resolvePath = (value: string): string => {
  if (value === '~') {
    return homedir();
  }
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return join(homedir(), value.slice(2));
  }
  return isAbsolute(value) ? value : join(process.cwd(), value);
};

/**
 * Читает и валидирует конфигурацию из окружения.
 * @param source Источник переменных окружения (по умолчанию `process.env`).
 * @returns Валидированная конфигурация.
 * @throws ZodError, если конфигурация некорректна.
 */
export const loadConfig = (source: NodeJS.ProcessEnv = process.env): BridgeConfig => {
  const env = EnvSchema.parse(source);
  return {
    port: env.PORT,
    debug: env.DEBUG === '1',
    debugDir: resolvePath(env.DEBUG_DIR),
    baseUrl: env.DEEPSEEK_BASE_URL,
    authFile: resolvePath(env.AUTH_FILE),
    logLevel: env.LOG_LEVEL,
  };
};

/**
 * Схема `auth.json`, создаваемого `pnpm webauth`.
 * `awsWafToken` опционален: WAF-заголовки на первом этапе не обязательны.
 */
const AuthFileSchema = z.object({
  dsSessionId: z.string().min(1),
  bearerToken: z.string().min(1),
  awsWafToken: z.string().min(1).optional(),
  savedAt: z.string().min(1),
});

/** Захваченная сессия DeepSeek (файл `~/.ai-dsh-bridge/auth.json`). */
export interface Auth {
  /** Значение cookie `ds_session_id`. */
  readonly dsSessionId: string;
  /** Bearer-токен из `Authorization`. */
  readonly bearerToken: string;
  /** Значение cookie `aws-waf-token` (если было). */
  readonly awsWafToken?: string | undefined;
  /** ISO-время сохранения. */
  readonly savedAt: string;
}

/**
 * Проверяет, что значение — объект (type guard для `unknown`).
 * @param value Проверяемое значение.
 */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/**
 * Проверяет, что значение — объект со строковым полем `code` (Node-ошибки).
 * @param value Проверяемое значение.
 */
const hasErrorCode = (value: unknown): value is { readonly code: string } =>
  isRecord(value) && typeof value['code'] === 'string';

/**
 * Загружает и валидирует `auth.json` (сессию, захваченную `webauth`).
 *
 * @param authFile Путь к файлу (по умолчанию `AUTH_FILE` из окружения).
 * @returns Валидированная сессия.
 * @throws AuthNotFoundError если файла нет — нужно запустить `pnpm webauth`.
 * @throws TokenExtractionError если файл повреждён или не проходит схему.
 */
export const loadAuthAsync = async (
  authFile: string = loadConfig().authFile,
): Promise<Auth> => {
  let raw: string;
  try {
    raw = await readFile(authFile, 'utf8');
  } catch (error: unknown) {
    if (hasErrorCode(error) && error.code === 'ENOENT') {
      throw new AuthNotFoundError(
        `auth.json не найден (${authFile}). Запустите pnpm webauth.`,
      );
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new TokenExtractionError(`auth.json повреждён: ${authFile}. Повторите pnpm webauth.`);
  }

  const result = AuthFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new TokenExtractionError(
      `auth.json не соответствует схеме (${authFile}). Повторите pnpm webauth.`,
    );
  }
  return result.data;
};
