/**
 * Сборка полного текста ответа DeepSeek из потока событий (non-streaming).
 *
 * DeepSeek стримит JSON Patch-события: начальный `SET response` содержит
 * фрагменты с текстом, `APPEND .../content` дописывает фрагменты, `text`
 * приходит как `{"v": "..."}`, а `BATCH` содержит `accumulated_token_usage`.
 */
import type { DeepSeekEvent } from '../deepseek/client.js';
import { DeepSeekApiError } from '../deepseek/errors.js';

/** Результат сборки текста. */
export interface AssembledText {
  /** Собранный текст ответа. */
  readonly text: string;
  /** `accumulated_token_usage` из BATCH-патча (или `null`, если не было). */
  readonly tokenUsage: number | null;
}

/** Проверяет, что значение — объект (type guard для `unknown`). */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/**
 * Извлекает содержимое фрагментов RESPONSE из начального объекта ответа.
 * @param payload Значение patch `{response: {fragments: [...]}}`.
 */
const extractInitialFragments = (payload: unknown): string | undefined => {
  if (!isRecord(payload)) {
    return undefined;
  }
  const response = payload['response'];
  if (!isRecord(response)) {
    return undefined;
  }
  const fragments = response['fragments'];
  if (!Array.isArray(fragments)) {
    return undefined;
  }
  let content = '';
  for (const fragment of fragments) {
    if (!isRecord(fragment) || fragment['type'] !== 'RESPONSE') {
      continue;
    }
    const value = fragment['content'];
    if (typeof value === 'string') {
      content += value;
    }
  }
  return content;
};

/**
 * Извлекает `accumulated_token_usage` из BATCH-патча.
 * @param value Значение `patch.value` (`[{p, v}, ...]`).
 */
const extractTokenUsage = (value: unknown): number | null => {
  if (!Array.isArray(value)) {
    return null;
  }
  for (const patch of value) {
    if (!isRecord(patch) || patch['p'] !== 'accumulated_token_usage') {
      continue;
    }
    const usage = patch['v'];
    if (typeof usage === 'number') {
      return usage;
    }
  }
  return null;
};

/**
 * Собирает текст ответа и token usage из потока DeepSeekEvent.
 *
 * @param events Асинхронный поток событий `sendChatAsync`.
 * @returns `{ text, tokenUsage }`.
 * @throws DeepSeekApiError если в потоке пришло `error`-событие.
 */
export const assembleTextFromEvents = async (
  events: AsyncIterable<DeepSeekEvent>,
): Promise<AssembledText> => {
  let text = '';
  let tokenUsage: number | null = null;

  for await (const event of events) {
    switch (event.type) {
      case 'text': {
        text += event.content;
        break;
      }
      case 'patch': {
        if (event.op === 'SET' && event.path === 'response') {
          const initial = extractInitialFragments(event.value);
          if (initial !== undefined) {
            text += initial;
          }
          break;
        }
        if (event.op === 'APPEND' && event.path.endsWith('/content') && typeof event.value === 'string') {
          text += event.value;
          break;
        }
        if (event.op === 'BATCH') {
          const usage = extractTokenUsage(event.value);
          if (usage !== null) {
            tokenUsage = usage;
          }
        }
        break;
      }
      case 'error': {
        throw new DeepSeekApiError(event.code, event.message);
      }
      default: {
        break;
      }
    }
  }

  return { text, tokenUsage };
};
