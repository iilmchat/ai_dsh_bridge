/**
 * Тесты `webauth:google`: извлечение cookie из mock-CDP, сохранение сессии,
 * таймаут и отсутствие Chrome. Внешние вызовы замоканы.
 */
import { describe, expect, it } from 'vitest';
import {
  extractGoogleAuthOnceAsync,
  runGoogleWebauthAsync,
  type GoogleWebauthDependencies,
} from '../src/auth/webauth-google.js';
import { ChromeNotFoundError } from '../src/deepseek/errors.js';
import type { GoogleAuth } from '../src/google/auth.js';
import { GoogleWebauthTimeoutError } from '../src/google/errors.js';
import type { CdpClient } from '../src/auth/webauth.js';

/** Cookie, достаточные для сессии Gemini. */
const GOOGLE_COOKIES = [
  { name: '__Secure-1PSID', value: 'psid-value' },
  { name: '__Secure-1PSIDTS', value: 'psidts-value' },
  { name: 'NID', value: 'nid-value' },
];

/**
 * Создаёт mock CDP-клиента с заданными cookie.
 * @param cookies Cookie вкладки.
 */
const createMockCdp = (cookies: readonly { readonly name: string; readonly value: string }[]): CdpClient => ({
  send: async (method) =>
    method === 'Network.getCookies' ? { cookies } : {},
  close: async () => {
    // Закрытие mock-клиента ничего не делает.
  },
});

/** Немедленный sleep. */
const noSleep = (): Promise<void> => Promise.resolve();

/**
 * Базовые зависимости webauth: Chrome найден, CDP замокан.
 * @param overrides Переопределения.
 */
const baseDependencies = (
  overrides: GoogleWebauthDependencies = {},
): GoogleWebauthDependencies => ({
  findChrome: () => 'C:\\fake\\chrome.exe',
  connect: async () => createMockCdp(GOOGLE_COOKIES),
  validateSession: async () => true,
  saveAuth: async () => {
    // Сохранение подменяется в тестах, где оно проверяется.
  },
  sleep: noSleep,
  authFile: 'unused-google-auth.json',
  log: () => {
    // Вывод в тестах не нужен.
  },
  ...overrides,
});

describe('extractGoogleAuthOnceAsync', () => {
  it('собирает cookie Google, если есть __Secure-1PSID', async () => {
    const auth = await extractGoogleAuthOnceAsync(createMockCdp(GOOGLE_COOKIES));

    expect(auth).not.toBeNull();
    expect(auth?.cookies['__Secure-1PSID']).toBe('psid-value');
    expect(auth?.cookies['NID']).toBe('nid-value');
  });

  it('возвращает null, пока пользователь не вошёл', async () => {
    const auth = await extractGoogleAuthOnceAsync(createMockCdp([{ name: 'NID', value: 'x' }]));
    expect(auth).toBeNull();
  });
});

describe('runGoogleWebauthAsync', () => {
  it('сохраняет сессию после успешной проверки', async () => {
    let saved: GoogleAuth | undefined;
    const auth = await runGoogleWebauthAsync(
      baseDependencies({
        saveAuth: async (value) => {
          saved = value;
        },
      }),
    );

    expect(auth.cookies['__Secure-1PSID']).toBe('psid-value');
    expect(saved?.cookies['__Secure-1PSIDTS']).toBe('psidts-value');
  });

  it('бросает GoogleWebauthTimeoutError, если вход не выполнен', async () => {
    let clock = 0;
    const dependencies = baseDependencies({
      validateSession: async () => false,
      timeoutMs: 2_500,
      pollIntervalMs: 1_000,
      now: () => {
        const value = clock;
        clock += 1_000;
        return value;
      },
    });

    await expect(runGoogleWebauthAsync(dependencies)).rejects.toBeInstanceOf(
      GoogleWebauthTimeoutError,
    );
  });

  it('бросает ChromeNotFoundError без Chrome', async () => {
    await expect(
      runGoogleWebauthAsync(baseDependencies({ findChrome: () => undefined })),
    ).rejects.toBeInstanceOf(ChromeNotFoundError);
  });
});
