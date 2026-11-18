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
  GEMINI_WEB_MODEL_HEADERS,
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
 * Разбирает `f.req` и возвращает внутренний массив.
 * @param body Тело формы.
 */
const decodeInner = (body: string): unknown => {
  const params = new URLSearchParams(body);
  const fReq = params.get('f.req') ?? '';
  const outer: unknown = JSON.parse(fReq);
  const innerRaw = Array.isArray(outer) ? outer[1] : undefined;
  return typeof innerRaw === 'string' ? (JSON.parse(innerRaw) as unknown) : undefined;
};

/**
 * Извлекает `at` и prompt из тела формы `StreamGenerate`.
 * @param body Тело запроса.
 */
const decodeForm = (body: string): { readonly at: string; readonly prompt: string } => {
  const params = new URLSearchParams(body);
  const at = params.get('at') ?? '';
  const inner = decodeInner(body);
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
 * @param onUpload Ответ эндпоинта загрузки (id файла).
 * @param uploadStatus HTTP-статус загрузки.
 */
const createProvider = (
  requests: CapturedRequest[],
  onGenerate: () => string,
  appStatus = 200,
  loadAuth: (authFile: string) => Promise<GoogleAuth> = async () => TEST_AUTH,
  onUpload: () => string = () => '/contrib_service/ttl_1d/test-file',
  uploadStatus = 200,
) =>
  createGeminiWebProvider({
    authFile: 'unused.json',
    baseUrl: 'https://gemini.test',
    timeoutMs: 5_000,
    uploadRetryDelayMs: 0,
    loadAuth,
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      if (init.method === 'GET') {
        return textResponse(APP_HTML, appStatus);
      }
      if (url.includes('content-push.googleapis.com')) {
        return textResponse(onUpload(), uploadStatus);
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

  it('кодирует загруженные файлы в messageContent', () => {
    const body = buildGenerateRequestBody('что на картинке?', 'AT-TOKEN', [
      { id: '/contrib_service/ttl_1d/abc', name: 'image-1.png' },
    ]);
    expect(decodeInner(body)).toEqual([
      ['что на картинке?', 0, null, [[['/contrib_service/ttl_1d/abc'], 'image-1.png']]],
      null,
      null,
    ]);
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

  it('загружает изображение и передаёт файл в f.req', async () => {
    const requests: CapturedRequest[] = [];
    const provider = createProvider(requests, () => framesBody([candidateFrame('ok')]));

    const result = await provider.completeAsync({
      upstreamModel: 'gemini-web',
      system: '',
      conversation: 'что на картинке?',
      images: [{ mimeType: 'image/png', data: Buffer.from([1, 2, 3]).toString('base64') }],
    });
    expect(result.text).toBe('ok');

    const upload = requests.find((request) =>
      request.url.includes('content-push.googleapis.com'),
    );
    if (upload === undefined) {
      throw new Error('Загрузка изображения не выполнена');
    }
    const uploadHeaders = headersOf(upload);
    expect(uploadHeaders['push-id']).toBe('feeds/mcudyrk2a4khkz');
    expect(uploadHeaders['x-tenant-id']).toBe('bard-storage');
    const uploadBody = upload.init.body;
    if (!(uploadBody instanceof Uint8Array)) {
      throw new Error('Тело загрузки не бинарное');
    }
    const uploadText = Buffer.from(uploadBody).toString('utf8');
    expect(uploadText).toContain('name="file"');
    expect(uploadText).toContain('filename="image-1.png"');
    expect(uploadText).toContain('Content-Type: image/png');

    const generate = requests.find((request) => request.url.includes('StreamGenerate'));
    if (generate === undefined) {
      throw new Error('Запрос генерации не отправлен');
    }
    const rawBody = generate.init.body;
    if (typeof rawBody !== 'string') {
      throw new Error('Тело генерации не строка');
    }
    expect(decodeInner(rawBody)).toEqual([
      ['что на картинке?', 0, null, [[['/contrib_service/ttl_1d/test-file'], 'image-1.png']]],
      null,
      null,
    ]);
  });

  it('возвращает 502, если Google отклонил загрузку изображения', async () => {
    const requests: CapturedRequest[] = [];
    const provider = createProvider(
      requests,
      () => framesBody([]),
      200,
      async () => TEST_AUTH,
      () => '',
      500,
    );

    const error = await providerErrorAsync(
      provider.completeAsync({
        upstreamModel: 'gemini-web',
        system: '',
        conversation: 'q',
        images: [{ mimeType: 'image/png', data: 'QUJD' }],
      }),
    );
    expect(error.status).toBe(502);
  });

  it('повторяет загрузку после транзиентной сетевой ошибки', async () => {
    let uploadAttempts = 0;
    const provider = createGeminiWebProvider({
      authFile: 'unused.json',
      baseUrl: 'https://gemini.test',
      timeoutMs: 5_000,
      uploadRetryDelayMs: 0,
      loadAuth: async () => TEST_AUTH,
      fetchImpl: async (url, init) => {
        if (init.method === 'GET') {
          return textResponse(APP_HTML);
        }
        if (url.includes('content-push.googleapis.com')) {
          uploadAttempts += 1;
          if (uploadAttempts === 1) {
            throw new TypeError('fetch failed');
          }
          return textResponse('/contrib_service/ttl_1d/retry-ok');
        }
        return textResponse(framesBody([candidateFrame('ok')]));
      },
    });

    const result = await provider.completeAsync({
      upstreamModel: 'gemini-web',
      system: '',
      conversation: 'q',
      images: [{ mimeType: 'image/png', data: 'QUJD' }],
    });
    expect(result.text).toBe('ok');
    expect(uploadAttempts).toBe(2);
  });

  it('не повторяет загрузку при 401', async () => {
    let uploadAttempts = 0;
    const provider = createGeminiWebProvider({
      authFile: 'unused.json',
      baseUrl: 'https://gemini.test',
      timeoutMs: 5_000,
      uploadRetryDelayMs: 0,
      loadAuth: async () => TEST_AUTH,
      fetchImpl: async (url, init) => {
        if (init.method === 'GET') {
          return textResponse(APP_HTML);
        }
        if (url.includes('content-push.googleapis.com')) {
          uploadAttempts += 1;
          return textResponse('', 401);
        }
        return textResponse(framesBody([]));
      },
    });

    const error = await providerErrorAsync(
      provider.completeAsync({
        upstreamModel: 'gemini-web',
        system: '',
        conversation: 'q',
        images: [{ mimeType: 'image/png', data: 'QUJD' }],
      }),
    );
    expect(error.status).toBe(401);
    expect(uploadAttempts).toBe(1);
  });

  it('передаёт заголовок модели для flash и не передаёт для default', async () => {
    const flashRequests: CapturedRequest[] = [];
    const flashProvider = createProvider(flashRequests, () =>
      framesBody([candidateFrame('ok')]),
    );
    await flashProvider.completeAsync({
      upstreamModel: 'gemini-2.5-flash',
      system: '',
      conversation: 'q',
    });
    const flashGenerate = flashRequests.find((request) => request.init.method === 'POST');
    if (flashGenerate === undefined) {
      throw new Error('Запрос генерации не отправлен');
    }
    expect(headersOf(flashGenerate)['x-goog-ext-525001261-jspb']).toBe(
      GEMINI_WEB_MODEL_HEADERS['gemini-2.5-flash'],
    );

    const defaultRequests: CapturedRequest[] = [];
    const defaultProvider = createProvider(defaultRequests, () =>
      framesBody([candidateFrame('ok')]),
    );
    await defaultProvider.completeAsync({
      upstreamModel: 'gemini-web',
      system: '',
      conversation: 'q',
    });
    const defaultGenerate = defaultRequests.find((request) => request.init.method === 'POST');
    if (defaultGenerate === undefined) {
      throw new Error('Запрос генерации не отправлен');
    }
    expect(headersOf(defaultGenerate)['x-goog-ext-525001261-jspb']).toBeUndefined();
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
