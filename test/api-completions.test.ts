/**
 * Unit-тесты `POST /v1/chat/completions` (non-streaming, K1) и
 * `assembleTextFromEvents`. Все внешние вызовы замоканы.
 */
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  registerCompletionsRoute,
  type CompletionsDependencies,
} from '../src/api/completions.js';
import type { Auth } from '../src/config.js';
import type { DeepSeekEvent } from '../src/deepseek/client.js';
import { AuthNotFoundError, DeepSeekApiError } from '../src/deepseek/errors.js';
import { assembleTextFromEvents } from '../src/translate/assemble.js';

/** Тестовая авторизация. */
const TEST_AUTH: Auth = {
  dsSessionId: 'session-id',
  bearerToken: 'bearer-token',
  savedAt: '2026-10-20T00:00:00.000Z',
};

/** id mock-сессии. */
const SESSION_ID = '00000000-0000-4000-8000-000000000001';

/** Текст с DSML-вызовом. */
const DSML_TEXT = `Я выполню команду.
<｜DSML｜tool_calls>
  <｜DSML｜invoke name="bash">
    <｜DSML｜parameter name="command" string="true">ls -la</｜DSML｜parameter>
  </｜DSML｜invoke>
</｜DSML｜tool_calls>`;

/** Запрос без tools. */
const USER_PAYLOAD = {
  model: 'deepseek-web-chat',
  messages: [{ role: 'user', content: 'привет' }],
};

/** Базовые зависимости (все успешные). */
const baseDependencies = (): CompletionsDependencies => ({
  loadAuth: () => Promise.resolve(TEST_AUTH),
  validateSession: () => Promise.resolve(true),
  createChatSession: () => Promise.resolve({ id: SESSION_ID }),
  now: () => 1_729_400_000_000,
  generateId: () => 'abc123',
});

/**
 * Создаёт Fastify-приложение с замоканными зависимостями.
 * @param overrides Переопределения зависимостей.
 */
const buildApp = async (
  overrides: CompletionsDependencies = {},
): Promise<ReturnType<typeof Fastify>> => {
  const app = Fastify();
  await registerCompletionsRoute(app, { ...baseDependencies(), ...overrides });
  return app;
};

/** Преобразует массив событий в AsyncIterable. */
async function* toEvents(events: readonly DeepSeekEvent[]): AsyncGenerator<DeepSeekEvent> {
  for (const event of events) {
    yield event;
  }
}

/** Мок `sendChat`, отдающий заданные события. */
const sendChatWith = (
  events: readonly DeepSeekEvent[],
): NonNullable<CompletionsDependencies['sendChat']> =>
  async function* mockSendChat(): AsyncGenerator<DeepSeekEvent> {
    for (const event of events) {
      yield event;
    }
  };

/** Мок `sendChat`, падающий с DeepSeekApiError. */
const failingSendChat: NonNullable<CompletionsDependencies['sendChat']> =
  async function* failing(): AsyncGenerator<DeepSeekEvent> {
    yield { type: 'status', status: 'FINISHED' };
    throw new DeepSeekApiError(40_301, 'INVALID_POW_RESPONSE');
  };

describe('POST /v1/chat/completions (K1)', () => {
  it('200: возвращает content без tool_calls', async () => {
    const app = await buildApp({
      sendChat: sendChatWith([
        { type: 'text', content: 'Привет!' },
        { type: 'status', status: 'FINISHED' },
      ]),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: USER_PAYLOAD,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.object).toBe('chat.completion');
    expect(body.id).toBe('chatcmpl-abc123');
    expect(body.created).toBe(1_729_400_000);
    expect(body.model).toBe('deepseek-web-chat');
    expect(body.choices[0].message).toEqual({ role: 'assistant', content: 'Привет!' });
    expect(body.choices[0].finish_reason).toBe('stop');
    expect(body.usage).toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  });

  it('200: возвращает tool_calls из DSML и finish_reason=tool_calls', async () => {
    const app = await buildApp({
      sendChat: sendChatWith([]),
      assembleText: () => Promise.resolve({ text: DSML_TEXT, tokenUsage: 48 }),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        ...USER_PAYLOAD,
        tools: [
          {
            type: 'function',
            function: {
              name: 'bash',
              description: 'Выполняет shell-команду',
              parameters: { type: 'object', properties: { command: { type: 'string' } } },
            },
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.choices[0].message.content).toBe('Я выполню команду.');
    expect(body.choices[0].message.tool_calls).toHaveLength(1);
    expect(body.choices[0].message.tool_calls[0].function).toEqual({
      name: 'bash',
      arguments: '{"command":"ls -la"}',
    });
    expect(body.choices[0].finish_reason).toBe('tool_calls');
    expect(body.usage.completion_tokens).toBe(48);
    expect(body.usage.total_tokens).toBe(48);
  });

  it('400: невалидное тело (пустые messages)', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'deepseek-web-chat', messages: [] },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.type).toBe('invalid_request_error');
  });

  it('400: tools без function.name', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        ...USER_PAYLOAD,
        tools: [{ type: 'function', function: { description: 'без имени' } }],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.type).toBe('invalid_request_error');
  });

  it('200: принимает store и max_completion_tokens (DSH)', async () => {
    const app = await buildApp({
      sendChat: sendChatWith([{ type: 'text', content: 'ok' }]),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { ...USER_PAYLOAD, store: true, max_completion_tokens: 100 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().choices[0].message.content).toBe('ok');
  });

  it('400: неизвестное поле (schema.strict)', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { ...USER_PAYLOAD, foo: 'bar' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.type).toBe('invalid_request_error');
  });

  it('401: auth.json отсутствует', async () => {
    const app = await buildApp({ loadAuth: () => Promise.reject(new AuthNotFoundError()) });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: USER_PAYLOAD,
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.type).toBe('auth_error');
  });

  it('401: сессия невалидна', async () => {
    const app = await buildApp({ validateSession: () => Promise.resolve(false) });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: USER_PAYLOAD,
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.type).toBe('auth_expired');
  });

  it('200: stream=true отдаёт SSE-поток', async () => {
    const app = await buildApp({
      sendChat: sendChatWith([]),
      assembleText: () => Promise.resolve({ text: 'ok', tokenUsage: 0 }),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { ...USER_PAYLOAD, stream: true },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.payload).toContain('data: [DONE]');
  });

  it('502: ошибка DeepSeek', async () => {
    const app = await buildApp({ sendChat: failingSendChat });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: USER_PAYLOAD,
    });
    expect(response.statusCode).toBe(502);
    expect(response.json().error.type).toBe('upstream_error');
  });
});

describe('assembleTextFromEvents', () => {
  it('собирает SET-фрагменты, APPEND, text и token usage', async () => {
    const events: DeepSeekEvent[] = [
      {
        type: 'patch',
        path: 'response',
        op: 'SET',
        value: { response: { fragments: [{ type: 'RESPONSE', content: 'При' }] } },
      },
      {
        type: 'patch',
        path: 'response/fragments/-1/content',
        op: 'APPEND',
        value: 'вет',
      },
      { type: 'text', content: '!' },
      {
        type: 'patch',
        path: 'response',
        op: 'BATCH',
        value: [{ p: 'accumulated_token_usage', v: 48 }],
      },
      { type: 'status', status: 'FINISHED' },
    ];
    await expect(assembleTextFromEvents(toEvents(events))).resolves.toEqual({
      text: 'Привет!',
      tokenUsage: 48,
    });
  });

  it('error-событие → DeepSeekApiError', async () => {
    await expect(
      assembleTextFromEvents(toEvents([{ type: 'error', code: 500, message: 'boom' }])),
    ).rejects.toBeInstanceOf(DeepSeekApiError);
  });
});
