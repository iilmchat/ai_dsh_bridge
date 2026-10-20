/**
 * DeepSeekHashV1 — хэш-функция DeepSeek для proof-of-work.
 *
 * Порт MIT-реализации OmniRoute (`open-sse/lib/deepseek-pow-hash.js`,
 * (c) diegosouzapw, MIT License): SHA3-спonge с KECCAK-p[1600, 23] —
 * используются последние 23 раунда вместо 24 (DESIGN § 4).
 *
 * Задача PoW: найти `nonce` из `[0, difficulty)`, такой что
 * `deepSeekHashV1("<salt>_<expire_at>_<nonce>") === challenge`.
 */
import { AbortError } from './errors.js';

/** Максимально допустимое `difficulty` (защита от бесконечного цикла). */
export const MAX_DEEPSEEK_POW_DIFFICULTY = 250_000;

/** Скорость спонжа SHA3-256 — 136 байт (1088 бит). */
const SHA3_256_RATE_BYTES = 136;

/** Домен-суффикс SHA3 (0x06); для «чистого» Keccak был бы 0x01. */
const SHA3_DOMAIN_SUFFIX = 0x06;

/** Длина выходного дайджеста. */
const SHA3_256_OUTPUT_BYTES = 32;

/** Число раундов DeepSeekHashV1 (нестандартные 23 вместо 24). */
const DEEPSEEK_HASH_ROUNDS = 23;

/** Полный набор раундовых констант Keccak (нужны все 24 для FIPS-контроля). */
const ROUND_CONSTANTS: readonly bigint[] = [
  0x0000000000000001n,
  0x0000000000008082n,
  0x800000000000808an,
  0x8000000080008000n,
  0x000000000000808bn,
  0x0000000080000001n,
  0x8000000080008081n,
  0x8000000000008009n,
  0x000000000000008an,
  0x0000000000000088n,
  0x0000000080008009n,
  0x000000008000000an,
  0x000000008000808bn,
  0x800000000000008bn,
  0x8000000000008089n,
  0x8000000000008003n,
  0x8000000000008002n,
  0x8000000000000080n,
  0x000000000000800an,
  0x800000008000000an,
  0x8000000080008081n,
  0x8000000000008080n,
  0x0000000080000001n,
  0x8000000080008008n,
];

/** Смещения rho для каждого из 25 lane (индекс = x + 5*y). */
const ROTATION_OFFSETS: readonly number[] = [
  0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14,
];

/** Младшие 32 бита раундовых констант. */
const ROUND_CONSTANTS_LOW = Uint32Array.from(ROUND_CONSTANTS, (value) => Number(value & 0xffff_ffffn));

/** Старшие 32 бита раундовых констант. */
const ROUND_CONSTANTS_HIGH = Uint32Array.from(ROUND_CONSTANTS, (value) =>
  Number((value >> 32n) & 0xffff_ffffn),
);

/** Индексы слов назначения для rho/pi (каждый lane — 2 слова low/high). */
const RHO_PI_DESTINATION_WORDS = Uint8Array.from({ length: 25 }, (_, lane) => {
  const x = lane % 5;
  const y = Math.floor(lane / 5);
  return 2 * (y + 5 * ((2 * x + 3 * y) % 5));
});

/** Индексы слов x+1 в строке chi. */
const CHI_NEXT_WORDS = Uint8Array.from({ length: 25 }, (_, lane) => {
  const x = lane % 5;
  const row = lane - x;
  return 2 * (row + ((x + 1) % 5));
});

/** Индексы слов x+2 в строке chi. */
const CHI_NEXT_NEXT_WORDS = Uint8Array.from({ length: 25 }, (_, lane) => {
  const x = lane % 5;
  const row = lane - x;
  return 2 * (row + ((x + 2) % 5));
});

/** Шестнадцатеричные цифры для сборки дайджеста. */
const HEX_DIGITS = '0123456789abcdef';

/** Регулярное выражение для 32-байтного hex-дайджеста. */
const DIGEST_HEX_PATTERN = /^[a-f0-9]{64}$/i;

/**
 * Перестановка KECCAK-p[1600, roundCount] над 32-битными словами.
 * Каждый 64-битный lane хранится как пара соседних слов low/high.
 * @param state Состояние (50 слов).
 * @param rhoPiState Временный буфер rho/pi (50 слов).
 * @param columnParity Буфер чётности колонок (10 слов).
 * @param thetaMix Буфер theta (10 слов).
 * @param roundCount Число раундов (23 для DeepSeekHashV1, 24 для FIPS).
 */
const keccakP1600Uint32 = (
  state: Uint32Array,
  rhoPiState: Uint32Array,
  columnParity: Uint32Array,
  thetaMix: Uint32Array,
  roundCount: number,
): void => {
  const firstRound = ROUND_CONSTANTS.length - roundCount;

  for (let round = firstRound; round < ROUND_CONSTANTS.length; round += 1) {
    for (let x = 0; x < 5; x += 1) {
      const word = 2 * x;
      columnParity[word] =
        (state[word] ?? 0) ^
        (state[word + 10] ?? 0) ^
        (state[word + 20] ?? 0) ^
        (state[word + 30] ?? 0) ^
        (state[word + 40] ?? 0);
      columnParity[word + 1] =
        (state[word + 1] ?? 0) ^
        (state[word + 11] ?? 0) ^
        (state[word + 21] ?? 0) ^
        (state[word + 31] ?? 0) ^
        (state[word + 41] ?? 0);
    }

    for (let x = 0; x < 5; x += 1) {
      const previous = 2 * ((x + 4) % 5);
      const next = 2 * ((x + 1) % 5);
      const rotatedLow = ((columnParity[next] ?? 0) << 1) | ((columnParity[next + 1] ?? 0) >>> 31);
      const rotatedHigh = ((columnParity[next + 1] ?? 0) << 1) | ((columnParity[next] ?? 0) >>> 31);
      thetaMix[2 * x] = (columnParity[previous] ?? 0) ^ rotatedLow;
      thetaMix[2 * x + 1] = (columnParity[previous + 1] ?? 0) ^ rotatedHigh;
    }

    for (let x = 0; x < 5; x += 1) {
      const word = 2 * x;
      const low = thetaMix[word] ?? 0;
      const high = thetaMix[word + 1] ?? 0;
      state[word] = (state[word] ?? 0) ^ low;
      state[word + 1] = (state[word + 1] ?? 0) ^ high;
      state[word + 10] = (state[word + 10] ?? 0) ^ low;
      state[word + 11] = (state[word + 11] ?? 0) ^ high;
      state[word + 20] = (state[word + 20] ?? 0) ^ low;
      state[word + 21] = (state[word + 21] ?? 0) ^ high;
      state[word + 30] = (state[word + 30] ?? 0) ^ low;
      state[word + 31] = (state[word + 31] ?? 0) ^ high;
      state[word + 40] = (state[word + 40] ?? 0) ^ low;
      state[word + 41] = (state[word + 41] ?? 0) ^ high;
    }

    rhoPiState[0] = state[0] ?? 0;
    rhoPiState[1] = state[1] ?? 0;
    for (let lane = 1; lane < 25; lane += 1) {
      const source = 2 * lane;
      const destination = RHO_PI_DESTINATION_WORDS[lane] ?? 0;
      const amount = ROTATION_OFFSETS[lane] ?? 0;
      const low = state[source] ?? 0;
      const high = state[source + 1] ?? 0;

      if (amount < 32) {
        rhoPiState[destination] = (low << amount) | (high >>> (32 - amount));
        rhoPiState[destination + 1] = (high << amount) | (low >>> (32 - amount));
      } else {
        const reduced = amount - 32;
        rhoPiState[destination] = (high << reduced) | (low >>> (32 - reduced));
        rhoPiState[destination + 1] = (low << reduced) | (high >>> (32 - reduced));
      }
    }

    for (let lane = 0; lane < 25; lane += 1) {
      const word = 2 * lane;
      const nextWord = CHI_NEXT_WORDS[lane] ?? 0;
      const nextNextWord = CHI_NEXT_NEXT_WORDS[lane] ?? 0;
      state[word] =
        (rhoPiState[word] ?? 0) ^
        (~(rhoPiState[nextWord] ?? 0) & (rhoPiState[nextNextWord] ?? 0));
      state[word + 1] =
        (rhoPiState[word + 1] ?? 0) ^
        (~(rhoPiState[nextWord + 1] ?? 0) & (rhoPiState[nextNextWord + 1] ?? 0));
    }

    state[0] = (state[0] ?? 0) ^ (ROUND_CONSTANTS_LOW[round] ?? 0);
    state[1] = (state[1] ?? 0) ^ (ROUND_CONSTANTS_HIGH[round] ?? 0);
  }
};

/**
 * Впитывает полный блок (136 байт) в состояние и применяет перестановку.
 * @param state Состояние.
 * @param bytes Байты входа.
 * @param offset Смещение блока.
 * @param rhoPiState Буфер rho/pi.
 * @param columnParity Буфер чётности.
 * @param thetaMix Буфер theta.
 * @param roundCount Число раундов.
 */
const absorbFullUint32Block = (
  state: Uint32Array,
  bytes: Uint8Array,
  offset: number,
  rhoPiState: Uint32Array,
  columnParity: Uint32Array,
  thetaMix: Uint32Array,
  roundCount: number,
): void => {
  for (let index = 0; index < SHA3_256_RATE_BYTES; index += 1) {
    const word = index >>> 2;
    state[word] = (state[word] ?? 0) ^ ((bytes[offset + index] ?? 0) << ((index & 3) * 8));
  }
  keccakP1600Uint32(state, rhoPiState, columnParity, thetaMix, roundCount);
};

/**
 * Преобразует состояние в hex-дайджест (32 байта, little-endian).
 * @param state Состояние после перестановки.
 * @returns 64-символьный hex.
 */
const digestStateToHex = (state: Uint32Array): string => {
  let digest = '';
  for (let index = 0; index < SHA3_256_OUTPUT_BYTES; index += 1) {
    const word = state[index >>> 2] ?? 0;
    const byte = (word >>> ((index & 3) * 8)) & 0xff;
    digest += (HEX_DIGITS[byte >>> 4] ?? '0') + (HEX_DIGITS[byte & 0x0f] ?? '0');
  }
  return digest;
};

/**
 * SHA3-256-спонж с произвольным числом раундов перестановки.
 * @param input Входная строка (UTF-8).
 * @param roundCount Число раундов KECCAK-p[1600].
 * @returns Hex-дайджест (64 символа).
 */
const sha3_256Uint32WithRoundCount = (input: string, roundCount: number): string => {
  const bytes = new TextEncoder().encode(input);
  const state = new Uint32Array(50);
  const rhoPiState = new Uint32Array(50);
  const columnParity = new Uint32Array(10);
  const thetaMix = new Uint32Array(10);
  let offset = 0;

  while (offset + SHA3_256_RATE_BYTES <= bytes.length) {
    absorbFullUint32Block(state, bytes, offset, rhoPiState, columnParity, thetaMix, roundCount);
    offset += SHA3_256_RATE_BYTES;
  }

  const remaining = bytes.length - offset;
  for (let index = 0; index < remaining; index += 1) {
    const word = index >>> 2;
    state[word] = (state[word] ?? 0) ^ ((bytes[offset + index] ?? 0) << ((index & 3) * 8));
  }
  const domainWord = remaining >>> 2;
  state[domainWord] = (state[domainWord] ?? 0) ^ (SHA3_DOMAIN_SUFFIX << ((remaining & 3) * 8));
  const finalWord = (SHA3_256_RATE_BYTES - 1) >>> 2;
  state[finalWord] = (state[finalWord] ?? 0) ^ (0x80 << 24);
  keccakP1600Uint32(state, rhoPiState, columnParity, thetaMix, roundCount);
  return digestStateToHex(state);
};

/**
 * Контрольная реализация FIPS 202 SHA3-256 (24 раунда) — используется в
 * тестах, чтобы проверить перестановку, padding и порядок байтов.
 * @param input Входная строка.
 * @returns SHA3-256 hex.
 */
export const sha3_256Fips202 = (input: string): string =>
  sha3_256Uint32WithRoundCount(input, 24);

/**
 * DeepSeekHashV1: SHA3-256 с 23 раундами Keccak-p[1600].
 * @param input Входная строка.
 * @returns Hex-дайджест DeepSeekHashV1.
 */
export const deepSeekHashV1 = (input: string): string =>
  sha3_256Uint32WithRoundCount(input, DEEPSEEK_HASH_ROUNDS);

/**
 * Разбирает hex-дайджест в массив 32-битных слов (little-endian).
 * @param digestHex Hex-дайджест (64 символа).
 * @returns 8 слов.
 */
const parseDigestWords = (digestHex: string): Uint32Array => {
  const words = new Uint32Array(SHA3_256_OUTPUT_BYTES / 4);
  for (let index = 0; index < SHA3_256_OUTPUT_BYTES; index += 1) {
    const byte = Number.parseInt(digestHex.slice(index * 2, index * 2 + 2), 16);
    const word = index >>> 2;
    words[word] = (words[word] ?? 0) | (byte << ((index & 3) * 8));
  }
  return words;
};

/** Опции асинхронного поиска nonce. */
export interface FindNonceOptions {
  /** Сколько nonce проверять между уступами event loop. */
  readonly yieldEvery?: number;
  /** Отмена поиска. */
  readonly signal?: AbortSignal;
}

/**
 * Проверяет входные данные PoW-задачи.
 * @param prefix Префикс `"<salt>_<expire_at>_"`.
 * @param challenge Ожидаемый hex-дайджест.
 * @param difficulty Верхняя граница перебора nonce.
 */
const assertSearchInput = (prefix: string, challenge: string, difficulty: number): void => {
  if (typeof prefix !== 'string' || prefix.length === 0) {
    throw new TypeError('DeepSeek PoW prefix должен быть непустой строкой');
  }
  if (!DIGEST_HEX_PATTERN.test(challenge)) {
    throw new TypeError('DeepSeek PoW challenge должен быть 64-символьным hex-дайджестом');
  }
  if (!Number.isSafeInteger(difficulty) || difficulty < 1 || difficulty > MAX_DEEPSEEK_POW_DIFFICULTY) {
    throw new RangeError(
      `DeepSeek PoW difficulty должна быть целым числом от 1 до ${MAX_DEEPSEEK_POW_DIFFICULTY}`,
    );
  }
};

/**
 * Уступает event loop (setImmediate), чтобы длинный перебор не блокировал
 * обработку HTTP и сигналов.
 */
const yieldToEventLoopAsync = (): Promise<void> =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

/**
 * Асинхронный поиск `nonce`, для которого hash(prefix + nonce) === challenge.
 *
 * Перебор разбит на чанки по `yieldEvery` nonce с уступкой event loop между
 * ними (DESIGN § 4: решение ~100–500 мс, сервер не «замирает»).
 *
 * @param prefix Префикс `"<salt>_<expire_at>_"`.
 * @param challenge Ожидаемый hex-дайджест.
 * @param difficulty Верхняя граница перебора (исключая).
 * @param options Опции: размер чанка и AbortSignal.
 * @returns Найденный nonce или -1, если решения нет.
 * @throws RangeError/TypeError при некорректных входных данных.
 * @throws AbortError при отмене через `signal`.
 */
export const findDeepSeekPowNonceAsync = async (
  prefix: string,
  challenge: string,
  difficulty: number,
  options: FindNonceOptions = {},
): Promise<number> => {
  assertSearchInput(prefix, challenge, difficulty);
  const yieldEvery = options.yieldEvery ?? 4096;
  if (!Number.isSafeInteger(yieldEvery) || yieldEvery < 1) {
    throw new RangeError('yieldEvery должен быть положительным целым числом');
  }
  if (options.signal?.aborted === true) {
    throw new AbortError('Поиск PoW отменён');
  }
  const isAborted = (): boolean => options.signal?.aborted === true;

  const prefixBytes = new TextEncoder().encode(prefix);
  const baseState = new Uint32Array(50);
  const rhoPiState = new Uint32Array(50);
  const columnParity = new Uint32Array(10);
  const thetaMix = new Uint32Array(10);
  let prefixOffset = 0;

  while (prefixOffset + SHA3_256_RATE_BYTES <= prefixBytes.length) {
    absorbFullUint32Block(
      baseState,
      prefixBytes,
      prefixOffset,
      rhoPiState,
      columnParity,
      thetaMix,
      DEEPSEEK_HASH_ROUNDS,
    );
    prefixOffset += SHA3_256_RATE_BYTES;
  }

  const tailLength = prefixBytes.length - prefixOffset;
  const tailWords = new Uint32Array(Math.ceil(tailLength / 4));
  for (let index = 0; index < tailLength; index += 1) {
    const word = index >>> 2;
    tailWords[word] = (tailWords[word] ?? 0) ^ ((prefixBytes[prefixOffset + index] ?? 0) << ((index & 3) * 8));
  }

  const targetWords = parseDigestWords(challenge.toLowerCase());
  const state = new Uint32Array(50);
  let nonce = 0;

  while (nonce < difficulty) {
    const chunkEnd = Math.min(nonce + yieldEvery, difficulty);
    for (; nonce < chunkEnd; nonce += 1) {
      state.set(baseState);
      for (let word = 0; word < tailWords.length; word += 1) {
        state[word] = (state[word] ?? 0) ^ (tailWords[word] ?? 0);
      }

      let position = tailLength;
      const nonceText = String(nonce);
      for (let index = 0; index < nonceText.length; index += 1) {
        const word = position >>> 2;
        state[word] = (state[word] ?? 0) ^ (nonceText.charCodeAt(index) << ((position & 3) * 8));
        position += 1;
        if (position === SHA3_256_RATE_BYTES) {
          keccakP1600Uint32(state, rhoPiState, columnParity, thetaMix, DEEPSEEK_HASH_ROUNDS);
          position = 0;
        }
      }

      const domainWord = position >>> 2;
      state[domainWord] = (state[domainWord] ?? 0) ^ (SHA3_DOMAIN_SUFFIX << ((position & 3) * 8));
      const finalWord = (SHA3_256_RATE_BYTES - 1) >>> 2;
      state[finalWord] = (state[finalWord] ?? 0) ^ (0x80 << 24);
      keccakP1600Uint32(state, rhoPiState, columnParity, thetaMix, DEEPSEEK_HASH_ROUNDS);

      let matches = true;
      for (let word = 0; word < targetWords.length; word += 1) {
        if ((state[word] ?? 0) !== (targetWords[word] ?? 0)) {
          matches = false;
          break;
        }
      }
      if (matches) {
        return nonce;
      }
    }

    if (isAborted()) {
      throw new AbortError('Поиск PoW отменён');
    }
    await yieldToEventLoopAsync();
  }

  return -1;
};
