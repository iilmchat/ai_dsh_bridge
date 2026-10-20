/**
 * webauth — одноразовый захват сессии DeepSeek через Chrome DevTools Protocol.
 *
 * Запускает (или переиспользует) Chrome с `--remote-debugging-port=9222`,
 * открывает `https://chat.deepseek.com`, ждёт ручного входа и сохраняет
 * `~/.ai-dsh-bridge/auth.json` (DESIGN § 3.1).
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import CDP from 'chrome-remote-interface';
import { loadConfig, type Auth } from '../config.js';
import { validateSessionAsync } from '../deepseek/client.js';
import { ChromeNotFoundError, TokenExtractionError, WebauthTimeoutError } from '../deepseek/errors.js';

/** Порт CDP по умолчанию. */
export const CDP_PORT = 9222;

/** Порт по умолчанию для dependency injection в тестах. */
export const DEFAULT_CDP_PORT = CDP_PORT;

/** Отдельный профиль Chrome для webauth (вне репозитория). */
export const CHROME_PROFILE_DIR = join(homedir(), '.ai-dsh-bridge', 'chrome-profile');

/** Таймаут ожидания входа — 5 минут. */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/** Интервал опроса сессии — 2 секунды. */
const DEFAULT_POLL_INTERVAL_MS = 2_000;

/** Таймаут подключения к только что запущенному Chrome. */
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;

/** Пауза между попытками подключения к CDP. */
const CONNECT_RETRY_DELAY_MS = 500;

/** Минимальная длина валидного Bearer-токена. */
const MIN_TOKEN_LENGTH = 10;

/** Узкий интерфейс CDP-клиента (удобно мокать в тестах). */
export interface CdpClient {
  readonly send: (method: string, params?: Readonly<Record<string, unknown>>) => Promise<unknown>;
  readonly close: () => Promise<void>;
}

/** Зависимости webauth; все опциональны и подменяются в тестах. */
export interface WebauthDependencies {
  readonly findChrome?: () => string | undefined;
  readonly connect?: (port: number) => Promise<CdpClient>;
  readonly launchChrome?: (chromePath: string, port: number, profileDir: string) => Promise<void>;
  readonly validateSession?: (auth: Auth) => Promise<boolean>;
  readonly saveAuth?: (auth: Auth, authFile: string) => Promise<void>;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
  readonly authFile?: string;
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly port?: number;
  readonly log?: (message: string) => void;
}

/** Cookie из CDP. */
interface CdpCookie {
  readonly name: string;
  readonly value: string;
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

/**
 * Сканирует `localStorage` страницы на Bearer-токен (`userToken`).
 * Выполняется в контексте страницы через `Runtime.evaluate`.
 */
const USER_TOKEN_EXPRESSION = `(() => {
  try {
    const raw = localStorage.getItem('userToken');
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'string' && parsed.length > 10) return parsed;
      if (parsed && typeof parsed === 'object') {
        for (const key of ['token', 'value', 'accessToken', 'access_token']) {
          const value = parsed[key];
          if (typeof value === 'string' && value.length > 10) return value;
        }
      }
    } catch {
      if (raw.length > 10) return raw;
    }
    return null;
  } catch {
    return null;
  }
})()`;

/**
 * Fallback: получает токен из `GET /api/v0/users/current` внутри страницы
 * (использует cookie браузера автоматически).
 */
const USERS_CURRENT_TOKEN_EXPRESSION = `(async () => {
  try {
    const response = await fetch('/api/v0/users/current', {
      credentials: 'include',
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return null;
    const body = await response.json();
    const token = body && body.data && body.data.biz_data ? body.data.biz_data.token : null;
    return typeof token === 'string' && token.length > 10 ? token : null;
  } catch {
    return null;
  }
})()`;

/**
 * Ищет исполняемый файл Chrome в стандартных путях.
 * @param platform Платформа (по умолчанию текущая).
 * @returns Путь к Chrome или `undefined`.
 */
export const findChromeExecutable = (
  platform: NodeJS.Platform = process.platform,
): string | undefined => {
  const override = process.env['CHROME_PATH'];
  if (override !== undefined && override.length > 0 && existsSync(override)) {
    return override;
  }

  const candidates: (string | undefined)[] = [];
  if (platform === 'win32') {
    candidates.push(
      process.env['PROGRAMFILES'] === undefined
        ? undefined
        : join(process.env['PROGRAMFILES'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
      process.env['PROGRAMFILES(X86)'] === undefined
        ? undefined
        : join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
      process.env['LOCALAPPDATA'] === undefined
        ? undefined
        : join(process.env['LOCALAPPDATA'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    );
  } else if (platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  } else {
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
    );
  }
  return candidates.find((candidate): candidate is string =>
    candidate === undefined ? false : existsSync(candidate),
  );
};

/**
 * Запускает Chrome с включённым CDP-портом и отдельным профилем.
 * @param chromePath Путь к chrome.exe.
 * @param port Порт CDP.
 * @param profileDir Каталог профиля.
 */
export const launchChromeAsync = async (
  chromePath: string,
  port: number,
  profileDir: string,
): Promise<void> => {
  await mkdir(profileDir, { recursive: true });
  const child = spawn(
    chromePath,
    [
      `--remote-debugging-port=${String(port)}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      'https://chat.deepseek.com',
    ],
    { detached: true, stdio: 'ignore' },
  );
  child.unref();
};

/**
 * Проверяет, что значение — объект (type guard для `unknown`).
 * @param value Проверяемое значение.
 */
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
 * Подключается к странице chat.deepseek.com (или создаёт вкладку).
 * @param port Порт CDP.
 */
const connectToPageAsync = async (port: number): Promise<CdpClient> => {
  const targets = await CDP.List({ port });
  const page =
    targets.find((target) => target.type === 'page' && target.url.includes('deepseek.com')) ??
    targets.find((target) => target.type === 'page');
  if (page !== undefined) {
    return toCdpClient(await CDP({ port, target: page.id }));
  }
  const created = await CDP.New({ port, url: 'https://chat.deepseek.com' });
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
      return await connectToPageAsync(port);
    } catch (error: unknown) {
      lastError = error;
      await sleepAsync(CONNECT_RETRY_DELAY_MS);
    }
  }
  throw new TokenExtractionError(
    `Не удалось подключиться к Chrome (CDP :${String(port)}). ${
      lastError instanceof Error ? lastError.message : 'Проверьте --remote-debugging-port.'
    }`,
  );
};

/**
 * Читает cookie DeepSeek через CDP.
 * @param client CDP-клиент.
 */
const getCookiesAsync = async (client: CdpClient): Promise<readonly CdpCookie[]> => {
  const result = await client.send('Network.getCookies', {
    urls: ['https://chat.deepseek.com', 'https://deepseek.com'],
  });
  if (!isRecord(result)) {
    return [];
  }
  const cookiesValue = (result as { readonly cookies?: unknown }).cookies;
  if (!Array.isArray(cookiesValue)) {
    return [];
  }
  const cookies: unknown[] = cookiesValue;
  return cookies.flatMap((cookie): CdpCookie[] => {
    if (!isRecord(cookie)) {
      return [];
    }
    const name = cookie['name'];
    const value = cookie['value'];
    return typeof name === 'string' && typeof value === 'string' ? [{ name, value }] : [];
  });
};

/**
 * Выполняет выражение в контексте страницы.
 * @param client CDP-клиент.
 * @param expression JS-выражение.
 * @param awaitPromise Ждать ли Promise-результат.
 * @returns Значение `result.value`.
 */
const evaluateAsync = async (
  client: CdpClient,
  expression: string,
  awaitPromise = false,
): Promise<unknown> => {
  const result = await client.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise,
  });
  if (!isRecord(result)) {
    return undefined;
  }
  const remote = result['result'];
  if (!isRecord(remote)) {
    return undefined;
  }
  return remote['value'];
};

/**
 * Однократная попытка извлечь сессию из открытой страницы.
 *
 * Секреты не логируются: возвращается только структура, пригодная для
 * сохранения в `auth.json`.
 *
 * @param client CDP-клиент.
 * @returns Сессия или `null`, если пользователь ещё не вошёл.
 */
export const extractAuthOnceAsync = async (client: CdpClient): Promise<Auth | null> => {
  const cookies = await getCookiesAsync(client);
  const dsSessionId = cookies.find((cookie) => cookie.name === 'ds_session_id')?.value;
  const awsWafToken = cookies.find((cookie) => cookie.name === 'aws-waf-token')?.value;

  let bearerToken: unknown = await evaluateAsync(client, USER_TOKEN_EXPRESSION);
  if (typeof bearerToken !== 'string' || bearerToken.length < MIN_TOKEN_LENGTH) {
    bearerToken = await evaluateAsync(client, USERS_CURRENT_TOKEN_EXPRESSION, true);
  }
  if (
    dsSessionId === undefined ||
    typeof bearerToken !== 'string' ||
    bearerToken.length < MIN_TOKEN_LENGTH
  ) {
    return null;
  }

  return {
    dsSessionId,
    bearerToken,
    ...(awsWafToken === undefined ? {} : { awsWafToken }),
    savedAt: new Date().toISOString(),
  };
};

/**
 * Сохраняет сессию в `auth.json` (права 0600, каталог создаётся).
 * @param auth Сессия.
 * @param authFile Путь к файлу.
 */
export const saveAuthAsync = async (auth: Auth, authFile: string): Promise<void> => {
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
 * Полный сценарий `pnpm webauth`: подключение/запуск Chrome, ожидание входа,
 * сохранение `auth.json`.
 *
 * @param dependencies Зависимости (для тестов).
 * @returns Сохранённая сессия.
 * @throws ChromeNotFoundError если Chrome не найден.
 * @throws WebauthTimeoutError если вход не выполнен за 5 минут.
 * @throws TokenExtractionError если подключиться к CDP не удалось.
 */
export const runWebauthAsync = async (
  dependencies: WebauthDependencies = {},
): Promise<Auth> => {
  const log = dependencies.log ?? defaultLog;
  const sleep = dependencies.sleep ?? sleepAsync;
  const now = dependencies.now ?? Date.now;
  const findChrome = dependencies.findChrome ?? ((): string | undefined => findChromeExecutable());
  const launchChrome = dependencies.launchChrome ?? launchChromeAsync;
  const authFile = dependencies.authFile ?? loadConfig().authFile;
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = dependencies.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const port = dependencies.port ?? CDP_PORT;
  const validateSession =
    dependencies.validateSession ??
    (async (auth: Auth): Promise<boolean> => validateSessionAsync(auth));
  const saveAuth = dependencies.saveAuth ?? saveAuthAsync;

  const chromePath = findChrome();
  if (chromePath === undefined) {
    throw new ChromeNotFoundError();
  }
  log(`[webauth] Chrome: ${chromePath}`);

  let client: CdpClient | undefined;
  try {
    if (dependencies.connect === undefined) {
      try {
        client = await connectToPageAsync(port);
        log('[webauth] Подключено к уже запущенному Chrome (CDP).');
      } catch {
        log('[webauth] Chrome с CDP не найден — запускаю новый экземпляр...');
        await launchChrome(chromePath, port, CHROME_PROFILE_DIR);
        client = await waitForCdpAsync(port, DEFAULT_CONNECT_TIMEOUT_MS);
      }
    } else {
      client = await dependencies.connect(port);
    }

    log('[webauth] Войдите в chat.deepseek.com в открытом окне Chrome...');
    const deadline = now() + timeoutMs;
    while (now() < deadline) {
      const auth = await extractAuthOnceAsync(client);
      if (auth !== null && (await validateSession(auth))) {
        await saveAuth(auth, authFile);
        log(`Сессия сохранена в ${authFile}`);
        return auth;
      }
      await sleep(pollIntervalMs);
    }
    throw new WebauthTimeoutError();
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
 * Определяет, запущен ли модуль напрямую (`pnpm webauth`), а не импортирован.
 */
const isDirectExecution = (): boolean => {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  return pathToFileURL(resolve(entry)).href === import.meta.url;
};

if (isDirectExecution()) {
  try {
    await runWebauthAsync();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`\n[webauth] ${message}\n`);
    process.exitCode = 1;
  }
}
