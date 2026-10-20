/**
 * Тесты SSE-режима `POST /v1/chat/completions` (K2): контракт чанков,
 * `id`/`name` только в первом `tool_calls`-чанке, usage, [DONE].
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

/** Тестовая авторизация. */
const TEST_AUTH: Auth = {
  dsSessionId: 'session-id',
  bearerToken: 'bearer-token',
  savedAt: '2026-10-20T00:00:00.000Z',
};

/** id mock-сессии. */
const SESSION_ID = '00000000-0000-4000-8000-000000000001';

/** Текст с DSML-вызовом без префикса (content = null). */
const DSML_TEXT = `<｜DSML｜tool_calls>
  <｜DSML｜invoke name="bash">
    <｜DSML｜parameter name="command" string="true">ls -la</｜DSML｜parameter>
  </｜DSML｜invoke>
</｜DSML｜tool_calls>`;

/** Базовый payload. */
const BASE_PAYLOAD = {
  model: 'deepseek-web-chat',
  messages: [{ role: 'user', content: 'привет' }],
  stream: true,
};

/** Проверяет, что значение — объект. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/**
 * Разбирает SSE-payload в массив JSON-чанков (и `[DONE]`).
 * @param payload Тело ответа.
 */
const parseSse = (payload: string): unknown[] => {
  const result: unknown[] = [];
  for (const block of payload.split('\n\n')) {
    const line = block.trim();
    if (!line.startsWith('data: ')) {
      continue;
    }
    const data = line.slice('data: '.length);
    if (data === '[DONE]') {
      result.push('[DONE]');
      continue;
    }
    const parsed: unknown = JSON.parse(data);
    result.push(parsed);
  }
  return result;
};

/** Возвращает delta из первого choice чанка. */
const deltaOf = (chunk: Record<string, unknown>): Record<string, unknown> => {
  const choices = Array.isArray(chunk['choices']) ? chunk['choices'] : [];
  const first = choices[0];
  if (!isRecord(first) || !isRecord(first['delta'])) {
    return {};
  }
  return first['delta'];
};

/** Возвращает finish_reason из первого choice чанка. */
const finishOf = (chunk: Record<string, unknown>): unknown => {
  const choices = Array.isArray(chunk['choices']) ? chunk['choices'] : [];
  const first = choices[0];
  return isRecord(first) ? first['finish_reason'] : undefined;
};

/** Базовые зависимости. */
const baseDependencies = (): CompletionsDependencies => ({
  loadAuth: () => Promise.resolve(TEST_AUTH),
  validateSession: () => Promise.resolve(true),
  createChatSession: () => Promise.resolve({ id: SESSION_ID }),
  now: () => 1_729_400_000_000,
  generateId: () => 'stream123',
});

/**
 * Создаёт Fastify-приложение с моками.
 * @param overrides Переопределения.
 */
const buildApp = async (
  overrides: CompletionsDependencies = {},
): Promise<ReturnType<typeof Fastify>> => {
  const app = Fastify();
  await registerCompletionsRoute(app, { ...baseDependencies(), ...overrides });
  return app;
};

/** Пустой поток событий DeepSeek (assemble замокан). */
const emptyEvents = (): AsyncIterable<DeepSeekEvent> => ({
  [Symbol.asyncIterator]: (): AsyncIterator<DeepSeekEvent> => ({
    next: (): Promise<IteratorResult<DeepSeekEvent>> =>
      Promise.resolve({ done: true, value: undefined }),
  }),
});

describe('POST /v1/chat/completions: stream=true', () => {
  it('обычный текст: content-чанки, finish_reason=stop, [DONE]', async () => {
    const app = await buildApp({
      assembleText: () => Promise.resolve({ text: 'Привет!', tokenUsage: 0 }),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: BASE_PAYLOAD,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    const parsed = parseSse(response.payload);
    expect(parsed.at(-1)).toBe('[DONE]');

    const chunks = parsed.filter(isRecord);
    expect(deltaOf(chunks[0] ?? {})['role']).toBe('assistant');
    const content = chunks
      .map((chunk) => deltaOf(chunk)['content'])
      .filter((value): value is string => typeof value === 'string')
      .join('');
    expect(content).toBe('Привет!');
    expect(chunks.some((chunk) => finishOf(chunk) === 'stop')).toBe(true);
    expect(chunks.some((chunk) => 'tool_calls' in deltaOf(chunk))).toBe(false);
  });

  it('DSML: первый tool_calls-чанк с id/name, continuation без них', async () => {
    const app = await buildApp({
      assembleText: () => Promise.resolve({ text: DSML_TEXT, tokenUsage: 12 }),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        ...BASE_PAYLOAD,
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
    const parsed = parseSse(response.payload);
    expect(parsed.at(-1)).toBe('[DONE]');

    const toolDeltas: Record<string, unknown>[] = [];
    for (const chunk of parsed.filter(isRecord)) {
      const calls = deltaOf(chunk)['tool_calls'];
      if (Array.isArray(calls)) {
        for (const call of calls) {
          if (isRecord(call)) {
            toolDeltas.push(call);
          }
        }
      }
    }
    expect(toolDeltas.length).toBeGreaterThanOrEqual(3);

    const first = toolDeltas[0] ?? {};
    expect(first['id']).toMatch(/^call_[0-9a-z]{12}$/u);
    expect(first['type']).toBe('function');
    expect(typeof first['function'] === 'object' && first['function'] !== null).toBe(true);
    const firstFunction = isRecord(first['function']) ? first['function'] : {};
    expect(firstFunction['name']).toBe('bash');
    expect(firstFunction['arguments']).toBe('');

    const continuations = toolDeltas.slice(1);
    expect(continuations.length).toBeGreaterThanOrEqual(2);
    for (const call of continuations) {
      expect('id' in call).toBe(false);
      expect('name' in call).toBe(false);
      const fn = isRecord(call['function']) ? call['function'] : {};
      expect('name' in fn).toBe(false);
    }
    const argumentsText = toolDeltas
      .map((call) => {
        const fn = isRecord(call['function']) ? call['function'] : {};
        return typeof fn['arguments'] === 'string' ? fn['arguments'] : '';
      })
      .join('');
    expect(argumentsText).toBe('{"command":"ls -la"}');

    const finishChunks = parsed.filter(
      (chunk): chunk is Record<string, unknown> => isRecord(chunk) && finishOf(chunk) === 'tool_calls',
    );
    expect(finishChunks).toHaveLength(1);
  });

  it('stream_options.include_usage: финальный чанк с usage', async () => {
    const app = await buildApp({
      assembleText: () => Promise.resolve({ text: 'ok', tokenUsage: 48 }),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { ...BASE_PAYLOAD, stream_options: { include_usage: true } },
    });

    const parsed = parseSse(response.payload);
    const usageChunk = parsed.find(
      (chunk): chunk is Record<string, unknown> => isRecord(chunk) && 'usage' in chunk,
    );
    expect(usageChunk).toBeDefined();
    expect(usageChunk?.['usage']).toEqual({
      prompt_tokens: 0,
      completion_tokens: 48,
      total_tokens: 48,
    });
    expect(usageChunk?.['choices']).toEqual([]);
    expect(parsed.at(-1)).toBe('[DONE]');
  });

  it('без tools: SSE с content и [DONE], без tool_calls', async () => {
    const app = await buildApp({
      assembleText: () => Promise.resolve({ text: 'текст', tokenUsage: 0 }),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: BASE_PAYLOAD,
    });

    const parsed = parseSse(response.payload);
    expect(parsed.at(-1)).toBe('[DONE]');
    for (const chunk of parsed.filter(isRecord)) {
      expect('tool_calls' in deltaOf(chunk)).toBe(false);
    }
  });

  it('401 до SSE при отсутствии auth (JSON-ошибка)', async () => {
    const app = await buildApp({ loadAuth: () => Promise.reject(new AuthNotFoundError()) });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: BASE_PAYLOAD,
    });
    expect(response.statusCode).toBe(401);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.json().error.type).toBe('auth_error');
  });

  it('502 JSON при ошибке upstream до записи SSE', async () => {
    const app = await buildApp({
      sendChat: () => emptyEvents(),
      assembleText: () => Promise.reject(new DeepSeekApiError(40_301, 'INVALID_POW_RESPONSE')),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: BASE_PAYLOAD,
    });
    expect(response.statusCode).toBe(502);
    expect(response.headers['content-type']).toContain('application/json');
  });
});
