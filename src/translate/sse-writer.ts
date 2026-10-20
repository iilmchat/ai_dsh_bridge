/**
 * OpenAI-совместимый SSE-генератор (K2).
 *
 * Ключевое правило (DESIGN § 5.3): `id` и `name` инструмента отправляются
 * **только в первом чанке** `tool_calls` для данного `index`. В
 * continuation-чанках этих полей нет вовсе (не пустые строки) — иначе DSH
 * перезапишет идентичность и вернёт `UNKNOWN_TOOL`.
 */
import type { OpenAiToolCall } from './types.js';

/** Usage в финальном чанке (как в OpenAI streaming). */
export interface OpenAiSseUsage {
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
  readonly total_tokens: number;
}

/** Параметры генератора SSE. */
export interface WriteOpenAiSseParams {
  /** `chatcmpl-...`, один на весь ответ. */
  readonly id: string;
  readonly model: string;
  readonly content: string | null;
  readonly toolCalls: readonly OpenAiToolCall[];
  /** Размер чанка content (по умолчанию 1 символ). */
  readonly chunkSize?: number;
  /** Unix-время; по умолчанию текущее. */
  readonly created?: number;
  /** Usage для `stream_options.include_usage`. */
  readonly usage?: OpenAiSseUsage;
  /** Добавить финальный чанк с usage. */
  readonly includeUsage?: boolean;
}

/**
 * Делит строку на куски по code points (не ломает суррогатные пары).
 * @param value Исходная строка.
 * @param size Размер куска (≥1).
 */
const splitIntoChunks = (value: string, size: number): string[] => {
  const points = Array.from(value);
  const chunks: string[] = [];
  for (let index = 0; index < points.length; index += size) {
    chunks.push(points.slice(index, index + size).join(''));
  }
  return chunks;
};

/**
 * Генерирует OpenAI-совместимый SSE из текста и/или tool_calls.
 *
 * @param params id, model, content, toolCalls, chunkSize и опции usage.
 * @returns Строки SSE вида `data: ...\n\n`, последняя — `data: [DONE]`.
 */
export function* writeOpenAiSse(params: WriteOpenAiSseParams): Generator<string> {
  const created = params.created ?? Math.floor(Date.now() / 1000);
  const contentChunkSize = Math.max(1, Math.trunc(params.chunkSize ?? 1));
  const argumentChunkSize = Math.max(8, contentChunkSize);
  const base = {
    id: params.id,
    object: 'chat.completion.chunk',
    created,
    model: params.model,
  };

  /** Формирует SSE-фрейм с delta и finish_reason. */
  const frame = (delta: unknown, finishReason: string | null = null): string =>
    `data: ${JSON.stringify({
      ...base,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`;

  yield frame({ role: 'assistant' }, null);

  if (params.content !== null && params.content !== '') {
    for (const piece of splitIntoChunks(params.content, contentChunkSize)) {
      yield frame({ content: piece });
    }
  }

  for (const [index, call] of params.toolCalls.entries()) {
    // Первый чанк вызова — единственный, где есть id и name.
    yield frame({
      tool_calls: [
        {
          index,
          id: call.id,
          type: 'function',
          function: { name: call.function.name, arguments: '' },
        },
      ],
    });
    for (const piece of splitIntoChunks(call.function.arguments, argumentChunkSize)) {
      // Continuation: только index и фрагмент arguments, без id/name.
      yield frame({ tool_calls: [{ index, function: { arguments: piece } }] });
    }
  }

  yield frame({}, params.toolCalls.length > 0 ? 'tool_calls' : 'stop');

  if (params.includeUsage === true && params.usage !== undefined) {
    yield `data: ${JSON.stringify({ ...base, choices: [], usage: params.usage })}\n\n`;
  }

  yield 'data: [DONE]\n\n';
}
