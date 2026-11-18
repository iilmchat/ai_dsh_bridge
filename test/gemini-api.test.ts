/**
 * Unit-тесты клиента Gemini API: тело запроса, разбор ответа, usage и
 * маппинг ошибок upstream в статусы для DSH. Сеть замокана.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createGeminiApiProvider } from '../src/google/gemini-api.js';
import { ProviderNotConfiguredError, ProviderRequestError } from '../src/providers/types.js';

/** Захваченный запрос. */
interface CapturedRequest {
  readonly url: string;
  readonly init: RequestInit;
}

/**
 * Создаёт `Response` с JSON-телом.
 * @param body Тело.
 * @param status HTTP-статус.
 */
const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/**
 * Извлекает захваченный запрос (падает, если запроса не было).
 * @param requests Массив захваченных запросов.
 * @param index Индекс.
 */
const requestAt = (requests: readonly CapturedRequest[], index = 0): CapturedRequest => {
  const request = requests[index];
  if (request === undefined) {
    throw new Error(`Запрос №${String(index)} не был отправлен`);
  }
  return request;
};

/** Приводит `HeadersInit` к простому объекту без приведения типов. */
const headersOf = (request: CapturedRequest): Record<string, string> => {
  const headers = request.init.headers;
  if (headers === undefined) {
    return {};
  }
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === 'string') {
      result[name] = value;
    }
  }
  return result;
};

/**
 * Тело запроса как JSON-объект (Zod на границе, как в production-коде).
 * @param request Захваченный запрос.
 */
const bodyOf = (request: CapturedRequest): Record<string, unknown> => {
  const raw = request.init.body;
  if (typeof raw !== 'string') {
    throw new Error('Тело запроса не является строкой');
  }
  const parsed: unknown = JSON.parse(raw);
  return z.record(z.string(), z.unknown()).parse(parsed);
};

/** Запрос без system/temperature — общий для тестов ошибок. */
const MINIMAL_REQUEST = {
  upstreamModel: 'gemini-2.5-flash',
  system: '',
  conversation: 'q',
} as const;

/**
 * Ждёт отклонения промиса и возвращает типизированную ошибку провайдера.
 * @param promise Промис `completeAsync`.
 */
const providerErrorAsync = async (promise: Promise<unknown>): Promise<ProviderRequestError> => {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof ProviderRequestError) {
      return error;
    }
    throw error;
  }
  throw new Error('Ожидалась ошибка ProviderRequestError');
};

describe('createGeminiApiProvider', () => {
  it('отправляет systemInstruction, contents и generationConfig', async () => {
    const requests: CapturedRequest[] = [];
    const provider = createGeminiApiProvider({
      apiKey: 'test-key',
      baseUrl: 'https://example.test/',
      timeoutMs: 5_000,
      fetchImpl: async (url, init) => {
        requests.push({ url, init });
        return jsonResponse({
          candidates: [{ content: { parts: [{ text: 'привет' }] } }],
          usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3 },
        });
      },
    });

    const result = await provider.completeAsync({
      upstreamModel: 'gemini-2.5-flash',
      system: 'СИСТЕМА',
      conversation: '[USER]\nпривет',
      temperature: 0.2,
      maxOutputTokens: 128,
    });

    const request = requestAt(requests);
    expect(request.url).toBe(
      'https://example.test/v1beta/models/gemini-2.5-flash:generateContent',
    );
    expect(request.init.method).toBe('POST');
    expect(headersOf(request)['x-goog-api-key']).toBe('test-key');
    expect(headersOf(request)['content-type']).toBe('application/json');

    const body = bodyOf(request);
    expect(body['systemInstruction']).toEqual({ parts: [{ text: 'СИСТЕМА' }] });
    expect(body['contents']).toEqual([{ role: 'user', parts: [{ text: '[USER]\nпривет' }] }]);
    expect(body['generationConfig']).toEqual({ temperature: 0.2, maxOutputTokens: 128 });
    expect(result.text).toBe('привет');
    expect(result.usage).toEqual({ promptTokens: 7, completionTokens: 3 });
  });

  it('не отправляет systemInstruction и generationConfig, если они пусты', async () => {
    const requests: CapturedRequest[] = [];
    const provider = createGeminiApiProvider({
      apiKey: 'test-key',
      fetchImpl: async (url, init) => {
        requests.push({ url, init });
        return jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] });
      },
    });

    await provider.completeAsync({
      upstreamModel: 'gemini-2.5-pro',
      system: '',
      conversation: 'текст',
    });

    const body = bodyOf(requestAt(requests));
    expect(body['systemInstruction']).toBeUndefined();
    expect(body['generationConfig']).toBeUndefined();
  });

  it('игнорирует части thought (рассуждения) и склеивает текст ответа', async () => {
    const provider = createGeminiApiProvider({
      apiKey: 'test-key',
      fetchImpl: async () =>
        jsonResponse({
          candidates: [
            {
              content: {
                parts: [{ text: 'черновик', thought: true }, { text: 'Ответ' }, { text: '!' }],
              },
            },
          ],
        }),
    });

    const result = await provider.completeAsync({
      upstreamModel: 'gemini-2.5-flash',
      system: '',
      conversation: 'вопрос',
    });
    expect(result.text).toBe('Ответ!');
  });

  it('без ключа бросает ProviderNotConfiguredError и не считает себя настроенным', async () => {
    const provider = createGeminiApiProvider({ apiKey: undefined });

    expect(await provider.isConfiguredAsync()).toBe(false);
    await expect(provider.completeAsync(MINIMAL_REQUEST)).rejects.toBeInstanceOf(
      ProviderNotConfiguredError,
    );
  });

  it('маппит 429 в 503 upstream_unavailable', async () => {
    const provider = createGeminiApiProvider({
      apiKey: 'test-key',
      fetchImpl: async () =>
        jsonResponse({ error: { code: 429, message: 'Quota exceeded' } }, 429),
    });

    const error = await providerErrorAsync(provider.completeAsync(MINIMAL_REQUEST));
    expect(error.status).toBe(503);
    expect(error.message).toContain('Quota exceeded');
  });

  it('маппит 403 в 401 (нужна повторная настройка ключа)', async () => {
    const provider = createGeminiApiProvider({
      apiKey: 'test-key',
      fetchImpl: async () => jsonResponse({ error: { message: 'API key invalid' } }, 403),
    });

    const error = await providerErrorAsync(provider.completeAsync(MINIMAL_REQUEST));
    expect(error.status).toBe(401);
  });

  it('возвращает 400 при блокировке по safety (promptFeedback.blockReason)', async () => {
    const provider = createGeminiApiProvider({
      apiKey: 'test-key',
      fetchImpl: async () =>
        jsonResponse({ candidates: [], promptFeedback: { blockReason: 'SAFETY' } }),
    });

    const error = await providerErrorAsync(provider.completeAsync(MINIMAL_REQUEST));
    expect(error.status).toBe(400);
    expect(error.message).toContain('SAFETY');
  });

  it('возвращает 502 при пустом ответе без причины блокировки', async () => {
    const provider = createGeminiApiProvider({
      apiKey: 'test-key',
      fetchImpl: async () => jsonResponse({ candidates: [{ content: { parts: [] } }] }),
    });

    const error = await providerErrorAsync(provider.completeAsync(MINIMAL_REQUEST));
    expect(error.status).toBe(502);
  });
});
