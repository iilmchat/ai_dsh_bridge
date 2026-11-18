/**
 * Реестр моделей шлюза.
 *
 * Единственное место, где сопоставляются OpenAI-идентификатор модели,
 * upstream-провайдер и имя модели у провайдера. `GET /v1/models` и
 * `POST /v1/chat/completions` читают реестр, поэтому добавление модели —
 * одна строка в `PROVIDER_MODELS` (ARCHITECTURE § 8.1).
 */
import type { ProviderId } from './types.js';

/** Описание модели, доступной DSH через шлюз. */
export interface ProviderModel {
  /** Идентификатор модели в OpenAI-формате (`model` в запросе DSH). */
  readonly id: string;
  /** Upstream-провайдер, обслуживающий модель. */
  readonly provider: ProviderId;
  /** Имя модели у провайдера (для Google — `gemini-2.5-flash` и т.п.). */
  readonly upstreamModel: string;
  /** Человекочитаемое имя (для документации и логов). */
  readonly displayName: string;
}

/**
 * Модели шлюза.
 *
 * DeepSeek — веб-чат `chat.deepseek.com` (DSML-эмуляция инструментов).
 * Gemini API — официальный `generativelanguage.googleapis.com` (ключ).
 * Gemini Web — веб-чат `gemini.google.com` (cookie-сессия, без ключа).
 */
export const PROVIDER_MODELS = [
  {
    id: 'deepseek-web-chat',
    provider: 'deepseek-web',
    upstreamModel: 'default',
    displayName: 'DeepSeek Web Chat',
  },
  {
    id: 'deepseek-web-reasoner',
    provider: 'deepseek-web',
    upstreamModel: 'reasoner',
    displayName: 'DeepSeek Web Reasoner',
  },
  {
    id: 'google-gemini-api-flash',
    provider: 'google-gemini-api',
    upstreamModel: 'gemini-2.5-flash',
    displayName: 'Gemini API (Flash)',
  },
  {
    id: 'google-gemini-api-pro',
    provider: 'google-gemini-api',
    upstreamModel: 'gemini-2.5-pro',
    displayName: 'Gemini API (Pro)',
  },
  {
    id: 'google-gemini-web',
    provider: 'google-gemini-web',
    upstreamModel: 'gemini-web',
    displayName: 'Gemini Web Chat',
  },
  {
    id: 'google-gemini-web-flash',
    provider: 'google-gemini-web',
    upstreamModel: 'gemini-2.5-flash',
    displayName: 'Gemini Web Chat (Flash)',
  },
  {
    id: 'google-gemini-web-pro',
    provider: 'google-gemini-web',
    upstreamModel: 'gemini-2.5-pro',
    displayName: 'Gemini Web Chat (Pro)',
  },
] as const satisfies readonly ProviderModel[];

/**
 * Находит модель по идентификатору.
 * @param id Идентификатор модели из запроса DSH.
 * @returns Описание модели или `undefined`, если модель не поддерживается.
 */
export const resolveProviderModel = (id: string): ProviderModel | undefined =>
  PROVIDER_MODELS.find((model) => model.id === id);

/**
 * Возвращает все модели шлюза.
 * @returns Неизменяемый список моделей в порядке реестра.
 */
export const listProviderModels = (): readonly ProviderModel[] => PROVIDER_MODELS;

/**
 * Возвращает идентификаторы всех моделей (для сообщений об ошибке).
 * @returns Список `model.id`.
 */
export const listProviderModelIds = (): readonly string[] =>
  PROVIDER_MODELS.map((model) => model.id);
