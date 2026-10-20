/**
 * AI DSH Bridge — точка входа L1 (OpenAI Facade).
 *
 * На этапе v0.6.0-alpha работают:
 * - `GET /health` — проверка живости;
 * - `GET /v1/models` — список моделей для Custom Provider DSH;
 * - `POST /v1/chat/completions` — чат в режимах `stream: false` и
 *   `stream: true` (OpenAI SSE, включая `tool_calls`).
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { registerCompletionsRoute } from './api/completions.js';
import { loadConfig, type BridgeConfig } from './config.js';

/** Версия каркаса; синхронизируется с `package.json` вручную. */
const APP_VERSION = '0.6.0-alpha';

/** Идентификаторы моделей, доступных DSH через шлюз. */
const MODEL_IDS = ['deepseek-web-chat', 'deepseek-web-reasoner'] as const;

/** Описание модели в формате OpenAI `GET /v1/models`. */
interface ModelCard {
  readonly id: string;
  readonly object: 'model';
  readonly created: number;
  readonly owned_by: string;
}

/** Ответ `GET /v1/models`. */
interface ModelsListResponse {
  readonly object: 'list';
  readonly data: readonly ModelCard[];
}

/** Ответ `GET /health`. */
interface HealthResponse {
  readonly status: 'ok';
  readonly version: string;
  readonly uptime_sec: number;
}

/**
 * Собирает экземпляр Fastify с маршрутами L1.
 * @returns Приложение и валидированная конфигурация.
 */
export const buildServer = async (): Promise<{
  app: FastifyInstance;
  config: BridgeConfig;
}> => {
  const config = loadConfig();
  const app = Fastify({ logger: { level: config.logLevel } });

  app.get('/health', (): HealthResponse => ({
    status: 'ok',
    version: APP_VERSION,
    uptime_sec: Math.round(process.uptime()),
  }));

  app.get('/v1/models', (): ModelsListResponse => ({
    object: 'list',
    data: MODEL_IDS.map((id) => ({
      id,
      object: 'model' as const,
      created: 0,
      owned_by: 'deepseek-web',
    })),
  }));

  await registerCompletionsRoute(app);

  return { app, config };
};

/** Запускает HTTP-сервер и регистрирует graceful shutdown. */
const main = async (): Promise<void> => {
  const { app, config } = await buildServer();

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
  };
  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  await app.listen({ port: config.port, host: '127.0.0.1' });
  app.log.info(`AI DSH Bridge v${APP_VERSION} listening on http://127.0.0.1:${config.port}`);
};

try {
  await main();
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Failed to start AI DSH Bridge: ${message}\n`);
  process.exitCode = 1;
}
