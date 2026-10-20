/**
 * Типы OpenAI-совместимого запроса для слоя трансляции (L2).
 *
 * Используются Prompt Builder'ом: сообщения DSH и описания инструментов в
 * формате OpenAI `messages[]`/`tools[]` (DESIGN § 6).
 */

/** Вызов инструмента в сообщении assistant (формат OpenAI). */
export interface OpenAiToolCall {
  readonly id: string;
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly arguments: string;
  };
}

/** Сообщение диалога OpenAI. */
export interface OpenAiMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string | null;
  readonly name?: string;
  readonly tool_call_id?: string;
  readonly tool_calls?: readonly OpenAiToolCall[];
}

/** Описание инструмента в формате OpenAI. */
export interface OpenAiTool {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description?: string;
    /** JSON Schema параметров инструмента. */
    readonly parameters?: Readonly<Record<string, unknown>>;
  };
}
