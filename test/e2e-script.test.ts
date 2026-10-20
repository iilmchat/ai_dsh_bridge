/**
 * Unit-тесты e2e-скрипта: сборка текста из реального SSE-захвата, шаги
 * лога, редактирование секретов, обработка AuthExpiredError/40301.
 *
 * Живой e2e здесь НЕ запускается (нет auth.json) — только mock.
 */
import { describe, expect, it } from 'vitest';
import type { Auth } from '../src/config.js';
import { parseSseStreamAsync, type DeepSeekEvent } from '../src/deepseek/client.js';
import {
  AuthExpiredError,
  AuthNotFoundError,
  DeepSeekApiError,
  DeepSeekNonSseError,
} from '../src/deepseek/errors.js';
import type { ChatCompletionRequest, PowChallenge } from '../src/deepseek/types.js';
import {
  assembleText,
  buildChatRequest,
  describeError,
  formatEvent,
  formatLogTimestamp,
  redactSecrets,
  runE2EAsync,
  type E2EDependencies,
} from '../scripts/e2e-deepseek.js';

/** Реальный SSE-поток из захвата 2026-10-19. */
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

/** Сессия для mock-тестов (значения вымышленные). */
const TEST_AUTH: Auth = {
  dsSessionId: 'session-id',
  bearerToken: 'secret-bearer-token',
  awsWafToken: 'secret-waf-token',
  savedAt: '2026-10-19T00:00:00.000Z',
};

/** Синтетический challenge (для хуков). */
const TEST_CHALLENGE: PowChallenge = {
  algorithm: 'DeepSeekHashV1',
  challenge: '15f40151bb8ed93bb6f32dc190f231b6e0387f4d240e86bf4ba75ad27ea8d479',
  salt: '705be849c244481503cc',
  signature: '409ddb30a66930a279baedc358e80b6f9e626f40d35e6bcfc87f5d1663fe54ca',
  difficulty: 144_000,
  expire_at: 1_792_419_860_451,
  expire_after: 300_000,
  target_path: '/api/v0/chat/completion',
};

/** Превращает строки в асинхронный поток. */
async function* chunksToStream(chunks: readonly string[]): AsyncGenerator<string> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

/** Разбирает фикстуру захвата в события. */
const parseCaptureEventsAsync = async (): Promise<DeepSeekEvent[]> => {
  const events: DeepSeekEvent[] = [];
  for await (const event of parseSseStreamAsync(chunksToStream([SSE_CAPTURE]))) {
    events.push(event);
  }
  return events;
};

/** id сессии, который вернёт mock `createChatSession`. */
const TEST_SESSION_ID = '2dcf0a4e-0843-41b1-a63d-b497f1c8fa03';

/** Создаёт mock `sendChat`, который вызывает e2e-хуки и отдаёт события. */
const createMockSendChat = (
  events: readonly DeepSeekEvent[],
): NonNullable<E2EDependencies['sendChat']> =>
  async function* mockSendChat(
    _request: Omit<ChatCompletionRequest, 'chat_session_id'>,
    _auth: Auth,
    chatSessionId: string,
    clientDependencies,
  ): AsyncGenerator<DeepSeekEvent> {
    if (chatSessionId !== TEST_SESSION_ID) {
      throw new Error(`sendChat получил чужой chatSessionId: ${chatSessionId}`);
    }
    clientDependencies?.onChallenge?.(TEST_CHALLENGE);
    clientDependencies?.onPowSolved?.({ answer: 141_529, elapsedMs: 570 });
    clientDependencies?.onRequestHeaders?.({
      authorization: 'Bearer secret-bearer-token',
      cookie: 'ds_session_id=secret-session',
      'x-ds-pow-response': 'c2VjcmV0LXBvdw==',
    });
    clientDependencies?.onCompletionStatus?.(200);
    for (const event of events) {
      yield event;
    }
  };

/** `sendChat`, который отвечает не-SSE ошибкой (для теста [5.1]). */
const nonSseSendChat: NonNullable<E2EDependencies['sendChat']> = (
  _request: Omit<ChatCompletionRequest, 'chat_session_id'>,
  _auth: Auth,
  _chatSessionId: string,
): AsyncIterable<DeepSeekEvent> => ({
  [Symbol.asyncIterator]: (): AsyncIterator<DeepSeekEvent> => ({
    next: (): Promise<IteratorResult<DeepSeekEvent>> =>
      Promise.reject(
        new DeepSeekNonSseError({
          status: 200,
          contentType: 'application/json',
          bodyPreview: '{"code":40301,"msg":"INVALID_POW_RESPONSE"}',
          requestUrl: 'https://chat.deepseek.com/api/v0/chat/completion',
          requestHeaders: { accept: 'text/event-stream', 'content-type': 'application/json' },
        }),
      ),
  }),
});

/** Записанный лог. */
interface LogWrite {
  readonly path: string;
  readonly content: string;
}

/** `sendChat`, который всегда отвечает 40301 (для теста ошибки). */
const failingSendChat: NonNullable<E2EDependencies['sendChat']> = (
  _request: Omit<ChatCompletionRequest, 'chat_session_id'>,
  _auth: Auth,
  _chatSessionId: string,
  clientDependencies,
): AsyncIterable<DeepSeekEvent> => {
  clientDependencies?.onChallenge?.(TEST_CHALLENGE);
  return {
    [Symbol.asyncIterator]: (): AsyncIterator<DeepSeekEvent> => ({
      next: (): Promise<IteratorResult<DeepSeekEvent>> =>
        Promise.reject(new DeepSeekApiError(40_301, 'INVALID_POW_RESPONSE')),
    }),
  };
};

/** Создаёт deps с записью лога в память и фиксированной датой. */
const createDeps = (
  overrides: E2EDependencies,
  writes: LogWrite[],
): E2EDependencies => ({
  loadAuth: () => Promise.resolve(TEST_AUTH),
  validateSession: () => Promise.resolve(true),
  createChatSession: () => Promise.resolve({ id: TEST_SESSION_ID }),
  now: (() => {
    let clock = 0;
    return (): number => {
      clock += 10;
      return clock;
    };
  })(),
  log: () => {},
  writeLog: (path, content) => {
    writes.push({ path, content });
    return Promise.resolve();
  },
  logDirectory: 'C:\\fake\\captures',
  date: new Date('2026-10-19T12:00:00Z'),
  ...overrides,
});

describe('assembleText', () => {
  it('собирает текст «Привет! Чем могу помочь?» из реального SSE-захвата', async () => {
    const events = await parseCaptureEventsAsync();
    expect(assembleText(events)).toBe('Привет! Чем могу помочь?');
  });

  it('склеивает text-события без патчей', () => {
    const events: DeepSeekEvent[] = [
      { type: 'text', content: 'a' },
      { type: 'text', content: 'b' },
    ];
    expect(assembleText(events)).toBe('ab');
  });
});

describe('runE2EAsync', () => {
  it('проходит happy path, пишет лог и выводит шаги 1–8', async () => {
    const events = await parseCaptureEventsAsync();
    const writes: LogWrite[] = [];
    const deps = createDeps({ sendChat: createMockSendChat(events), verbose: true }, writes);

    const result = await runE2EAsync(deps);

    expect(result.ok).toBe(true);
    expect(result.text).toBe('Привет! Чем могу помочь?');
    expect(result.events).toHaveLength(events.length);
    expect(result.logPath).toMatch(/e2e-2026-10-19-\d{2}-\d{2}\.log$/);

    const log = writes[0]?.content ?? '';
    expect(log).toContain('[1] validateSession → OK');
    expect(log).toContain(`[2] createChatSession → id=${TEST_SESSION_ID}`);
    expect(log).toContain('[3] createPowChallenge → challenge=15f40151bb8ed93b... difficulty=144000');
    expect(log).toContain('[4] solvePow → answer=141529 in 570ms');
    expect(log).toContain('[5] POST /api/v0/chat/completion → 200');
    expect(log).toContain('[6] SSE stream:');
    expect(log).toContain('[7] Assembled text: "Привет! Чем могу помочь?"');
    expect(log).toContain('[8] E2E OK');
    // verbose-заголовки заредактированы
    expect(log).toContain('authorization: <REDACTED>');
    expect(log).not.toContain('secret-bearer-token');
    expect(log).not.toContain('secret-session');
  });

  it('печатает диагностику [5.1] при Non-SSE ответе', async () => {
    const writes: LogWrite[] = [];
    const deps = createDeps({ sendChat: nonSseSendChat }, writes);

    await expect(runE2EAsync(deps)).rejects.toBeInstanceOf(DeepSeekNonSseError);
    const log = writes[0]?.content ?? '';
    expect(log).toContain('[5.1] Non-SSE response:');
    expect(log).toContain('Status: 200');
    expect(log).toContain('Content-Type: application/json');
    expect(log).toContain(
      'Body preview (first 500 chars): {"code":40301,"msg":"INVALID_POW_RESPONSE"}',
    );
    expect(log).toContain('Request URL: https://chat.deepseek.com/api/v0/chat/completion');
    expect(log).toContain('"accept":"text/event-stream"');
  });

  it('бросает AuthExpiredError и пишет лог, если сессия невалидна', async () => {
    const writes: LogWrite[] = [];
    const deps = createDeps(
      {
        validateSession: () => Promise.resolve(false),
        sendChat: createMockSendChat([]),
      },
      writes,
    );

    await expect(runE2EAsync(deps)).rejects.toBeInstanceOf(AuthExpiredError);
    const log = writes[0]?.content ?? '';
    expect(log).toContain('[1] validateSession → FAIL');
    expect(log).toContain('[ERROR] Сессия истекла, повторите pnpm webauth.');
  });

  it('обрабатывает 40301 INVALID_POW_RESPONSE и пишет его в лог', async () => {
    const writes: LogWrite[] = [];
    const deps = createDeps({ sendChat: failingSendChat }, writes);

    await expect(runE2EAsync(deps)).rejects.toBeInstanceOf(DeepSeekApiError);
    const log = writes[0]?.content ?? '';
    expect(log).toContain('[ERROR] PoW отклонён: 40301 INVALID_POW_RESPONSE');
  });
});

describe('вспомогательные функции e2e', () => {
  it('редактирует authorization/cookie/x-ds-pow-response', () => {
    const redacted = redactSecrets(
      'authorization: Bearer abc.def.ghi\ncookie: ds_session_id=123; aws-waf-token=456\nx-ds-pow-response: eyJzZWNyZXQ=',
    );
    expect(redacted).toContain('authorization: <REDACTED>');
    expect(redacted).toContain('cookie: <REDACTED>');
    expect(redacted).toContain('x-ds-pow-response: <REDACTED>');
    expect(redacted).not.toContain('abc.def.ghi');
    expect(redacted).not.toContain('ds_session_id=123');
    expect(redacted).not.toContain('eyJzZWNyZXQ=');
  });

  it('формирует имя лога YYYY-MM-DD-HH-mm', () => {
    expect(formatLogTimestamp(new Date('2026-10-19T12:34:00Z'))).toMatch(
      /^2026-10-19-\d{2}-\d{2}$/u,
    );
  });

  it('строит тело запроса как в ТЗ (без chat_session_id)', () => {
    const request = buildChatRequest();
    expect(request).toEqual({
      parent_message_id: null,
      model_type: 'default',
      prompt: 'привет',
      ref_file_ids: [],
      thinking_enabled: false,
      search_enabled: false,
      action: null,
      preempt: false,
    });
  });

  it('форматирует события компактно и подробно', () => {
    expect(formatEvent({ type: 'status', status: 'FINISHED' }, false)).toBe(
      'event: status "FINISHED"',
    );
    expect(formatEvent({ type: 'text', content: 'При' }, true)).toContain('"type":"text"');
  });

  it('подсказывает pnpm webauth для AuthNotFoundError/AuthExpiredError', () => {
    expect(describeError(new AuthNotFoundError())).toContain('pnpm webauth');
    expect(describeError(new AuthExpiredError())).toContain('pnpm webauth');
  });
});
