/**
 * `webauth:google` — захват cookie-сессии `gemini.google.com` через CDP.
 *
 * Открывает (или переиспользует) Chrome с `--remote-debugging-port=9222`,
 * ждёт ручного входа в Google и сохраняет cookie в
 * `~/.ai-dsh-bridge/google-auth.json` (права `0600`). Access token `SNlM0e`
 * не сохраняется: он извлекается клиентом из страницы `/app` при запросе.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import CDP from 'chrome-remote-interface';
import { loadConfig } from '../config.js';
import { ChromeNotFoundError } from '../deepseek/errors.js';
import { validateGoogleSessionAsync } from '../google/gemini-web.js';
import {
  GOOGLE_AUTH_FILE_DEFAULT,
  saveGoogleAuthAsync,
  type GoogleAuth,
} from '../google/auth.js';
import { GoogleWebauthTimeoutError } from '../google/errors.js';
import {
  CHROME_PROFILE_DIR,
  findChromeExecutable,
  launchChromeAsync,
  type CdpClient,
} from './webauth.js';

/** Порт CDP по умолчанию (тот же, что у `webauth`). */
const CDP_PORT = 9222;

/** Таймаут ожидания входа — 5 минут. */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/** Интервал опроса сессии — 2 секунды. */
const DEFAULT_POLL_INTERVAL_MS = 2_000;

/** Таймаут подключения к только что запущенному Chrome. */
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;

/** Пауза между попытками подключения к CDP. */
const CONNECT_RETRY_DELAY_MS = 500;

/** Страница входа Gemini. */
const GEMINI_APP_URL = 'https://gemini.google.com/app';

/** Cookie, без которой сессия не считается захваченной. */
const REQUIRED_COOKIE = '__Secure-1PSID';

/** Зависимости `webauth:google`; все опциональны и подменяются в тестах. */
export interface GoogleWebauthDependencies {
  readonly findChrome?: () => string | undefined;
  readonly connect?: (port: number) => Promise<CdpClient>;
  readonly launchChrome?: (chromePath: string, port: number, profileDir: string) => Promise<void>;
  readonly validateSession?: (auth: GoogleAuth) => Promise<boolean>;
  readonly saveAuth?: (auth: GoogleAuth, authFile: string) => Promise<void>;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
  readonly authFile?: string;
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly port?: number;
  readonly log?: (message: string) => void;
}

/** Пауза. */
const sleepAsync = (milliseconds: number): Promise<void> =>
  new Promise<void>((resolvePromise) => {
    setTimeout(resolvePromise, milliseconds);
  });

/** Логирование в stdout (без console.* — RULES § 5). */
const defaultLog = (message: string): void => {
  process.stdout.write(`${message}\n`);
};

/** Проверяет, что значение — объект (type guard для `unknown`). */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/**
 * Приводит CDP-клиент `chrome-remote-interface` к узкому интерфейсу.
 * @param client Клиент библиотеки.
 */
const toCdpClient = (client: CDP.Client): CdpClient => {
  // @types используют generic'и devtools-protocol; наше подмножество
  // (send/close) приводится один раз на границе адаптера.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- адаптер внешней библиотеки
  const send = client.send.bind(client) as unknown as CdpClient['send'];
  return {
    send,
    close: async (): Promise<void> => {
      await client.close();
    },
  };
};

/**
 * Подключается к вкладке Gemini (или открывает новую).
 * @param port Порт CDP.
 */
const connectToGeminiPageAsync = async (port: number): Promise<CdpClient> => {
  const targets = await CDP.List({ port });
  const page =
    targets.find((target) => target.type === 'page' && target.url.includes('gemini.google.com')) ??
    targets.find((target) => target.type === 'page' && target.url.includes('google.com'));
  if (page !== undefined) {
    return toCdpClient(await CDP({ port, target: page.id }));
  }
  const created = await CDP.New({ port, url: GEMINI_APP_URL });
  return toCdpClient(await CDP({ port, target: created.id }));
};

/**
 * Ждёт, пока CDP только что запущенного Chrome станет доступен.
 * @param port Порт CDP.
 * @param timeoutMs Таймаут ожидания.
 */
const waitForCdpAsync = async (port: number, timeoutMs: number): Promise<CdpClient> => {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await connectToGeminiPageAsync(port);
    } catch (error: unknown) {
      lastError = error;
      await sleepAsync(CONNECT_RETRY_DELAY_MS);
    }
  }
  throw new GoogleWebauthTimeoutError(
    `Не удалось подключиться к Chrome (CDP :${String(port)}). ${
      lastError instanceof Error ? lastError.message : 'Проверьте --remote-debugging-port.'
    }`,
  );
};

/**
 * Читает cookie Google через CDP.
 * @param client CDP-клиент.
 * @returns Пары «имя → значение».
 */
const getGoogleCookiesAsync = async (client: CdpClient): Promise<Record<string, string>> => {
  const result = await client.send('Network.getCookies', {
    urls: [
      'https://gemini.google.com',
      'https://accounts.google.com',
      'https://www.google.com',
      'https://google.com',
    ],
  });
  if (!isRecord(result)) {
    return {};
  }
  const cookiesValue = result['cookies'];
  if (!Array.isArray(cookiesValue)) {
    return {};
  }
  const cookies: Record<string, string> = {};
  for (const cookie of cookiesValue) {
    if (!isRecord(cookie)) {
      continue;
    }
    const name = cookie['name'];
    const value = cookie['value'];
    if (typeof name === 'string' && typeof value === 'string' && value !== '') {
      cookies[name] = value;
    }
  }
  return cookies;
};

/**
 * Однократная попытка извлечь cookie-сессию Google из вкладки.
 * @param client CDP-клиент.
 * @returns Сессия или `null`, если пользователь ещё не вошёл.
 */
export const extractGoogleAuthOnceAsync = async (client: CdpClient): Promise<GoogleAuth | null> => {
  const cookies = await getGoogleCookiesAsync(client);
  if ((cookies[REQUIRED_COOKIE] ?? '') === '') {
    return null;
  }
  return { cookies, savedAt: new Date().toISOString() };
};

/**
 * Полный сценарий `pnpm webauth:google`.
 *
 * @param dependencies Зависимости (для тестов).
 * @returns Сохранённая cookie-сессия.
 * @throws ChromeNotFoundError если Chrome не найден.
 * @throws GoogleWebauthTimeoutError если вход не выполнен за 5 минут.
 */
export const runGoogleWebauthAsync = async (
  dependencies: GoogleWebauthDependencies = {},
): Promise<GoogleAuth> => {
  const log = dependencies.log ?? defaultLog;
  const sleep = dependencies.sleep ?? sleepAsync;
  const now = dependencies.now ?? Date.now;
  const findChrome = dependencies.findChrome ?? ((): string | undefined => findChromeExecutable());
  const authFile = dependencies.authFile ?? GOOGLE_AUTH_FILE_DEFAULT;
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = dependencies.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const port = dependencies.port ?? CDP_PORT;
  const validateSession =
    dependencies.validateSession ??
    ((auth: GoogleAuth): Promise<boolean> => validateGoogleSessionAsync(auth));
  const saveAuth = dependencies.saveAuth ?? saveGoogleAuthAsync;
  const launchChrome =
    dependencies.launchChrome ??
    ((chromePath: string, cdpPort: number, profileDir: string): Promise<void> =>
      launchChromeAsync(chromePath, cdpPort, profileDir, GEMINI_APP_URL));

  const chromePath = findChrome();
  if (chromePath === undefined) {
    throw new ChromeNotFoundError();
  }
  log(`[webauth:google] Chrome: ${chromePath}`);

  let client: CdpClient | undefined;
  try {
    if (dependencies.connect === undefined) {
      try {
        client = await connectToGeminiPageAsync(port);
        log('[webauth:google] Подключено к уже запущенному Chrome (CDP).');
      } catch {
        log('[webauth:google] Chrome с CDP не найден — запускаю новый экземпляр...');
        await launchChrome(chromePath, port, CHROME_PROFILE_DIR);
        client = await waitForCdpAsync(port, DEFAULT_CONNECT_TIMEOUT_MS);
      }
    } else {
      client = await dependencies.connect(port);
    }

    log('[webauth:google] Войдите в Google в открытом окне Chrome...');
    const deadline = now() + timeoutMs;
    while (now() < deadline) {
      const auth = await extractGoogleAuthOnceAsync(client);
      if (auth !== null && (await validateSession(auth))) {
        await saveAuth(auth, authFile);
        log(`Сессия Google сохранена в ${authFile}`);
        return auth;
      }
      await sleep(pollIntervalMs);
    }
    throw new GoogleWebauthTimeoutError();
  } finally {
    if (client !== undefined) {
      try {
        await client.close();
      } catch {
        // Браузер мог быть закрыт пользователем — не мешает завершению.
      }
    }
  }
};

/**
 * Определяет, запущен ли модуль напрямую (`pnpm webauth:google`).
 */
const isDirectExecution = (): boolean => {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  return pathToFileURL(resolve(entry)).href === import.meta.url;
};

/** Путь к файлу сессии по умолчанию (с учётом `GOOGLE_AUTH_FILE`). */
export const googleAuthFileFromConfig = (): string => {
  const configured = loadConfig().googleAuthFile;
  return configured === '' ? GOOGLE_AUTH_FILE_DEFAULT : configured;
};

if (isDirectExecution()) {
  try {
    await runGoogleWebauthAsync({
      authFile: googleAuthFileFromConfig(),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`\n[webauth:google] ${message}\n`);
    process.exitCode = 1;
  }
}
