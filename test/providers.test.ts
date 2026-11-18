/**
 * Тесты реестра моделей: сопоставление id → провайдер/upstream-модель и
 * список моделей для `GET /v1/models`.
 */
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerModelsRoute } from '../src/api/models.js';
import {
  listProviderModelIds,
  listProviderModels,
  resolveProviderModel,
} from '../src/providers/model-registry.js';

/** Создаёт Fastify-приложение с маршрутом моделей. */
const buildApp = (): ReturnType<typeof Fastify> => {
  const app = Fastify();
  registerModelsRoute(app);
  return app;
};

describe('model registry', () => {
  it('содержит модели DeepSeek и Google', () => {
    expect(listProviderModelIds()).toEqual([
      'deepseek-web-chat',
      'deepseek-web-reasoner',
      'google-gemini-api-flash',
      'google-gemini-api-pro',
      'google-gemini-web',
      'google-gemini-web-flash',
      'google-gemini-web-pro',
    ]);
  });

  it('первая модель — deepseek-web-chat (исторический default DSH)', () => {
    expect(listProviderModels()[0]?.id).toBe('deepseek-web-chat');
  });

  it('сопоставляет Google-модели с upstream-именами', () => {
    expect(resolveProviderModel('google-gemini-api-flash')).toMatchObject({
      provider: 'google-gemini-api',
      upstreamModel: 'gemini-2.5-flash',
    });
    expect(resolveProviderModel('google-gemini-api-pro')).toMatchObject({
      provider: 'google-gemini-api',
      upstreamModel: 'gemini-2.5-pro',
    });
    expect(resolveProviderModel('google-gemini-web')).toMatchObject({
      provider: 'google-gemini-web',
      upstreamModel: 'gemini-web',
    });
    expect(resolveProviderModel('google-gemini-web-flash')).toMatchObject({
      provider: 'google-gemini-web',
      upstreamModel: 'gemini-2.5-flash',
    });
    expect(resolveProviderModel('google-gemini-web-pro')).toMatchObject({
      provider: 'google-gemini-web',
      upstreamModel: 'gemini-2.5-pro',
    });
  });

  it('возвращает undefined для неизвестной модели', () => {
    expect(resolveProviderModel('gpt-4o')).toBeUndefined();
  });
});

describe('GET /v1/models', () => {
  it('возвращает все модели реестра в формате OpenAI', async () => {
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
      'google-gemini-web-flash',
      'google-gemini-web-pro',
    ]);
    for (const model of body.data) {
      expect(model.object).toBe('model');
      expect(model.owned_by).toBe(resolveProviderModel(model.id)?.provider);
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
