/**
 * Zod-схема тела `POST /v1/chat/completions` (OpenAI-совместимый запрос).
 *
 * `.strict()`: неизвестные поля отклоняются — шлюз явно фиксирует
 * поддерживаемый контракт (DESIGN § 7).
 */
import { z } from 'zod';

/** Схема сообщения OpenAI. */
const MessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string().nullable(),
  name: z.string().optional(),
  tool_call_id: z.string().optional(),
  tool_calls: z
    .array(
      z.object({
        id: z.string(),
        type: z.literal('function'),
        function: z.object({
          name: z.string(),
          arguments: z.string(),
        }),
      }),
    )
    .optional(),
});

/** Схема инструмента OpenAI. */
const ToolSchema = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
  }),
});

/** Схема запроса `POST /v1/chat/completions`. */
export const ChatCompletionRequestSchema = z
  .object({
    model: z.string().min(1),
    messages: z.array(MessageSchema).min(1),
    tools: z.array(ToolSchema).optional(),
    tool_choice: z
      .union([
        z.enum(['auto', 'none', 'required']),
        z.object({
          type: z.literal('function'),
          function: z.object({ name: z.string().min(1) }),
        }),
      ])
      .optional(),
    stream: z.boolean().optional().default(false),
    stream_options: z
      .object({
        include_usage: z.boolean().optional(),
      })
      .strict()
      .optional(),
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
    max_tokens: z.number().int().positive().optional(),
    max_completion_tokens: z.number().int().positive().optional(),
    frequency_penalty: z.number().min(-2).max(2).optional(),
    presence_penalty: z.number().min(-2).max(2).optional(),
    stop: z.union([z.string(), z.array(z.string())]).nullable().optional(),
    // Принимаются для совместимости с DSH/OpenAI, но DeepSeek Web API их
    // не поддерживает и шлюз их не использует.
    store: z.boolean().optional(),
    n: z.number().int().min(1).max(5).optional(),
    seed: z.number().int().optional(),
    response_format: z
      .object({
        type: z.enum(['text', 'json_object']),
      })
      .strict()
      .optional(),
    user: z.string().optional(),
    parallel_tool_calls: z.boolean().optional(),
  })
  .strict();

/** Тип запроса, выведенный из схемы. */
export type ChatCompletionRequestBody = z.infer<typeof ChatCompletionRequestSchema>;
