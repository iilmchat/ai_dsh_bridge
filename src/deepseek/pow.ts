/**
 * PoW-решатель DeepSeek (алгоритм `DeepSeekHashV1`).
 *
 * Challenge приходит от `POST /api/v0/chat/create_pow_challenge`; ответ
 * уходит в заголовке `x-ds-pow-response` как base64 от JSON (DESIGN § 4).
 *
 * Правило: challenge запрашивается под конкретный `target_path`
 * (`/api/v0/chat/completion`), кэшировать PoW между эндпоинтами нельзя.
 */
import { findDeepSeekPowNonceAsync, MAX_DEEPSEEK_POW_DIFFICULTY } from './deepseek-hash.js';
import { PowNotSolvedError } from './errors.js';
import type { PowChallenge, PowResponse } from './types.js';

/** Опции решения PoW. */
export interface SolvePowOptions {
  /** Отмена поиска (например, по таймауту HTTP-запроса). */
  readonly signal?: AbortSignal;
  /** Сколько nonce проверять между уступами event loop. */
  readonly yieldEvery?: number;
  /**
   * `target_path`, для которого решается PoW. Передаётся всегда явно:
   * ответ сервера challenge может содержать другой `target_path`
   * (в захвате 2026-10-19 сервер вернул `/api/v0/file/upload_file`).
   */
  readonly targetPath?: string;
  /** Колбэк для логирования времени решения (без секретов). */
  readonly onSolved?: (info: { readonly answer: number; readonly elapsedMs: number }) => void;
}

/**
 * Решает PoW-challenge и собирает объект для заголовка `x-ds-pow-response`.
 *
 * @param challenge Challenge от DeepSeek.
 * @param options Отмена, размер чанка, колбэк логирования.
 * @returns Ответ PoW (algorithm/challenge/salt/answer/signature/target_path).
 * @throws PowNotSolvedError если ответ не найден или challenge некорректен.
 */
export const solvePowAsync = async (
  challenge: PowChallenge,
  options: SolvePowOptions = {},
): Promise<PowResponse> => {
  if (challenge.algorithm !== 'DeepSeekHashV1') {
    throw new PowNotSolvedError(`Неподдерживаемый алгоритм PoW: ${String(challenge.algorithm)}`);
  }
  if (
    !Number.isSafeInteger(challenge.difficulty) ||
    challenge.difficulty < 1 ||
    challenge.difficulty > MAX_DEEPSEEK_POW_DIFFICULTY
  ) {
    throw new PowNotSolvedError(
      `Некорректная difficulty: ${String(challenge.difficulty)} (ожидается 1–${MAX_DEEPSEEK_POW_DIFFICULTY})`,
    );
  }

  const prefix = `${challenge.salt}_${challenge.expire_at}_`;
  const startedAt = performance.now();
  const answer = await findDeepSeekPowNonceAsync(
    prefix,
    challenge.challenge,
    challenge.difficulty,
    options,
  );
  const elapsedMs = Math.round(performance.now() - startedAt);
  if (answer < 0) {
    throw new PowNotSolvedError(
      `PoW не решён за ${String(challenge.difficulty)} итераций (challenge устарел?)`,
    );
  }
  options.onSolved?.({ answer, elapsedMs });

  return {
    algorithm: 'DeepSeekHashV1',
    challenge: challenge.challenge,
    salt: challenge.salt,
    answer,
    signature: challenge.signature,
    target_path: options.targetPath ?? challenge.target_path,
  };
};

/**
 * Кодирует PoW-ответ в значение заголовка `x-ds-pow-response` (base64 JSON).
 * @param pow Решённый PoW.
 * @returns Base64-строка для заголовка.
 */
export const encodePowResponse = (pow: PowResponse): string =>
  Buffer.from(JSON.stringify(pow), 'utf8').toString('base64');

/**
 * Декодирует `x-ds-pow-response` обратно в объект (для отладки/тестов).
 * @param headerValue Значение заголовка base64.
 * @returns Разобранный PoW-ответ.
 * @throws Error если base64/JSON некорректны.
 */
export const decodePowResponse = (headerValue: string): unknown =>
  JSON.parse(Buffer.from(headerValue, 'base64').toString('utf8')) as unknown;
