/**
 * `GET /v1/models`: список моделей для Custom Provider DSH.
 *
 * В карточку добавлены `capabilities` (`tools`, `function_calling`,
 * `streaming`): DSH проверяет их, прежде чем передавать `tools` в
 * `/v1/chat/completions`. Без этого инструменты могут не отправляться.
 */
import type { FastifyInstance } from 'fastify';

/** Идентификаторы моделей, доступных DSH через шлюз. */
const MODEL_IDS = ['deepseek-web-chat', 'deepseek-web-reasoner'] as const;

/** Возможности модели (как их понимает DSH/OpenAI-клиент). */
export interface ModelCapabilities {
  readonly tools: boolean;
  readonly function_calling: boolean;
  readonly streaming: boolean;
}

/** Описание модели в формате OpenAI `GET /v1/models`. */
export interface ModelCard {
  readonly id: string;
  readonly object: 'model';
  readonly created: number;
  readonly owned_by: string;
  readonly capabilities: ModelCapabilities;
}

/** Ответ `GET /v1/models`. */
export interface ModelsListResponse {
  readonly object: 'list';
  readonly data: readonly ModelCard[];
}

/** Возможности, одинаковые для всех моделей шлюза. */
const CAPABILITIES: ModelCapabilities = {
  tools: true,
  function_calling: true,
  streaming: true,
};

/**
 * Регистрирует маршрут `GET /v1/models`.
 * @param app Fastify-инстанс.
 */
export const registerModelsRoute = (app: FastifyInstance): void => {
  app.get('/v1/models', (): ModelsListResponse => ({
    object: 'list',
    data: MODEL_IDS.map((id) => ({
      id,
      object: 'model' as const,
      created: 0,
      owned_by: 'deepseek-web',
      capabilities: CAPABILITIES,
    })),
  }));
};
