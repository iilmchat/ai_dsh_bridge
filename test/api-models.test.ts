/**
 * Тесты `GET /v1/models`: формат OpenAI и capabilities для DSH.
 */
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerModelsRoute } from '../src/api/models.js';

/** Создаёт Fastify-приложение с маршрутом моделей. */
const buildApp = (): ReturnType<typeof Fastify> => {
  const app = Fastify();
  registerModelsRoute(app);
  return app;
};

describe('GET /v1/models', () => {
  it('возвращает список моделей в формате OpenAI', async () => {
    const app = buildApp();
    const response = await app.inject({ method: 'GET', url: '/v1/models' });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.object).toBe('list');
    expect(body.data.map((model: { id: string }) => model.id)).toEqual([
      'deepseek-web-chat',
      'deepseek-web-reasoner',
      'google-gemini-api-flash',
      'google-gemini-api-pro',
      'google-gemini-web',
    ]);
    for (const model of body.data) {
      expect(model.object).toBe('model');
      expect(typeof model.owned_by).toBe('string');
    }
  });

  it('сообщает capabilities.tools/function_calling/streaming', async () => {
    const app = buildApp();
    const response = await app.inject({ method: 'GET', url: '/v1/models' });

    for (const model of response.json().data) {
      expect(model.capabilities).toEqual({
        tools: true,
        function_calling: true,
        streaming: true,
      });
    }
  });
});
