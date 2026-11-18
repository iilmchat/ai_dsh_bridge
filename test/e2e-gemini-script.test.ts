/**
 * Unit-тесты `e2e:gemini`: шаги прогона, лог без секретов, ошибки
 * провайдера. Живой запрос здесь не выполняется — только mock.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GoogleAuth } from '../src/google/auth.js';
import {
  ProviderNotConfiguredError,
  ProviderRequestError,
  type ChatProvider,
} from '../src/providers/types.js';
import { runGeminiE2EAsync } from '../scripts/e2e-gemini.js';

/** Cookie-сессия для тестов (значение не должно попасть в лог). */
const TEST_AUTH: GoogleAuth = {
  cookies: { '__Secure-1PSID': 'secret-cookie-value' },
  savedAt: '2026-11-18T00:00:00.000Z',
};

/** Каталог логов вне репозитория. */
const TEST_LOG_DIR = join(tmpdir(), 'ai-dsh-bridge-e2e-gemini-test');

/**
 * Провайдер, возвращающий заданный текст.
 * @param text Текст ответа.
 */
const providerReturning = (text: string): ChatProvider => ({
  id: 'google-gemini-web',
  isConfiguredAsync: async () => true,
  completeAsync: async () => ({ text, usage: { promptTokens: 0, completionTokens: 0 } }),
});

/**
 * Провайдер, завершающийся ошибкой.
 * @param error Ошибка.
 */
const providerFailing = (error: Error): ChatProvider => ({
  id: 'google-gemini-api',
  isConfiguredAsync: async () => false,
  completeAsync: async () => {
    throw error;
  },
});

describe('runGeminiE2EAsync', () => {
  it('web: проходит шаги и пишет лог без секретов', async () => {
    let written = '';
    const result = await runGeminiE2EAsync({
      mode: 'web',
      loadAuth: async () => TEST_AUTH,
      resolveToken: async () => 'AT-TOKEN',
      webProvider: () => providerReturning('pong'),
      now: () => 1_000,
      date: new Date('2026-11-18T10:00:00.000Z'),
      log: () => {
        // Вывод в тестах не нужен.
      },
      writeLog: async (_path, content) => {
        written = content;
      },
      logDirectory: TEST_LOG_DIR,
    });

    expect(result.ok).toBe(true);
    expect(result.text).toBe('pong');
    expect(result.logPath).toContain('e2e-gemini-');
    expect(written).toContain('[4] E2E OK');
    expect(written).not.toContain('secret-cookie-value');
  });

  it('api: использует переданный провайдер и фиксирует успех', async () => {
    let written = '';
    const result = await runGeminiE2EAsync({
      mode: 'api',
      apiProvider: () => providerReturning('pong'),
      now: () => 5_000,
      log: () => {
        // Вывод в тестах не нужен.
      },
      writeLog: async (_path, content) => {
        written = content;
      },
      logDirectory: TEST_LOG_DIR,
    });

    expect(result.text).toBe('pong');
    expect(written).toContain('Gemini API');
    expect(written).toContain('[4] E2E OK');
  });

  it('api: без ключа бросает ProviderNotConfiguredError и пишет ошибку в лог', async () => {
    let written = '';
    const error = new ProviderNotConfiguredError('GEMINI_API_KEY не задан');

    await expect(
      runGeminiE2EAsync({
        mode: 'api',
        apiProvider: () => providerFailing(error),
        log: () => {
          // Вывод в тестах не нужен.
        },
        writeLog: async (_path, content) => {
          written = content;
        },
        logDirectory: TEST_LOG_DIR,
      }),
    ).rejects.toBe(error);
    expect(written).toContain('GEMINI_API_KEY');
  });

  it('web: ошибка получения токена пробрасывается с записью в лог', async () => {
    let written = '';
    const error = new ProviderRequestError('Сессия Google недействительна', 401);

    await expect(
      runGeminiE2EAsync({
        mode: 'web',
        loadAuth: async () => TEST_AUTH,
        resolveToken: async () => {
          throw error;
        },
        log: () => {
          // Вывод в тестах не нужен.
        },
        writeLog: async (_path, content) => {
          written = content;
        },
        logDirectory: TEST_LOG_DIR,
      }),
    ).rejects.toBe(error);
    expect(written).toContain('Сессия Google недействительна');
  });
});
