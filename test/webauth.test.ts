/**
 * Тесты webauth: извлечение сессии из mock-CDP, сохранение auth.json,
 * сценарии ChromeNotFound/timeout.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  extractAuthOnceAsync,
  runWebauthAsync,
  saveAuthAsync,
  type CdpClient,
} from '../src/auth/webauth.js';
import type { Auth } from '../src/config.js';
import { ChromeNotFoundError, WebauthTimeoutError } from '../src/deepseek/errors.js';

/** Опции mock-CDP. */
interface MockCdpOptions {
  readonly cookies?: readonly { readonly name: string; readonly value: string }[];
  readonly userToken?: unknown;
  readonly apiToken?: unknown;
}

/**
 * Создаёт mock CDP-клиента с заданными cookie/localStorage.
 * @param options Данные «вкладки».
 */
const createMockCdp = (options: MockCdpOptions): CdpClient => ({
  send: async (method, params) => {
    if (method === 'Network.getCookies') {
      return { cookies: options.cookies ?? [] };
    }
    if (method === 'Runtime.evaluate') {
      const expression = params?.['expression'];
      const source = typeof expression === 'string' ? expression : '';
      const outcome = source.includes('userToken')
        ? (options.userToken ?? null)
        : (options.apiToken ?? null);
      return { result: { value: outcome } };
    }
    return {};
  },
  close: async () => {
    // Закрытие mock-клиента ничего не делает.
  },
});

/** Сессия из mock-вкладки. */
const SESSION_COOKIES = [
  { name: 'ds_session_id', value: 'session-cookie-value' },
  { name: 'aws-waf-token', value: 'waf-cookie-value' },
];

/** Немедленный sleep. */
const noSleep = (): Promise<void> => Promise.resolve();

describe('extractAuthOnceAsync', () => {
  it('извлекает ds_session_id, aws-waf-token и Bearer из localStorage', async () => {
    const client = createMockCdp({
      cookies: SESSION_COOKIES,
      userToken: 'bearer-token-from-localstorage',
    });
    const auth = await extractAuthOnceAsync(client);
    expect(auth).not.toBeNull();
    expect(auth?.dsSessionId).toBe('session-cookie-value');
    expect(auth?.bearerToken).toBe('bearer-token-from-localstorage');
    expect(auth?.awsWafToken).toBe('waf-cookie-value');
    expect(Number.isNaN(Date.parse(auth?.savedAt ?? ''))).toBe(false);
  });

  it('берёт Bearer из users/current, если userToken пуст', async () => {
    const client = createMockCdp({
      cookies: SESSION_COOKIES,
      userToken: null,
      apiToken: 'bearer-from-users-current',
    });
    const auth = await extractAuthOnceAsync(client);
    expect(auth?.bearerToken).toBe('bearer-from-users-current');
  });

  it('возвращает null, пока нет cookie сессии', async () => {
    const client = createMockCdp({
      cookies: [],
      userToken: 'some-long-token',
    });
    await expect(extractAuthOnceAsync(client)).resolves.toBeNull();
  });

  it('возвращает null, пока нет токена', async () => {
    const client = createMockCdp({ cookies: SESSION_COOKIES, userToken: null, apiToken: null });
    await expect(extractAuthOnceAsync(client)).resolves.toBeNull();
  });

  it('сохраняет auth.json с правами и валидным JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ai-dsh-bridge-auth-'));
    const authFile = join(dir, 'auth.json');
    const auth: Auth = {
      dsSessionId: 'session',
      bearerToken: 'token',
      savedAt: '2026-10-19T00:00:00.000Z',
    };
    try {
      await saveAuthAsync(auth, authFile);
      const parsed: unknown = JSON.parse(await readFile(authFile, 'utf8')) as unknown;
      expect(parsed).toEqual(auth);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('runWebauthAsync', () => {
  it('сохраняет сессию и печатает сообщение (mock CDP)', async () => {
    const logs: string[] = [];
    const saved: Auth[] = [];
    const client = createMockCdp({
      cookies: SESSION_COOKIES,
      userToken: 'bearer-token-from-localstorage',
    });
    const auth = await runWebauthAsync({
      findChrome: () => 'C:\\fake\\chrome.exe',
      connect: async () => client,
      validateSession: async () => true,
      saveAuth: async (candidate) => {
        saved.push(candidate);
      },
      sleep: noSleep,
      authFile: 'C:\\fake\\auth.json',
      timeoutMs: 1_000,
      pollIntervalMs: 1,
      log: (message) => logs.push(message),
    });

    expect(auth.dsSessionId).toBe('session-cookie-value');
    expect(saved).toHaveLength(1);
    expect(logs.some((line) => line.includes('Сессия сохранена'))).toBe(true);
  });

  it('бросает ChromeNotFoundError, если Chrome не найден', async () => {
    await expect(
      runWebauthAsync({ findChrome: () => undefined, log: () => {} }),
    ).rejects.toBeInstanceOf(ChromeNotFoundError);
  });

  it('бросает WebauthTimeoutError, если пользователь не вошёл', async () => {
    const client = createMockCdp({ cookies: [] });
    let clock = 0;
    await expect(
      runWebauthAsync({
        findChrome: () => 'C:\\fake\\chrome.exe',
        connect: async () => client,
        validateSession: async () => false,
        sleep: noSleep,
        authFile: 'C:\\fake\\auth.json',
        timeoutMs: 100,
        pollIntervalMs: 1,
        now: () => {
          clock += 10_000;
          return clock;
        },
        log: () => {},
      }),
    ).rejects.toBeInstanceOf(WebauthTimeoutError);
  });
});
