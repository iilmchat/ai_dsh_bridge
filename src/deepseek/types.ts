/**
 * Типы и Zod-схемы протокола DeepSeek (chat.deepseek.com).
 *
 * Источник: захваты 2026-10-19 (`docs/captures/`) и DESIGN § 4, § 6.
 * Схемы валидируют ответы upstream на границе L3 (RULES § 1: Zod на всех
 * границах).
 */
import { z } from 'zod';

/** Challenge от `POST /api/v0/chat/create_pow_challenge` (DESIGN § 4.1). */
export const PowChallengeSchema = z.object({
  algorithm: z.literal('DeepSeekHashV1'),
  challenge: z.string(),
  salt: z.string(),
  signature: z.string(),
  difficulty: z.number(),
  expire_at: z.number(),
  expire_after: z.number(),
  target_path: z.string(),
});

/** Валидированный PoW-challenge. */
export type PowChallenge = z.infer<typeof PowChallengeSchema>;

/** JSON внутри заголовка `x-ds-pow-response` (base64-encoded, DESIGN § 4.1). */
export const PowResponseSchema = z.object({
  algorithm: z.literal('DeepSeekHashV1'),
  challenge: z.string(),
  salt: z.string(),
  answer: z.number(),
  signature: z.string(),
  target_path: z.string(),
});

/** Валидированный PoW-ответ. */
export type PowResponse = z.infer<typeof PowResponseSchema>;

/** Тело запроса `POST /api/v0/chat/completion` (DESIGN § 6.3). */
export const ChatCompletionRequestSchema = z.object({
  chat_session_id: z.uuid(),
  parent_message_id: z.null(),
  model_type: z.enum(['default', 'reasoner']).default('default'),
  prompt: z.string(),
  ref_file_ids: z.array(z.string()).default([]),
  thinking_enabled: z.boolean().default(false),
  search_enabled: z.boolean().default(false),
  action: z.null(),
  preempt: z.boolean().default(false),
});

/** Валидированное тело запроса completion. */
export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>;
