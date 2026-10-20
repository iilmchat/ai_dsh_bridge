/**
 * Тесты HTTP-клиента DeepSeek: mock undici, SSE-поток из захвата 2026-10-19,
 * ретраи `40301`, `401` → AuthExpiredError, валидация сессии.
 */
import { describe, expect, it } from 'vitest';
import {
  CHAT_COMPLETION_TARGET_PATH,
  FETCH_FILES_PATH,
  UPLOAD_FILE_TARGET_PATH,
  createChatSessionAsync,
  fetchFilesAsync,
  parseSseStreamAsync,
  safeBodyPreview,
  sendChatAsync,
  uploadFileAsync,
  validateSessionAsync,
  type DeepSeekEvent,
  type HttpClientAsync,
  type HttpClientResponse,
} from '../src/deepseek/client.js';
import { deepSeekHashV1 } from '../src/deepseek/deepseek-hash.js';
import { decodePowResponse } from '../src/deepseek/pow.js';
import {
  AuthExpiredError,
  DeepSeekApiError,
  DeepSeekNonSseError,
  FileProcessingTimeoutError,
} from '../src/deepseek/errors.js';
import type { Auth } from '../src/config.js';
import type { ChatCompletionRequest, PowChallenge } from '../src/deepseek/types.js';

/** Сессия для тестов (значения вымышленные). */
const TEST_AUTH: Auth = {
  dsSessionId: 'session-id',
  bearerToken: 'bearer-token',
  awsWafToken: 'waf-token',
  savedAt: '2026-10-19T00:00:00.000Z',
};

/** id чат-сессии, который вернёт mock `/chat_session/create`. */
const TEST_CHAT_SESSION_ID = '2dcf0a4e-0843-41b1-a63d-b497f1c8fa03';

/** Тело запроса completion (без `chat_session_id` — его даёт createChatSession). */
const TEST_REQUEST: Omit<ChatCompletionRequest, 'chat_session_id'> = {
  parent_message_id: null,
  model_type: 'default',
  prompt: 'привет',
  ref_file_ids: [],
  thinking_enabled: false,
  search_enabled: true,
  action: null,
  preempt: false,
};

/** Реальный SSE-поток из захвата 2026-10-19 (сокращён: без повторов). */
const SSE_CAPTURE = `event: ready
data: {"request_message_id":1,"response_message_id":2,"model_type":"default"}

event: update_session
data: {"updated_at":1792419562.212636}

data: {"v":{"response":{"message_id":2,"parent_id":1,"model":"","role":"ASSISTANT","thinking_enabled":false,"status":"WIP","fragments":[{"id":2,"type":"RESPONSE","content":"При","references":[],"stage_id":1}]}}}

data: {"p":"response/fragments/-1/content","o":"APPEND","v":"вет"}

data: {"v":"!"}

data: {"v":" Ч"}

data: {"v":"ем"}

data: {"v":" могу"}

data: {"v":" помочь"}

data: {"v":"?"}

data: {"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":48},{"p":"quasi_status","v":"FINISHED"}]}

data: {"p":"response/status","o":"SET","v":"FINISHED"}

event: update_session
data: {"updated_at":1792419562.3659089}

event: title
data: {"content":"Привет"}

event: close
data: {"click_behavior":"none","auto_resume":false}
`;

/** Синтетический challenge с известным решением (nonce = 0). */
const buildSyntheticChallenge = (targetPath = CHAT_COMPLETION_TARGET_PATH): PowChallenge => {
  const salt = 'capture-salt';
  const expireAt = 1_792_419_860_451;
  return {
    algorithm: 'DeepSeekHashV1',
    challenge: deepSeekHashV1(`${salt}_${String(expireAt)}_0`),
    salt,
    signature: 'cd'.repeat(32),
    difficulty: 1,
    expire_at: expireAt,
    expire_after: 300_000,
    target_path: targetPath,
  };
};

/** Запись одного HTTP-вызова. */
interface HttpCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | Uint8Array | undefined;
}

/** Читает тело запроса как строку (multipart/binary приводятся к тексту). */
const bodyToText = (body: string | Uint8Array | undefined): string => {
  if (body === undefined) {
    return '';
  }
  return typeof body === 'string' ? body : new TextDecoder().decode(body);
};

/** Ищет последовательность байтов в теле запроса. */
const bodyContainsBytes = (body: string | Uint8Array | undefined, needle: readonly number[]): boolean => {
  if (!(body instanceof Uint8Array)) {
    return false;
  }
  for (let index = 0; index <= body.length - needle.length; index += 1) {
    let matches = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (body[index + offset] !== needle[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return true;
    }
  }
  return false;
};

/** Обработчик фейкового HTTP. */
type HttpHandler = (call: HttpCall) => HttpClientResponse | Promise<HttpClientResponse>;

/**
 * Создаёт фейковый HTTP-клиент и журнал вызовов.
 * `/chat_session/create` по умолчанию обслуживается автоматически;
 * `handleSession = false` — для тестов ошибок создания сессии.
 * @param handler Обработчик запроса.
 * @param handleSession Автоматически отвечать на `/chat_session/create`.
 */
const createHttpClient = (
  handler: HttpHandler,
  handleSession = true,
): { readonly fn: HttpClientAsync; readonly calls: HttpCall[] } => {
  const calls: HttpCall[] = [];
  const fn: HttpClientAsync = async (url, init) => {
    const call: HttpCall = {
      url,
      method: init.method,
      headers: init.headers,
      body: init.body,
    };
    calls.push(call);
    if (handleSession && url.includes('/chat_session/create')) {
      return sessionResponse();
    }
    return handler(call);
  };
  return { fn, calls };
};

/** Превращает строки в асинхронный поток (мок тела ответа). */
async function* chunksToStream(chunks: readonly string[]): AsyncGenerator<string> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

/** JSON-ответ. */
const jsonResponse = (payload: unknown, statusCode = 200): HttpClientResponse => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: chunksToStream([JSON.stringify(payload)]),
});

/** SSE-ответ. */
const sseResponse = (text: string): HttpClientResponse => ({
  statusCode: 200,
  headers: { 'content-type': 'text/event-stream' },
  body: chunksToStream([text]),
});

/** Ответ challenge. */
const challengeResponse = (
  targetPath = CHAT_COMPLETION_TARGET_PATH,
): HttpClientResponse =>
  jsonResponse({ code: 0, data: { biz_data: { challenge: buildSyntheticChallenge(targetPath) } } });

/** Ответ `/chat_session/create`. */
const sessionResponse = (): HttpClientResponse =>
  jsonResponse({
    code: 0,
    data: { biz_data: { chat_session: { id: TEST_CHAT_SESSION_ID } } },
  });

/** Немедленный sleep для ретраев. */
const noSleep = (): Promise<void> => Promise.resolve();

/** Собирает все события потока. */
const collectEventsAsync = async (
  iterable: AsyncIterable<DeepSeekEvent>,
): Promise<DeepSeekEvent[]> => {
  const events: DeepSeekEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
};

/** Режет строку на куски по `size` символов. */
const splitEvery = (text: string, size: number): string[] => {
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += size) {
    chunks.push(text.slice(index, index + size));
  }
  return chunks;
};

describe('sendChatAsync', () => {
  it('стримит события из реального SSE-потока захвата', async () => {
    const http = createHttpClient((call) =>
      call.url.includes('create_pow_challenge') ? challengeResponse() : sseResponse(SSE_CAPTURE),
    );
    const events = await collectEventsAsync(
      sendChatAsync(TEST_REQUEST, TEST_AUTH, TEST_CHAT_SESSION_ID, {
        httpClient: http.fn,
        sleep: noSleep,
      }),
    );

    expect(events[0]).toEqual({ type: 'ready', requestMessageId: 1, responseMessageId: 2 });
    const initialPatch = events.find(
      (event) => event.type === 'patch' && event.path === 'response' && event.op === 'SET',
    );
    expect(initialPatch).toBeDefined();
    expect(initialPatch).toMatchObject({ type: 'patch', path: 'response', op: 'SET' });
    expect(initialPatch).toMatchObject({
      value: { response: { message_id: 2, role: 'ASSISTANT' } },
    });
    expect(events).toContainEqual({
      type: 'patch',
      path: 'response/fragments/-1/content',
      op: 'APPEND',
      value: 'вет',
    });
    expect(events).toContainEqual({ type: 'text', content: '!' });
    expect(events).toContainEqual({ type: 'text', content: '?' });
    expect(events).toContainEqual({ type: 'status', status: 'FINISHED' });
    expect(events).toContainEqual({ type: 'title', content: 'Привет' });
    expect(events.at(-1)).toEqual({ type: 'close' });
  });

  it('запрашивает challenge с target_path chat/completion и отправляет PoW-заголовок', async () => {
    const http = createHttpClient((call) =>
      call.url.includes('create_pow_challenge') ? challengeResponse() : sseResponse(SSE_CAPTURE),
    );
    await collectEventsAsync(
      sendChatAsync(TEST_REQUEST, TEST_AUTH, TEST_CHAT_SESSION_ID, {
        httpClient: http.fn,
        sleep: noSleep,
      }),
    );

    const challengeCall = http.calls.find((call) => call.url.includes('create_pow_challenge'));
    expect(challengeCall).toBeDefined();
    expect(JSON.parse(bodyToText(challengeCall?.body))).toEqual({
      target_path: CHAT_COMPLETION_TARGET_PATH,
    });
    expect(JSON.parse(bodyToText(challengeCall?.body))).not.toHaveProperty(
      'target_path',
      '/api/v0/file/upload_file',
    );

    const completionCall = http.calls.find((call) => call.url.endsWith(CHAT_COMPLETION_TARGET_PATH));
    expect(completionCall).toBeDefined();
    expect(completionCall?.headers['authorization']).toBe('Bearer bearer-token');
    expect(completionCall?.headers['cookie']).toContain('ds_session_id=session-id');
    expect(completionCall?.headers['x-ds-pow-response']).toBeTruthy();
    expect(completionCall?.headers['accept']).toBe('text/event-stream');
    const decodedPow = decodePowResponse(completionCall?.headers['x-ds-pow-response'] ?? '');
    expect(decodedPow).toMatchObject({ target_path: CHAT_COMPLETION_TARGET_PATH });
    expect(JSON.parse(bodyToText(completionCall?.body))).toMatchObject({
      chat_session_id: TEST_CHAT_SESSION_ID,
    });
  });

  it('повторяет запрос при 40301 INVALID_POW_RESPONSE с новым challenge', async () => {
    let completionCalls = 0;
    const http = createHttpClient((call) => {
      if (call.url.includes('create_pow_challenge')) {
        return challengeResponse();
      }
      completionCalls += 1;
      return completionCalls === 1
        ? jsonResponse({ code: 40_301, msg: 'INVALID_POW_RESPONSE' })
        : sseResponse(SSE_CAPTURE);
    });

    const events = await collectEventsAsync(
      sendChatAsync(TEST_REQUEST, TEST_AUTH, TEST_CHAT_SESSION_ID, {
        httpClient: http.fn,
        sleep: noSleep,
      }),
    );
    expect(completionCalls).toBe(2);
    expect(
      http.calls.filter((call) => call.url.includes('create_pow_challenge')),
    ).toHaveLength(2);
    expect(events[0]).toEqual({ type: 'ready', requestMessageId: 1, responseMessageId: 2 });
  });

  it('бросает AuthExpiredError при 401 и не повторяет запрос', async () => {
    let completionCalls = 0;
    const http = createHttpClient((call) => {
      if (call.url.includes('create_pow_challenge')) {
        return challengeResponse();
      }
      completionCalls += 1;
      return { statusCode: 401, headers: {}, body: chunksToStream(['Unauthorized']) };
    });

    await expect(
      collectEventsAsync(
        sendChatAsync(TEST_REQUEST, TEST_AUTH, TEST_CHAT_SESSION_ID, {
        httpClient: http.fn,
        sleep: noSleep,
      }),
      ),
    ).rejects.toBeInstanceOf(AuthExpiredError);
    expect(completionCalls).toBe(1);
  });

  it('повторяет сетевую ошибку с экспоненциальной задержкой', async () => {
    let completionCalls = 0;
    const http = createHttpClient((call) => {
      if (call.url.includes('create_pow_challenge')) {
        return challengeResponse();
      }
      completionCalls += 1;
      if (completionCalls === 1) {
        throw new Error('ECONNRESET');
      }
      return sseResponse(SSE_CAPTURE);
    });

    const events = await collectEventsAsync(
      sendChatAsync(TEST_REQUEST, TEST_AUTH, TEST_CHAT_SESSION_ID, {
        httpClient: http.fn,
        sleep: noSleep,
      }),
    );
    expect(completionCalls).toBe(2);
    expect(events).toContainEqual({ type: 'text', content: '!' });
  });

  it('выбрасывает DeepSeekNonSseError с диагностикой при application/json', async () => {
    const http = createHttpClient((call) =>
      call.url.includes('create_pow_challenge')
        ? challengeResponse()
        : jsonResponse({ code: 0, msg: 'unexpected response' }),
    );

    let caught: unknown;
    try {
      await collectEventsAsync(
        sendChatAsync(TEST_REQUEST, TEST_AUTH, TEST_CHAT_SESSION_ID, {
        httpClient: http.fn,
        sleep: noSleep,
      }),
      );
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(DeepSeekNonSseError);
    if (!(caught instanceof DeepSeekNonSseError)) {
      throw new Error('Ожидался DeepSeekNonSseError');
    }
    const { diagnostics } = caught;
    expect(diagnostics.status).toBe(200);
    expect(diagnostics.contentType).toContain('application/json');
    expect(diagnostics.bodyPreview).toContain('unexpected');
    expect(diagnostics.requestUrl).toContain(CHAT_COMPLETION_TARGET_PATH);
    expect(diagnostics.requestHeaders['accept']).toBe('text/event-stream');
    expect(diagnostics.requestHeaders).not.toHaveProperty('authorization');
    expect(diagnostics.requestHeaders).not.toHaveProperty('cookie');
    expect(diagnostics.requestHeaders).not.toHaveProperty('x-ds-pow-response');
  });

  it('не утекает секрет из JSON-превью не-SSE ответа', async () => {
    const http = createHttpClient((call) =>
      call.url.includes('create_pow_challenge')
        ? challengeResponse()
        : jsonResponse({ code: 0, note: 'Bearer token and session cookie' }),
    );

    let caught: unknown;
    try {
      await collectEventsAsync(
        sendChatAsync(TEST_REQUEST, TEST_AUTH, TEST_CHAT_SESSION_ID, {
          httpClient: http.fn,
          sleep: noSleep,
        }),
      );
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DeepSeekNonSseError);
    if (!(caught instanceof DeepSeekNonSseError)) {
      throw new Error('Ожидался DeepSeekNonSseError');
    }
    expect(caught.diagnostics.bodyPreview).toBe('{"code":0}');
  });

  it('не повторяет прочие бизнес-ошибки DeepSeek', async () => {
    const http = createHttpClient((call) =>
      call.url.includes('create_pow_challenge')
        ? challengeResponse()
        : jsonResponse({ code: 40_003, msg: 'BAD_REQUEST' }),
    );

    await expect(
      collectEventsAsync(
        sendChatAsync(TEST_REQUEST, TEST_AUTH, TEST_CHAT_SESSION_ID, {
        httpClient: http.fn,
        sleep: noSleep,
      }),
      ),
    ).rejects.toMatchObject({ name: 'DeepSeekApiError', code: 40_003 });

    const completionCall = http.calls.find((call) => call.url.endsWith(CHAT_COMPLETION_TARGET_PATH));
    expect(completionCall).toBeDefined();
    await expect(
      collectEventsAsync(
        sendChatAsync(TEST_REQUEST, TEST_AUTH, TEST_CHAT_SESSION_ID, {
        httpClient: http.fn,
        sleep: noSleep,
      }),
      ),
    ).rejects.toBeInstanceOf(DeepSeekApiError);
  });
});

describe('parseSseStreamAsync', () => {
  it('корректно собирает события при разбиении потока на произвольные чанки', async () => {
    const whole = await collectEventsAsync(parseSseStreamAsync(chunksToStream([SSE_CAPTURE])));
    const split = await collectEventsAsync(
      parseSseStreamAsync(chunksToStream(splitEvery(SSE_CAPTURE, 17))),
    );
    expect(split).toEqual(whole);
    expect(whole[0]).toEqual({ type: 'ready', requestMessageId: 1, responseMessageId: 2 });
    expect(whole.at(-1)).toEqual({ type: 'close' });
  });

  it('понимает CRLF-разделители', async () => {
    const crlf = SSE_CAPTURE.replaceAll('\n', '\r\n');
    const events = await collectEventsAsync(parseSseStreamAsync(chunksToStream([crlf])));
    expect(events[0]).toEqual({ type: 'ready', requestMessageId: 1, responseMessageId: 2 });
    expect(events.at(-1)).toEqual({ type: 'close' });
  });

  it('возвращает error-событие для code != 0 в data', async () => {
    const events = await collectEventsAsync(
      parseSseStreamAsync(
        chunksToStream(['data: {"code":40301,"msg":"INVALID_POW_RESPONSE"}\n\n']),
      ),
    );
    expect(events).toEqual([{ type: 'error', code: 40_301, message: 'INVALID_POW_RESPONSE' }]);
  });
});

describe('validateSessionAsync', () => {
  it('возвращает true при HTTP 200 и code = 0', async () => {
    const http = createHttpClient(() => jsonResponse({ code: 0, msg: '', data: {} }));
    await expect(validateSessionAsync(TEST_AUTH, { httpClient: http.fn })).resolves.toBe(true);
  });

  it('возвращает false при 401 и при бизнес-ошибке', async () => {
    const unauthorized = createHttpClient(() => ({
      statusCode: 401,
      headers: {},
      body: chunksToStream(['Unauthorized']),
    }));
    await expect(validateSessionAsync(TEST_AUTH, { httpClient: unauthorized.fn })).resolves.toBe(false);

    const businessError = createHttpClient(() => jsonResponse({ code: 40_003, msg: 'EXPIRED' }));
    await expect(validateSessionAsync(TEST_AUTH, { httpClient: businessError.fn })).resolves.toBe(
      false,
    );
  });

  it('возвращает false при сетевой ошибке', async () => {
    const http = createHttpClient(() => {
      throw new Error('ENOTFOUND');
    });
    await expect(validateSessionAsync(TEST_AUTH, { httpClient: http.fn })).resolves.toBe(false);
  });
});

describe('createChatSessionAsync', () => {
  it('создаёт сессию и возвращает id из biz_data.chat_session.id', async () => {
    const http = createHttpClient(() => jsonResponse({}));
    const session = await createChatSessionAsync(TEST_AUTH, { httpClient: http.fn });
    expect(session.id).toBe(TEST_CHAT_SESSION_ID);

    const sessionCall = http.calls.find((call) => call.url.includes('/chat_session/create'));
    expect(sessionCall).toBeDefined();
    expect(sessionCall?.method).toBe('POST');
    expect(sessionCall?.headers['authorization']).toBe('Bearer bearer-token');
    expect(sessionCall?.headers['content-type']).toBe('application/json');
  });

  it('бросает DeepSeekApiError при code !== 0', async () => {
    const http = createHttpClient(
      (call) =>
        call.url.includes('/chat_session/create')
          ? jsonResponse({ code: 40_003, msg: 'CREATE_FAILED' })
          : jsonResponse({}),
      false,
    );
    await expect(
      createChatSessionAsync(TEST_AUTH, { httpClient: http.fn }),
    ).rejects.toMatchObject({ name: 'DeepSeekApiError', code: 40_003 });
  });

  it('бросает DeepSeekApiError, если id сессии отсутствует', async () => {
    const http = createHttpClient(
      () => jsonResponse({ code: 0, data: { biz_data: {} } }),
      false,
    );
    await expect(
      createChatSessionAsync(TEST_AUTH, { httpClient: http.fn }),
    ).rejects.toBeInstanceOf(DeepSeekApiError);
  });
});

/** Ответ upload_file. */
const uploadFileResponse = (): HttpClientResponse =>
  jsonResponse({
    code: 0,
    msg: '',
    data: {
      biz_code: 0,
      biz_msg: '',
      biz_data: { id: 'file-test-1', status: 'PENDING' },
    },
  });

describe('uploadFileAsync', () => {
  /** PNG-сигнатура: проверяем, что байты файла попали в multipart. */
  const FILE_DATA = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const FILE_INPUT = { data: FILE_DATA, mimeType: 'image/png', fileName: 'image-1.png' };

  it('решает PoW под upload_file и отправляет multipart с полем file', async () => {
    const http = createHttpClient((call) =>
      call.url.includes('create_pow_challenge') ? challengeResponse() : uploadFileResponse(),
    );
    const uploaded = await uploadFileAsync(TEST_AUTH, FILE_INPUT, { httpClient: http.fn });
    expect(uploaded).toEqual({ id: 'file-test-1', status: 'PENDING' });

    const challengeCall = http.calls.find((call) => call.url.includes('create_pow_challenge'));
    expect(challengeCall).toBeDefined();
    expect(JSON.parse(bodyToText(challengeCall?.body))).toEqual({
      target_path: UPLOAD_FILE_TARGET_PATH,
    });

    const uploadCall = http.calls.find((call) => call.url.endsWith(UPLOAD_FILE_TARGET_PATH));
    expect(uploadCall).toBeDefined();
    expect(uploadCall?.method).toBe('POST');
    expect(uploadCall?.headers['authorization']).toBe('Bearer bearer-token');
    expect(uploadCall?.headers['x-file-size']).toBe(String(FILE_DATA.length));
    expect(uploadCall?.headers['x-model-type']).toBe('default');
    expect(uploadCall?.headers['x-thinking-enabled']).toBe('0');
    expect(uploadCall?.headers['x-ds-pow-response']).toBeTruthy();
    expect(decodePowResponse(uploadCall?.headers['x-ds-pow-response'] ?? '')).toMatchObject({
      target_path: UPLOAD_FILE_TARGET_PATH,
    });

    const contentType = uploadCall?.headers['content-type'] ?? '';
    const boundary = /boundary=(.+)$/u.exec(contentType)?.[1];
    expect(boundary).toBeTruthy();
    const bodyText = bodyToText(uploadCall?.body);
    expect(bodyText).toContain(`--${String(boundary)}`);
    expect(bodyText).toContain(
      'Content-Disposition: form-data; name="file"; filename="image-1.png"',
    );
    expect(bodyText).toContain('Content-Type: image/png');
    expect(bodyText).toContain(`--${String(boundary)}--`);
    expect(bodyContainsBytes(uploadCall?.body, [...FILE_DATA])).toBe(true);
  });

  it('401 → AuthExpiredError', async () => {
    const http = createHttpClient((call) =>
      call.url.includes('create_pow_challenge')
        ? challengeResponse()
        : { statusCode: 401, headers: {}, body: chunksToStream(['Unauthorized']) },
    );
    await expect(
      uploadFileAsync(TEST_AUTH, FILE_INPUT, { httpClient: http.fn }),
    ).rejects.toBeInstanceOf(AuthExpiredError);
  });

  it('code !== 0 → DeepSeekApiError', async () => {
    const http = createHttpClient((call) =>
      call.url.includes('create_pow_challenge')
        ? challengeResponse()
        : jsonResponse({ code: 40_003, msg: 'UPLOAD_FAILED' }),
    );
    await expect(
      uploadFileAsync(TEST_AUTH, FILE_INPUT, { httpClient: http.fn }),
    ).rejects.toMatchObject({ name: 'DeepSeekApiError', code: 40_003 });
  });

  it('без biz_data.id → DeepSeekApiError', async () => {
    const http = createHttpClient((call) =>
      call.url.includes('create_pow_challenge')
        ? challengeResponse()
        : jsonResponse({ code: 0, data: { biz_code: 0, biz_data: {} } }),
    );
    await expect(
      uploadFileAsync(TEST_AUTH, FILE_INPUT, { httpClient: http.fn }),
    ).rejects.toBeInstanceOf(DeepSeekApiError);
  });
});

/** Ответ fetch_files для одного файла. */
const fetchFilesResponse = (status: string): HttpClientResponse =>
  jsonResponse({
    code: 0,
    data: {
      biz_code: 0,
      biz_msg: '',
      biz_data: {
        files: [
          {
            id: 'file-1',
            status,
            file_name: 'image-1.png',
            file_size: 8,
            is_image: true,
            audit_result: 'unknown',
            error_code: null,
          },
        ],
      },
    },
  });

describe('fetchFilesAsync', () => {
  it('опрашивает fetch_files, пока PENDING не сменится на SUCCESS', async () => {
    const statuses = ['PENDING', 'PENDING', 'SUCCESS'];
    let index = 0;
    const http = createHttpClient(() => {
      const status = statuses[Math.min(index, statuses.length - 1)] ?? 'SUCCESS';
      index += 1;
      return fetchFilesResponse(status);
    });
    const sleeps: number[] = [];
    const result = await fetchFilesAsync(TEST_AUTH, ['file-1'], {
      httpClient: http.fn,
      sleep: (milliseconds) => {
        sleeps.push(milliseconds);
        return Promise.resolve();
      },
      fetchFilesPollIntervalMs: 128,
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.status).toBe('SUCCESS');
    const calls = http.calls.filter((call) => call.url.includes(FETCH_FILES_PATH));
    expect(calls).toHaveLength(3);
    expect(calls[0]?.url).toContain('file_ids=file-1');
    expect(sleeps).toEqual([128, 128]);
  });

  it('бросает FileProcessingTimeoutError при превышении таймаута', async () => {
    let clock = 0;
    const http = createHttpClient(() => fetchFilesResponse('PENDING'));
    await expect(
      fetchFilesAsync(TEST_AUTH, ['file-1'], {
        httpClient: http.fn,
        now: () => clock,
        sleep: () => {
          clock += 1000;
          return Promise.resolve();
        },
        fetchFilesTimeoutMs: 3000,
        fetchFilesPollIntervalMs: 1000,
      }),
    ).rejects.toBeInstanceOf(FileProcessingTimeoutError);
  });

  it('терминальный статус → DeepSeekApiError', async () => {
    const http = createHttpClient(() => fetchFilesResponse('FAILED'));
    await expect(
      fetchFilesAsync(TEST_AUTH, ['file-1'], { httpClient: http.fn }),
    ).rejects.toMatchObject({ name: 'DeepSeekApiError' });
  });

  it('401 → AuthExpiredError', async () => {
    const http = createHttpClient(() => ({
      statusCode: 401,
      headers: {},
      body: chunksToStream(['Unauthorized']),
    }));
    await expect(
      fetchFilesAsync(TEST_AUTH, ['file-1'], { httpClient: http.fn }),
    ).rejects.toBeInstanceOf(AuthExpiredError);
  });
});

describe('safeBodyPreview', () => {
  it('для JSON оставляет code/msg/error, не показывая token', () => {
    const preview = safeBodyPreview(
      '{"code":40301,"msg":"INVALID_POW_RESPONSE","token":"secret-value"}',
    );
    expect(preview).toBe('{"code":40301,"msg":"INVALID_POW_RESPONSE"}');
    expect(preview).not.toContain('secret-value');
  });

  it('показывает biz_code/biz_msg из data.biz_data', () => {
    const preview = safeBodyPreview(
      '{"code":0,"data":{"biz_data":{"biz_code":123,"biz_msg":"INVALID_CHAT_SESSION"}}}',
    );
    expect(preview).toBe('{"code":0,"biz_code":123,"biz_msg":"INVALID_CHAT_SESSION"}');
  });

  it('для не-JSON с Bearer возвращает безопасный маркер', () => {
    expect(safeBodyPreview('Bearer abc.def.ghi')).toBe(
      '<REDACTED: non-JSON body contains secret markers>',
    );
  });

  it('для не-JSON без секретов отдаёт первые 500 символов', () => {
    const body = 'x'.repeat(600);
    expect(safeBodyPreview(body)).toHaveLength(500);
  });
});
