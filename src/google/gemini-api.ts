/**
 * Клиент официального Gemini API (L3): `generativelanguage.googleapis.com`.
 *
 * Авторизация — API-ключ из `GEMINI_API_KEY` (заголовок `x-goog-api-key`, чтобы
 * ключ не попадал в URL и логи). Инструменты не передаются нативно в
 * `tools[]`: L2 уже внедрил DSML-инструкцию в текст, поэтому ответ приходит
 * обычным текстом и разбирается общим DSML-парсером (ARCHITECTURE § 8.1).
 *
 * Используется не-streaming метод `:generateContent`: шлюз всё равно собирает
 * ответ целиком перед отдачей SSE (DESIGN § 5.3).
 */
import { z } from 'zod';
import {
  ProviderNotConfiguredError,
  ProviderRequestError,
  type ChatProvider,
  type ProviderCompletionRequest,
  type ProviderCompletionResult,
  type ProviderUsage,
} from '../providers/types.js';
import { combineSignals, errorMessage, isAbortError, type FetchAsync } from './http.js';

/** Базовый URL Gemini API по умолчанию. */
export const GEMINI_API_BASE_URL = 'https://generativelanguage.googleapis.com';

/** Таймаут запроса по умолчанию: генерация может быть долгой. */
const DEFAULT_TIMEOUT_MS = 120_000;

/** Ограничение длины текста ошибки upstream, попадающего клиенту. */
const MAX_ERROR_LENGTH = 300;

/** Часть ответа кандидата. */
const PartSchema = z.object({
  text: z.string().optional(),
  /** Внутренние рассуждения модели (thinking) не являются ответом. */
  thought: z.boolean().optional(),
});

/** Кандидат ответа Gemini. */
const CandidateSchema = z.object({
  content: z.object({ parts: z.array(PartSchema).optional() }).optional(),
  finishReason: z.string().optional(),
});

/** Ответ `:generateContent` (валидируются только используемые поля). */
const GeminiResponseSchema = z.object({
  candidates: z.array(CandidateSchema).optional(),
  promptFeedback: z.object({ blockReason: z.string().optional() }).optional(),
  usageMetadata: z
    .object({
      promptTokenCount: z.number().optional(),
      candidatesTokenCount: z.number().optional(),
    })
    .optional(),
});

/** Тело запроса `:generateContent`. */
interface GeminiRequestBody {
  readonly contents: readonly { readonly role: 'user'; readonly parts: readonly { readonly text: string }[] }[];
  readonly systemInstruction?: { readonly parts: readonly { readonly text: string }[] } | undefined;
  readonly generationConfig?:
    | {
        readonly temperature?: number | undefined;
        readonly maxOutputTokens?: number | undefined;
      }
    | undefined;
}

/** Зависимости фабрики клиента (для тестов). */
export interface GeminiApiProviderOptions {
  /** API-ключ Google AI Studio (если не задан — провайдер не настроен). */
  readonly apiKey: string | undefined;
  /** Базовый URL (по умолчанию `https://generativelanguage.googleapis.com`). */
  readonly baseUrl?: string | undefined;
  /** Таймаут запроса, мс. */
  readonly timeoutMs?: number | undefined;
  /** Функция HTTP-запроса (по умолчанию `fetch`). */
  readonly fetchImpl?: FetchAsync | undefined;
}

/** Проверяет, что значение — объект (type guard для `unknown`). */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/**
 * Маппит HTTP-статус Gemini API в статус для DSH.
 *
 * 401/403 — нужна повторная настройка ключа; 429 и 5xx — временный сбой
 * (DSH может повторить); остальные 4xx — ошибка запроса upstream.
 *
 * @param status HTTP-статус ответа Google.
 */
const mapStatus = (status: number): number => {
  if (status === 401 || status === 403) {
    return 401;
  }
  if (status === 429 || (status >= 500 && status < 600)) {
    return 503;
  }
  return 502;
};

/**
 * Извлекает сообщение об ошибке из тела ответа Gemini API.
 * @param bodyText Тело ответа (JSON или текст).
 * @returns Безопасное короткое сообщение.
 */
const parseErrorMessage = (bodyText: string): string => {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (isRecord(parsed)) {
      const error = parsed['error'];
      if (isRecord(error) && typeof error['message'] === 'string' && error['message'] !== '') {
        return error['message'].slice(0, MAX_ERROR_LENGTH);
      }
    }
  } catch {
    // Не JSON — вернём усечённый текст ниже.
  }
  const trimmed = bodyText.trim();
  return trimmed === '' ? 'без описания' : trimmed.slice(0, MAX_ERROR_LENGTH);
};

/**
 * Создаёт провайдер Gemini API.
 * @param options API-ключ, базовый URL, таймаут и HTTP-клиент.
 * @returns Провайдер с `id: 'google-gemini-api'`.
 */
export const createGeminiApiProvider = (options: GeminiApiProviderOptions): ChatProvider => {
  const baseUrl = (options.baseUrl ?? GEMINI_API_BASE_URL).replace(/\/+$/u, '');
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const apiKey = options.apiKey;
  const isConfigured = apiKey !== undefined && apiKey !== '';

  const completeAsync = async (
    request: ProviderCompletionRequest,
  ): Promise<ProviderCompletionResult> => {
    if (apiKey === undefined || apiKey === '') {
      throw new ProviderNotConfiguredError(
        'GEMINI_API_KEY не задан. Укажите ключ Google AI Studio в .env и перезапустите шлюз.',
      );
    }

    const generationConfig = {
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(request.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: request.maxOutputTokens }),
    };
    const requestBody: GeminiRequestBody = {
      contents: [{ role: 'user', parts: [{ text: request.conversation }] }],
      ...(request.system === ''
        ? {}
        : { systemInstruction: { parts: [{ text: request.system }] } }),
      ...(Object.keys(generationConfig).length === 0 ? {} : { generationConfig }),
    };

    const url = `${baseUrl}/v1beta/models/${encodeURIComponent(request.upstreamModel)}:generateContent`;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify(requestBody),
        signal: combineSignals(request.signal, timeoutMs),
      });
    } catch (error: unknown) {
      if (isAbortError(error)) {
        throw new ProviderRequestError(
          `Gemini API не ответил за ${String(timeoutMs)} мс`,
          504,
        );
      }
      throw new ProviderRequestError(
        `Не удалось подключиться к Gemini API: ${errorMessage(error)}`,
        502,
      );
    }

    const bodyText = await response.text();
    if (!response.ok) {
      throw new ProviderRequestError(
        `Gemini API ${String(response.status)}: ${parseErrorMessage(bodyText)}`,
        mapStatus(response.status),
      );
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(bodyText) as unknown;
    } catch {
      throw new ProviderRequestError('Gemini API вернул не-JSON ответ', 502);
    }
    const parsed = GeminiResponseSchema.safeParse(parsedJson);
    if (!parsed.success) {
      throw new ProviderRequestError('Не удалось разобрать ответ Gemini API', 502);
    }

    const candidate = parsed.data.candidates?.[0];
    const text = (candidate?.content?.parts ?? [])
      .filter((part) => part.thought !== true && typeof part.text === 'string')
      .map((part) => part.text ?? '')
      .join('');
    if (text === '') {
      const blockReason = parsed.data.promptFeedback?.blockReason;
      if (blockReason !== undefined) {
        throw new ProviderRequestError(
          `Gemini заблокировал запрос (${blockReason})`,
          400,
        );
      }
      throw new ProviderRequestError('Gemini API вернул пустой ответ', 502);
    }

    const usage: ProviderUsage = {
      promptTokens: parsed.data.usageMetadata?.promptTokenCount ?? 0,
      completionTokens: parsed.data.usageMetadata?.candidatesTokenCount ?? 0,
    };
    return { text, usage };
  };

  return {
    id: 'google-gemini-api',
    isConfiguredAsync: async (): Promise<boolean> => isConfigured,
    completeAsync,
  };
};
