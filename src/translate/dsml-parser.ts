/**
 * DSML-парсер (non-streaming).
 *
 * Извлекает `tool_calls` из полного текста ответа DeepSeek, который модель
 * сгенерировала по DSML-инструкции Prompt Builder'а (DESIGN § 5.1–5.2).
 *
 * Fail-safe: при незакрытых параметрах/инструментах, параметре без имени или
 * DSML-маркере внутри значения вызов **не создаётся** — возвращается
 * warning, а не «полувызов» (DESIGN § 8.2).
 */
import { randomBytes } from 'node:crypto';
import type { OpenAiToolCall } from './types.js';

/** Результат разбора DSML. */
export interface ParsedDsml {
  /** Текст без DSML-блоков. */
  readonly text: string;
  /** Извлечённые вызовы (пусто, если DSML не найден). */
  readonly tool_calls: OpenAiToolCall[];
  /** Диагностика отклонений (для логов). */
  readonly warnings: string[];
}

/** Маркер DSML. */
const MARKER = '<｜DSML｜';

/** Открывающий/закрывающий теги wrapper'а. */
const WRAPPER_OPEN = `${MARKER}tool_calls>`;
const WRAPPER_CLOSE = `</｜DSML｜tool_calls>`;

/** Теги invoke. */
const INVOKE_CLOSE = `</｜DSML｜invoke>`;

/** Теги parameter. */
const PARAM_CLOSE = `</｜DSML｜parameter>`;

/** Регулярка открывающего invoke (атрибуты внутри). */
const INVOKE_OPEN_RE = /<｜DSML｜invoke\b([^>]*)>/u;

/** Регулярка открывающего parameter (атрибуты внутри). */
const PARAM_OPEN_RE = /<｜DSML｜parameter\b([^>]*)>/u;

/** Регулярка для нормализации pipe-маркеров в открывающих тегах. */
const OPEN_PIPES_RE = /<[｜]{2,}DSML[｜]+/gu;

/** Регулярка для нормализации pipe-маркеров в закрывающих тегах. */
const CLOSE_PIPES_RE = /<\/[｜]{2,}DSML[｜]+/gu;

/** Регулярка для пробельных структурных слов (`<｜DSML｜ calls>`). */
const SPACED_CALLS_RE = /<｜DSML｜\s*tool[\s_]*calls\s*>/gu;

/** Регулярка для сокращённого `<｜DSML｜ calls>` (без слова `tool`). */
const SHORT_CALLS_RE = /<｜DSML｜\s*calls\s*>/gu;

/** Удаление остаточных DSML-тегов из текста. */
const RESIDUAL_TAG_RE = /<｜DSML｜[^>]*>/gu;

/** Диапазон вырезаемого фрагмента. */
interface TextRange {
  readonly start: number;
  readonly end: number;
}

/**
 * Нормализует DSML-разметку: двойные pipe-маркеры и пробельные структурные
 * слова приводятся к каноническому виду (DESIGN § 5.2).
 * @param input Исходный текст.
 */
export const normalizeDsml = (input: string): string =>
  input
    .replaceAll('<｜｜DSML｜｜>', MARKER)
    .replaceAll('<｜DSML｜｜>', MARKER)
    .replaceAll('<｜｜DSML｜>', MARKER)
    .replaceAll('</｜｜DSML｜｜>', '</｜DSML｜>')
    .replaceAll('</｜DSML｜｜>', '</｜DSML｜>')
    .replaceAll('</｜｜DSML｜>', '</｜DSML｜>')
    .replace(OPEN_PIPES_RE, MARKER)
    .replace(CLOSE_PIPES_RE, '</｜DSML｜')
    .replace(SPACED_CALLS_RE, WRAPPER_OPEN)
    .replace(SHORT_CALLS_RE, WRAPPER_OPEN);

/**
 * Генерирует уникальный `id` вызова: `call_` + 12 символов base36.
 */
const randomCallId = (): string => {
  const value = BigInt(`0x${randomBytes(8).toString('hex')}`);
  const suffix = value.toString(36).padStart(12, '0').slice(0, 12);
  return `call_${suffix}`;
};

/**
 * Разбирает атрибуты тега вида `name="bash" string="true"`.
 * @param raw Строка атрибутов.
 */
const parseAttributes = (raw: string): Record<string, string> => {
  const attributes: Record<string, string> = {};
  const pattern = /([A-Za-z_][\w-]*)\s*=\s*"([^"]*)"/gu;
  let match = pattern.exec(raw);
  while (match !== null) {
    const key = match[1];
    const value = match[2];
    if (key !== undefined && value !== undefined) {
      attributes[key] = value;
    }
    match = pattern.exec(raw);
  }
  return attributes;
};

/**
 * Разбирает значение параметра: `string="true"` оставляет строкой,
 * иначе — JSON.parse с fallback на строку.
 * @param raw Сырое значение.
 * @param isString Флаг `string="true"`.
 */
const parseParameterValue = (raw: string, isString: boolean): unknown => {
  if (isString) {
    return raw;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed;
  } catch {
    return raw;
  }
};

/** Результат разбора содержимого invoke. */
interface InvokeContentResult {
  readonly ok: boolean;
  readonly args: Record<string, unknown>;
}

/**
 * Разбирает параметры внутри `<｜DSML｜invoke>`.
 * @param content Содержимое invoke без открывающего/закрывающего тегов.
 * @param warnings Массив для диагностики.
 */
const parseInvokeContent = (
  content: string,
  warnings: string[],
): InvokeContentResult => {
  const args: Record<string, unknown> = {};
  let cursor = 0;

  while (cursor < content.length) {
    const tail = content.slice(cursor);
    const openMatch = PARAM_OPEN_RE.exec(tail);
    if (openMatch === null) {
      if (tail.trim() !== '') {
        warnings.push('unexpected content in invoke');
      }
      break;
    }
    const openIndex = cursor + openMatch.index;
    const openEnd = openIndex + openMatch[0].length;
    const attributes = parseAttributes(openMatch[1] ?? '');
    const paramName = attributes['name'];
    if (paramName === undefined || paramName === '') {
      warnings.push('parameter without name');
      return { ok: false, args };
    }

    const closeIndex = content.indexOf(PARAM_CLOSE, openEnd);
    if (closeIndex === -1) {
      warnings.push('unclosed parameter');
      return { ok: false, args };
    }
    const rawValue = content.slice(openEnd, closeIndex);
    if (rawValue.includes(MARKER)) {
      warnings.push('DSML marker inside parameter value');
      return { ok: false, args };
    }
    args[paramName] = parseParameterValue(rawValue, attributes['string'] === 'true');
    cursor = closeIndex + PARAM_CLOSE.length;
  }

  return { ok: true, args };
};

/** Результат разбора одного invoke. */
interface ParsedInvoke {
  readonly call?: OpenAiToolCall;
  readonly range: TextRange;
}

/**
 * Разбирает один `invoke` (содержимое уже ограничено закрывающим тегом).
 * @param openMatch Совпадение открывающего тега (атрибуты — `[1]`).
 * @param content Содержимое invoke.
 * @param invokeStart Абсолютное начало invoke.
 * @param invokeEnd Абсолютный конец (после `</invoke>`).
 * @param warnings Массив диагностики.
 */
const parseInvoke = (
  openMatch: RegExpExecArray,
  content: string,
  invokeStart: number,
  invokeEnd: number,
  warnings: string[],
): ParsedInvoke => {
  const range: TextRange = { start: invokeStart, end: invokeEnd };
  const attributes = parseAttributes(openMatch[1] ?? '');
  const name = attributes['name'];
  if (name === undefined || name === '') {
    warnings.push('invoke without name');
    return { range };
  }
  const parsedContent = parseInvokeContent(content, warnings);
  if (!parsedContent.ok) {
    return { range };
  }
  return {
    range,
    call: {
      id: randomCallId(),
      type: 'function',
      function: {
        name,
        arguments: JSON.stringify(parsedContent.args),
      },
    },
  };
};

/** Результат разбора сегмента с invoke'ами. */
interface InvokeSegmentResult {
  readonly calls: OpenAiToolCall[];
  readonly ranges: TextRange[];
}

/**
 * Находит и разбирает все `invoke` в сегменте текста.
 * @param segment Сегмент текста.
 * @param baseOffset Смещение сегмента в исходном тексте.
 * @param warnings Массив диагностики.
 */
const parseInvokesInSegment = (
  segment: string,
  baseOffset: number,
  warnings: string[],
): InvokeSegmentResult => {
  const calls: OpenAiToolCall[] = [];
  const ranges: TextRange[] = [];
  let cursor = 0;

  while (cursor < segment.length) {
    const tail = segment.slice(cursor);
    const openMatch = INVOKE_OPEN_RE.exec(tail);
    if (openMatch === null) {
      break;
    }
    const invokeStart = baseOffset + cursor + openMatch.index;
    const contentStart = cursor + openMatch.index + openMatch[0].length;
    const closeIndex = segment.indexOf(INVOKE_CLOSE, contentStart);
    if (closeIndex === -1) {
      warnings.push('unclosed invoke');
      ranges.push({ start: invokeStart, end: baseOffset + segment.length });
      break;
    }
    const invokeEnd = baseOffset + closeIndex + INVOKE_CLOSE.length;
    const parsed = parseInvoke(
      openMatch,
      segment.slice(contentStart, closeIndex),
      invokeStart,
      invokeEnd,
      warnings,
    );
    ranges.push(parsed.range);
    if (parsed.call !== undefined) {
      calls.push(parsed.call);
    }
    cursor = closeIndex + INVOKE_CLOSE.length;
  }

  return { calls, ranges };
};

/**
 * Объединяет и нормализует диапазоны вырезания.
 * @param ranges Диапазоны (могут пересекаться).
 */
const mergeRanges = (ranges: readonly TextRange[]): TextRange[] => {
  const sorted = [...ranges].toSorted((left, right) => left.start - right.start);
  const merged: TextRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && range.start <= last.end) {
      merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, range.end) };
      continue;
    }
    merged.push({ ...range });
  }
  return merged;
};

/**
 * Удаляет DSML-диапазоны из текста и возвращает оставшийся текст.
 * @param text Нормализованный текст.
 * @param ranges Диапазоны DSML.
 */
const extractText = (text: string, ranges: readonly TextRange[]): string => {
  const merged = mergeRanges(ranges);
  let result = '';
  let position = 0;
  for (const range of merged) {
    if (range.start > position) {
      result += text.slice(position, range.start);
    }
    position = Math.max(position, range.end);
  }
  if (position < text.length) {
    result += text.slice(position);
  }
  return result.replace(RESIDUAL_TAG_RE, '').trim();
};

/**
 * Удаляет из текста остатки DSML-маркеров (открывающие/закрывающие теги
 * tool_calls, invoke, parameter), даже если вызов невалиден.
 *
 * @param text Текст после вырезания DSML-блоков.
 * @returns Текст без любых DSML-маркеров.
 */
const stripDsmlMarkers = (text: string): string =>
  text
    .replace(/<｜DSML｜[^>]*>/gu, '')
    .replace(/<\/｜DSML｜[^>]*>/gu, '')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();

/**
 * Извлекает DSML-блоки из текста и возвращает OpenAI-совместимые tool_calls.
 *
 * @param text Полный текст ответа DeepSeek.
 * @returns `{ text, tool_calls, warnings }`.
 */
export const parseDsml = (text: string): ParsedDsml => {
  const normalized = normalizeDsml(text);
  const warnings: string[] = [];
  const calls: OpenAiToolCall[] = [];
  const ranges: TextRange[] = [];

  let wrapperFound = false;
  let searchFrom = 0;
  while (searchFrom < normalized.length) {
    const start = normalized.indexOf(WRAPPER_OPEN, searchFrom);
    if (start === -1) {
      break;
    }
    wrapperFound = true;
    const closeIndex = normalized.indexOf(WRAPPER_CLOSE, start + WRAPPER_OPEN.length);
    const contentStart = start + WRAPPER_OPEN.length;
    if (closeIndex === -1) {
      warnings.push('unclosed tool_calls wrapper');
      const segment = parseInvokesInSegment(
        normalized.slice(contentStart),
        contentStart,
        warnings,
      );
      calls.push(...segment.calls);
      ranges.push(...segment.ranges, { start, end: normalized.length });
      searchFrom = normalized.length;
      break;
    }
    const segment = parseInvokesInSegment(
      normalized.slice(contentStart, closeIndex),
      contentStart,
      warnings,
    );
    calls.push(...segment.calls);
    ranges.push(...segment.ranges, { start, end: closeIndex + WRAPPER_CLOSE.length });
    searchFrom = closeIndex + WRAPPER_CLOSE.length;
  }

  if (!wrapperFound) {
    const fallback = parseInvokesInSegment(normalized, 0, warnings);
    if (fallback.calls.length > 0) {
      warnings.push('missing tool_calls wrapper');
    }
    calls.push(...fallback.calls);
    ranges.push(...fallback.ranges);
  }

  return {
    text: stripDsmlMarkers(extractText(normalized, ranges)),
    tool_calls: calls,
    warnings,
  };
};
