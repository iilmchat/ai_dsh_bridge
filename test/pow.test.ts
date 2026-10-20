/**
 * Тесты PoW-решателя DeepSeekHashV1.
 *
 * Используется реальный challenge из захвата 2026-10-19
 * (`docs/captures/2026-10-19-pow-challenge.http`), а также синтетические
 * задачи с `difficulty = 1` для быстрых проверок формата ответа.
 */
import { describe, expect, it } from 'vitest';
import {
  deepSeekHashV1,
  findDeepSeekPowNonceAsync,
  MAX_DEEPSEEK_POW_DIFFICULTY,
  sha3_256Fips202,
} from '../src/deepseek/deepseek-hash.js';
import { decodePowResponse, encodePowResponse, solvePowAsync } from '../src/deepseek/pow.js';
import type { PowChallenge } from '../src/deepseek/types.js';
import { PowNotSolvedError } from '../src/deepseek/errors.js';

/** Реальный challenge из захвата 2026-10-19. */
const REAL_CHALLENGE: PowChallenge = {
  algorithm: 'DeepSeekHashV1',
  challenge: '15f40151bb8ed93bb6f32dc190f231b6e0387f4d240e86bf4ba75ad27ea8d479',
  salt: '705be849c244481503cc',
  signature: '409ddb30a66930a279baedc358e80b6f9e626f40d35e6bcfc87f5d1663fe54ca',
  difficulty: 144_000,
  expire_at: 1_792_419_860_451,
  expire_after: 300_000,
  target_path: '/api/v0/chat/completion',
};

/**
 * Строит синтетический challenge, решение которого известно (nonce = 0).
 * @param difficulty Верхняя граница перебора.
 */
const buildSyntheticChallenge = (difficulty: number): PowChallenge => {
  const salt = 'test-salt';
  const expireAt = 1_792_419_860_451;
  return {
    algorithm: 'DeepSeekHashV1',
    challenge: deepSeekHashV1(`${salt}_${String(expireAt)}_0`),
    salt,
    signature: 'ab'.repeat(32),
    difficulty,
    expire_at: expireAt,
    expire_after: 300_000,
    target_path: '/api/v0/chat/completion',
  };
};

describe('DeepSeekHashV1', () => {
  it('совпадает с FIPS 202 SHA3-256 на контрольном векторе', () => {
    expect(sha3_256Fips202('')).toBe(
      'a7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a',
    );
  });

  it('отличается от FIPS SHA3-256 (23 раунда вместо 24)', () => {
    expect(sha3_256Fips202('deepseek')).not.toBe(deepSeekHashV1('deepseek'));
  });

  it('даёт стабильный дайджест одинаковой длины', () => {
    const digest = deepSeekHashV1('salt_123_0');
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(deepSeekHashV1('salt_123_0')).toBe(digest);
  });
});

describe('solvePowAsync', () => {
  it(
    'решает реальный challenge из захвата 2026-10-19',
    async () => {
      const pow = await solvePowAsync(REAL_CHALLENGE);
      expect(pow.answer).toBeGreaterThanOrEqual(0);
      expect(pow.answer).toBeLessThan(REAL_CHALLENGE.difficulty);
      expect(pow.algorithm).toBe('DeepSeekHashV1');
      expect(pow.challenge).toBe(REAL_CHALLENGE.challenge);
      expect(pow.salt).toBe(REAL_CHALLENGE.salt);
      expect(pow.signature).toBe(REAL_CHALLENGE.signature);
      expect(pow.target_path).toBe('/api/v0/chat/completion');
      expect(deepSeekHashV1(`${pow.salt}_${String(REAL_CHALLENGE.expire_at)}_${String(pow.answer)}`)).toBe(
        REAL_CHALLENGE.challenge,
      );
    },
    30_000,
  );

  it('находит nonce = 0 при difficulty = 1', async () => {
    const challenge = buildSyntheticChallenge(1);
    const pow = await solvePowAsync(challenge);
    expect(pow.answer).toBe(0);
  });

  it('формат ответа не зависит от difficulty', async () => {
    const low = await solvePowAsync(buildSyntheticChallenge(1));
    const high = await solvePowAsync(buildSyntheticChallenge(25));
    expect(Object.keys(low).toSorted()).toEqual(Object.keys(high).toSorted());
    expect(low.target_path).toBe('/api/v0/chat/completion');
    expect(high.target_path).toBe('/api/v0/chat/completion');
  });

  it('кодирует запрошенный target_path, а не target_path из challenge', async () => {
    const challenge: PowChallenge = {
      ...buildSyntheticChallenge(1),
      target_path: '/api/v0/file/upload_file',
    };
    const pow = await solvePowAsync(challenge, { targetPath: '/api/v0/chat/completion' });
    expect(pow.target_path).toBe('/api/v0/chat/completion');
  });

  it('бросает PowNotSolvedError, если решения нет в пределах difficulty', async () => {
    const impossible: PowChallenge = {
      ...buildSyntheticChallenge(1),
      challenge: '0'.repeat(64),
    };
    await expect(solvePowAsync(impossible)).rejects.toBeInstanceOf(PowNotSolvedError);
  });

  it('кодирует ответ в base64 JSON для заголовка x-ds-pow-response', async () => {
    const pow = await solvePowAsync(buildSyntheticChallenge(1));
    const header = encodePowResponse(pow);
    const decoded = decodePowResponse(header);
    expect(decoded).toMatchObject({
      algorithm: 'DeepSeekHashV1',
      challenge: pow.challenge,
      salt: pow.salt,
      answer: 0,
      signature: pow.signature,
      target_path: '/api/v0/chat/completion',
    });
    expect(JSON.stringify(decoded)).not.toContain('algorithm=DeepSeekHashV1');
  });

  it('уважает AbortSignal до начала поиска', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      solvePowAsync(REAL_CHALLENGE, { signal: controller.signal }),
    ).rejects.toThrow(/отмен/i);
  });

  it('не превышает лимит MAX_DEEPSEEK_POW_DIFFICULTY', () => {
    expect(MAX_DEEPSEEK_POW_DIFFICULTY).toBe(250_000);
  });
});

describe('findDeepSeekPowNonceAsync', () => {
  it('находит nonce для синтетического challenge по чанкам', async () => {
    const challenge = buildSyntheticChallenge(10);
    const prefix = `${challenge.salt}_${String(challenge.expire_at)}_`;
    const nonce = await findDeepSeekPowNonceAsync(prefix, challenge.challenge, challenge.difficulty, {
      yieldEvery: 1,
    });
    expect(nonce).toBe(0);
  });

  it('возвращает -1, если решения нет', async () => {
    const challenge = buildSyntheticChallenge(2);
    const prefix = `${challenge.salt}_${String(challenge.expire_at)}_`;
    const nonce = await findDeepSeekPowNonceAsync(prefix, 'f'.repeat(64), challenge.difficulty);
    expect(nonce).toBe(-1);
  });

  it('отклоняет некорректный challenge', async () => {
    await expect(findDeepSeekPowNonceAsync('salt_1_', 'not-hex', 10)).rejects.toThrow(TypeError);
  });
});
