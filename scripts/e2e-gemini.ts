/**
 * Живой e2e Google-провайдеров.
 *
 * Запускается пользователем после настройки:
 *   pnpm e2e:gemini            # Gemini Web (нужен pnpm webauth:google)
 *   pnpm e2e:gemini --api      # Gemini API (нужен GEMINI_API_KEY)
 *
 * Проверяет: загрузку сессии/ключа, получение `SNlM0e` (web), запрос
 * `completeAsync` и текст ответа. Лог пишется в
 * `docs/captures/e2e-gemini-<YYYY-MM-DD-HH-mm>.log` (вне git, `*.log`).
 * Секреты (cookie, ключ) в лог не попадают — только их количество/наличие.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.js';
import { loadGoogleAuthAsync, type GoogleAuth } from '../src/google/auth.js';
import { createGeminiApiProvider } from '../src/google/gemini-api.js';
import { createGeminiWebProvider, resolveAccessTokenAsync } from '../src/google/gemini-web.js';
import type {
  ChatProvider,
  ProviderCompletionResult,
} from '../src/providers/types.js';
import { formatLogTimestamp } from './e2e-deepseek.js';

/** Проверочный prompt: короткий ответ легко оценить глазами. */
const PROMPT = 'Ответь одним словом: pong. Без пояснений.';

/** Режим проверки: веб-чат или официальный API. */
export type GeminiE2EMode = 'web' | 'api';

/** Зависимости e2e-скрипта; все опциональны и подменяются в unit-тестах. */
export interface GeminiE2EDependencies {
  readonly mode?: GeminiE2EMode;
  readonly loadAuth?: () => Promise<GoogleAuth>;
  readonly resolveToken?: (auth: GoogleAuth) => Promise<string>;
  readonly webProvider?: () => ChatProvider;
  readonly apiProvider?: () => ChatProvider;
  readonly now?: () => number;
  readonly date?: Date;
  readonly log?: (line: string) => void;
  readonly writeLog?: (path: string, content: string) => Promise<void>;
  readonly logDirectory?: string;
}

/** Результат успешного прогона. */
export interface GeminiE2EResult {
  readonly ok: boolean;
  readonly text: string;
  readonly elapsedMs: number;
  readonly logPath: string;
}

/**
 * Выполняет живой e2e-прогон.
 *
 * @param dependencies Зависимости (для тестов).
 * @returns Текст ответа, время и путь к логу.
 * @throws Ошибка провайдера, если upstream недоступен.
 */
export const runGeminiE2EAsync = async (
  dependencies: GeminiE2EDependencies = {},
): Promise<GeminiE2EResult> => {
  const mode = dependencies.mode ?? 'web';
  const now = dependencies.now ?? Date.now;
  const log =
    dependencies.log ??
    ((line: string): void => {
      process.stdout.write(`${line}\n`);
    });
  const writeLog =
    dependencies.writeLog ??
    ((path: string, content: string): Promise<void> => writeFile(path, content, 'utf8'));
  const logDirectory = dependencies.logDirectory ?? join(process.cwd(), 'docs', 'captures');
  const logPath = join(
    logDirectory,
    `e2e-gemini-${formatLogTimestamp(dependencies.date ?? new Date())}.log`,
  );
  const config = loadConfig();

  const lines: string[] = [];
  const record = (line: string): void => {
    lines.push(line);
    log(line);
  };
  const finish = async (): Promise<void> => {
    await mkdir(logDirectory, { recursive: true });
    await writeLog(logPath, `${lines.join('\n')}\n`);
  };

  const startedAt = now();
  try {
    let provider: ChatProvider;
    if (mode === 'api') {
      provider =
        dependencies.apiProvider?.() ??
        createGeminiApiProvider({
          apiKey: config.geminiApiKey,
          baseUrl: config.geminiApiBaseUrl,
          timeoutMs: config.geminiTimeoutMs,
        });
      record(`[1] Gemini API: ключ ${(await provider.isConfiguredAsync()) ? 'задан' : 'НЕ задан'}`);
    } else {
      const loadAuth =
        dependencies.loadAuth ??
        ((): Promise<GoogleAuth> => loadGoogleAuthAsync(config.googleAuthFile));
      const resolveToken =
        dependencies.resolveToken ??
        ((auth: GoogleAuth): Promise<string> =>
          resolveAccessTokenAsync(auth, {
            baseUrl: config.geminiWebBaseUrl,
            timeoutMs: config.geminiTimeoutMs,
          }));

      const auth = await loadAuth();
      record(
        `[1] Сессия Google: cookie=${String(Object.keys(auth.cookies).length)}, savedAt=${auth.savedAt}`,
      );
      const token = await resolveToken(auth);
      record(`[2] SNlM0e получен (длина ${String(token.length)})`);
      provider =
        dependencies.webProvider?.() ??
        createGeminiWebProvider({
          authFile: config.googleAuthFile,
          baseUrl: config.geminiWebBaseUrl,
          timeoutMs: config.geminiTimeoutMs,
        });
    }

    const result: ProviderCompletionResult = await provider.completeAsync({
      upstreamModel: mode === 'api' ? 'gemini-2.5-flash' : 'gemini-web',
      system: '',
      conversation: PROMPT,
    });
    const elapsedMs = now() - startedAt;
    record(`[3] Ответ за ${String(elapsedMs)} мс: ${result.text.slice(0, 500)}`);
    record('[4] E2E OK');
    await finish();
    return { ok: true, text: result.text, elapsedMs, logPath };
  } catch (error: unknown) {
    record(`[!] ${error instanceof Error ? error.message : String(error)}`);
    await finish();
    throw error;
  }
};

/**
 * Определяет, запущен ли модуль напрямую (`pnpm e2e:gemini`).
 */
const isDirectExecution = (): boolean => {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  return pathToFileURL(resolve(entry)).href === import.meta.url;
};

if (isDirectExecution()) {
  const mode: GeminiE2EMode = process.argv.includes('--api') ? 'api' : 'web';
  try {
    const result = await runGeminiE2EAsync({ mode });
    process.stdout.write(`\n[e2e:gemini] лог: ${result.logPath}\n`);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`\n[e2e:gemini] ${message}\n`);
    process.exitCode = 1;
  }
}
