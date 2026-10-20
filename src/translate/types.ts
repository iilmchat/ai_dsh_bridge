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

/** Текстовая часть `content` (формат OpenAI content parts). */
export interface OpenAiTextContentPart {
  readonly type: 'text';
  readonly text: string;
}

/** Часть `image_url` (S3: изображение уходит в DeepSeek через `ref_file_ids`). */
export interface OpenAiImageUrlContentPart {
  readonly type: 'image_url';
  readonly image_url: {
    /** `data:image/...;base64,...` или `http(s)`-URL. */
    readonly url: string;
    readonly detail?: 'auto' | 'low' | 'high' | undefined;
  };
}

/** Часть `content` в формате OpenAI. */
export type OpenAiContentPart = OpenAiTextContentPart | OpenAiImageUrlContentPart;

/** Содержимое сообщения: строка, массив частей (vision) или `null`. */
export type OpenAiMessageContent = string | readonly OpenAiContentPart[] | null;

/** Сообщение диалога OpenAI. */
export interface OpenAiMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: OpenAiMessageContent;
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
