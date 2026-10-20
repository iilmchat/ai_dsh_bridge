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
  readonly name?: string | undefined;
  readonly tool_call_id?: string | undefined;
  readonly tool_calls?: readonly OpenAiToolCall[] | undefined;
}

/** Описание инструмента в формате OpenAI. */
export interface OpenAiTool {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description?: string | undefined;
    /** JSON Schema параметров инструмента. */
    readonly parameters?: Readonly<Record<string, unknown>> | undefined;
  };
}

/** Тело запроса `POST /v1/chat/completions` (OpenAI-совместимое). */
export interface ChatCompletionRequest {
  model: string;
  messages: OpenAiMessage[];
  tools?: OpenAiTool[];
  tool_choice?:
    | 'auto'
    | 'none'
    | 'required'
    | { type: 'function'; function: { name: string } };
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
}

/** Ответ `POST /v1/chat/completions` в формате OpenAI. */
export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: OpenAiMessage & { tool_calls?: OpenAiToolCall[] };
    finish_reason: 'stop' | 'tool_calls' | 'length' | 'content_filter';
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}
