/**
 * Unit-тесты клиента веб-чата gemini.google.com: форма `at`/`f.req`, разбор
 * кадров StreamGenerate, кэш `SNlM0e` и маппинг ошибок. Сеть замокана.
 */
import { describe, expect, it } from 'vitest';
import { GoogleAuthNotFoundError } from '../src/google/errors.js';
import {
  buildGenerateRequestBody,
  createGeminiWebProvider,
  extractAccessToken,
} from '../src/google/gemini-web.js';
import type { GoogleAuth } from '../src/google/auth.js';
import { ProviderRequestError } from '../src/providers/types.js';

/** Захваченный запрос. */
interface CapturedRequest {
  readonly url: string;
  readonly init: RequestInit;
}

/** Cookie-сессия для тестов. */
const TEST_AUTH: GoogleAuth = {
  cookies: { '__Secure-1PSID': 'psid-value', '__Secure-1PSIDTS': 'psidts-value' },
  savedAt: '2026-11-18T00:00:00.000Z',
};

/** HTML страницы `/app` с access token. */
const APP_HTML =
  '<html><script>window.WIZ_global_data={"SNlM0e":"AT-TOKEN","cfb2h":"build"};</script></html>';

/** Минимальный запрос к веб-чату. */
const WEB_REQUEST = { upstreamModel: 'gemini-web', system: '', conversation: 'q' } as const;

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

/**
 * Собирает кадр StreamGenerate с кандидатом.
 * @param text Текст ответа.
 */
const candidateFrame = (text: string): string => {
  const candidate = ['rcid-1', [text]];
  const inner = [null, ['cid-1', 'rid-1', null], null, null, [candidate]];
  return JSON.stringify([
    ['wrb.fr', 'StreamGenerate', JSON.stringify(inner), null, null, null, 'generic'],
  ]);
};

/**
 * Собирает кадр с кодом ошибки Google (`part[5][2][0][1][0]`).
 * @param code Код ошибки.
 */
const errorFrame = (code: number): string =>
  JSON.stringify([
    ['wrb.fr', 'StreamGenerate', null, null, null, [null, null, [[null, [code]]]], 'generic'],
  ]);

/**
 * Оборачивает кадры в тело ответа `StreamGenerate`.
 * @param frames Кадры.
 */
const framesBody = (frames: readonly string[]): string => `)]}'\n\n${frames.join('\n')}\n`;

/**
 * Создаёт `Response` с текстом.
 * @param body Тело.
 * @param status HTTP-статус.
 */
const textResponse = (body: string, status = 200): Response =>
  new Response(body, { status, headers: { 'content-type': 'text/plain;charset=UTF-8' } });

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
 * Извлекает `at` и prompt из тела формы `StreamGenerate`.
 * @param body Тело запроса.
 */
const decodeForm = (body: string): { readonly at: string; readonly prompt: string } => {
  const params = new URLSearchParams(body);
  const at = params.get('at') ?? '';
  const fReq = params.get('f.req') ?? '';
  const outer: unknown = JSON.parse(fReq);
  const innerRaw = Array.isArray(outer) ? outer[1] : undefined;
  const inner: unknown = typeof innerRaw === 'string' ? JSON.parse(innerRaw) : undefined;
  const first = Array.isArray(inner) ? inner[0] : undefined;
  const prompt = Array.isArray(first) ? first[0] : undefined;
  return { at, prompt: typeof prompt === 'string' ? prompt : '' };
};

/**
 * Создаёт провайдер с замоканной сетью.
 * @param requests Массив захваченных запросов.
 * @param onGenerate Кадры ответа генерации.
 * @param appStatus HTTP-статус страницы `/app`.
 * @param loadAuth Загрузчик сессии (по умолчанию — валидная тестовая).
 */
const createProvider = (
  requests: CapturedRequest[],
  onGenerate: () => string,
  appStatus = 200,
  loadAuth: (authFile: string) => Promise<GoogleAuth> = async () => TEST_AUTH,
) =>
  createGeminiWebProvider({
    authFile: 'unused.json',
    baseUrl: 'https://gemini.test',
    timeoutMs: 5_000,
    loadAuth,
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      if (init.method === 'GET') {
        return textResponse(APP_HTML, appStatus);
      }
      return textResponse(onGenerate());
    },
  });

describe('buildGenerateRequestBody', () => {
  it('кодирует at и f.req по протоколу StreamGenerate', () => {
    const body = buildGenerateRequestBody('привет', 'AT-TOKEN');
    const decoded = decodeForm(body);
    expect(decoded.at).toBe('AT-TOKEN');
    expect(decoded.prompt).toBe('привет');
  });
});

describe('extractAccessToken', () => {
  it('находит SNlM0e в HTML', () => {
    expect(extractAccessToken(APP_HTML)).toBe('AT-TOKEN');
  });

  it('возвращает undefined на странице входа', () => {
    expect(extractAccessToken('<html>Sign in</html>')).toBeUndefined();
  });
});

describe('createGeminiWebProvider', () => {
  it('отправляет prompt (system + транскрипт) и выбирает полный ответ', async () => {
    const requests: CapturedRequest[] = [];
    const provider = createProvider(requests, () =>
      framesBody([candidateFrame('привет'), candidateFrame('привет, мир!')]),
    );

    const result = await provider.completeAsync({
      upstreamModel: 'gemini-web',
      system: 'СИСТЕМА',
      conversation: '[USER]\nпривет',
    });

    expect(result.text).toBe('привет, мир!');
    const generate = requests.find((request) => request.init.method === 'POST');
    if (generate === undefined) {
      throw new Error('Запрос генерации не отправлен');
    }
    expect(generate.url).toBe(
      'https://gemini.test/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate',
    );
    const headers = headersOf(generate);
    expect(headers['cookie']).toContain('__Secure-1PSID=psid-value');
    expect(headers['x-same-domain']).toBe('1');
    const rawBody = generate.init.body;
    if (typeof rawBody !== 'string') {
      throw new Error('Тело запроса не является строкой');
    }
    const form = decodeForm(rawBody);
    expect(form.at).toBe('AT-TOKEN');
    expect(form.prompt).toBe('СИСТЕМА\n\n[USER]\nпривет');
  });

  it('кэширует SNlM0e между запросами', async () => {
    const requests: CapturedRequest[] = [];
    const provider = createProvider(requests, () => framesBody([candidateFrame('ok')]));

    await provider.completeAsync({ upstreamModel: 'gemini-web', system: '', conversation: '1' });
    await provider.completeAsync({ upstreamModel: 'gemini-web', system: '', conversation: '2' });

    const pageRequests = requests.filter((request) => request.init.method === 'GET');
    expect(pageRequests).toHaveLength(1);
  });

  it('считает себя ненастроенным, если google-auth.json недоступен', async () => {
    const provider = createProvider([], () => framesBody([]), 200, () =>
      Promise.reject(new GoogleAuthNotFoundError()),
    );
    expect(await provider.isConfiguredAsync()).toBe(false);
  });

  it('маппит код 1037 (лимит) в 503', async () => {
    const provider = createProvider([], () => framesBody([errorFrame(1037)]));

    const error = await providerErrorAsync(provider.completeAsync(WEB_REQUEST));
    expect(error.status).toBe(503);
  });

  it('маппит HTTP 401 в 401 с просьбой повторить webauth:google', async () => {
    const provider = createProvider([], () => '', 401);

    const error = await providerErrorAsync(provider.completeAsync(WEB_REQUEST));
    expect(error.status).toBe(401);
    expect(error.message).toContain('pnpm webauth:google');
  });

  it('возвращает 502 при пустом ответе без кода ошибки', async () => {
    const provider = createProvider([], () => framesBody([]));

    const error = await providerErrorAsync(provider.completeAsync(WEB_REQUEST));
    expect(error.status).toBe(502);
  });
});
