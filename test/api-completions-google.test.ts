/**
 * Тесты маршрутизации провайдеров в `POST /v1/chat/completions`:
 * Google-модели обслуживаются провайдером, неизвестная модель — 400,
 * неподдерживаемые изображения — 400, ошибка провайдера — её статус.
 */
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { registerCompletionsRoute } from '../src/api/completions.js';
import { ProviderRequestError, type ChatProvider } from '../src/providers/types.js';

/** Схема успешного ответа с одним `tool_calls` (проверка контракта). */
const ToolCallsResponseSchema = z.object({
  model: z.string(),
  choices: z.array(
    z.object({
      finish_reason: z.string(),
      message: z.object({
        tool_calls: z.array(
          z.object({
            id: z.string(),
            type: z.literal('function'),
            function: z.object({ name: z.string(), arguments: z.string() }),
          }),
        ),
      }),
    }),
  ),
});

/** Текст с DSML-вызовом (как ответит Gemini). */
const DSML_TEXT = `<｜DSML｜tool_calls>
  <｜DSML｜invoke name="bash">
    <｜DSML｜parameter name="command" string="true">ls -la</｜DSML｜parameter>
  </｜DSML｜invoke>
</｜DSML｜tool_calls>`;

/** Минимальный PNG 1×1 в data:base64 (для vision-запросов). */
const IMAGE_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** Запрос к Google-модели. */
const GOOGLE_PAYLOAD = {
  model: 'google-gemini-web',
  messages: [{ role: 'user', content: 'привет' }],
};

/**
 * Фейковый провайдер, возвращающий заданный текст.
 * @param text Текст ответа.
 * @param requests Массив захваченных запросов (если нужен).
 */
const fakeProvider = (
  text: string,
  requests: { system: string; conversation: string }[] = [],
): ChatProvider => ({
  id: 'google-gemini-web',
  isConfiguredAsync: async () => true,
  completeAsync: async (request) => {
    requests.push({ system: request.system, conversation: request.conversation });
    return { text, usage: { promptTokens: 0, completionTokens: 0 } };
  },
});

/**
 * Создаёт Fastify-приложение с фейковым провайдером.
 * @param provider Провайдер Google.
 */
const buildApp = async (provider: ChatProvider): Promise<ReturnType<typeof Fastify>> => {
  const app = Fastify();
  await registerCompletionsRoute(app, {
    providerFor: () => provider,
    now: () => 1_729_400_000_000,
    generateId: () => 'abc123',
  });
  return app;
};

describe('POST /v1/chat/completions — Google-провайдер', () => {
  it('возвращает tool_calls, разобранные из DSML-ответа Gemini', async () => {
    const requests: { system: string; conversation: string }[] = [];
    const app = await buildApp(fakeProvider(DSML_TEXT, requests));
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: GOOGLE_PAYLOAD,
    });

    expect(response.statusCode).toBe(200);
    const body = ToolCallsResponseSchema.parse(response.json());
    expect(body.model).toBe('google-gemini-web');
    expect(body.choices[0]?.finish_reason).toBe('tool_calls');
    const toolCall = body.choices[0]?.message.tool_calls[0];
    expect(toolCall?.type).toBe('function');
    expect(toolCall?.function).toEqual({ name: 'bash', arguments: '{"command":"ls -la"}' });
    expect(toolCall?.id.length).toBeGreaterThan(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.conversation).toContain('[USER]');
  });

  it('возвращает 400 для неизвестной модели', async () => {
    const app = await buildApp(fakeProvider('ok'));
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'gpt-4o', messages: [{ role: 'user', content: 'привет' }] },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain('Неизвестная модель');
    expect(response.json().error.message).toContain('google-gemini-web');
  });

  it('передаёт изображения провайдеру Gemini API', async () => {
    const captured: { images: readonly { mimeType: string; data: string }[] | undefined }[] = [];
    const provider: ChatProvider = {
      id: 'google-gemini-api',
      isConfiguredAsync: async () => true,
      completeAsync: async (request) => {
        captured.push({ images: request.images });
        return { text: 'ok', usage: { promptTokens: 0, completionTokens: 0 } };
      },
    };
    const app = await buildApp(provider);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'google-gemini-api-flash',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'что на картинке?' },
              { type: 'image_url', image_url: { url: IMAGE_DATA_URL } },
            ],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(captured[0]?.images).toHaveLength(1);
    expect(captured[0]?.images?.[0]?.mimeType).toBe('image/png');
    expect((captured[0]?.images?.[0]?.data ?? '').length).toBeGreaterThan(0);
  });

  it('возвращает 400, если Google-модели передали изображение', async () => {
    const app = await buildApp(fakeProvider('ok'));
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'google-gemini-web',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'что на картинке?' },
              {
                type: 'image_url',
                image_url: {
                  url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
                },
              },
            ],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain('не поддерживает изображения');
  });

  it('пробрасывает статус ошибки провайдера (503 → upstream_unavailable)', async () => {
    const app = await buildApp({
      id: 'google-gemini-api',
      isConfiguredAsync: async () => true,
      completeAsync: async () => {
        throw new ProviderRequestError('Google перегружен', 503);
      },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { ...GOOGLE_PAYLOAD, model: 'google-gemini-api-flash' },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().error.type).toBe('upstream_unavailable');
    expect(response.json().error.message).toBe('Google перегружен');
  });
});
