/**
 * Бенчмарк PoW-решателя DeepSeek.
 *
 * Запускается пользователем:
 *   pnpm bench:pow [--iterations 5]
 *
 * Использует реальный challenge из захвата 2026-10-19 (тот же, что в
 * `test/pow.test.ts`), поэтому замер сопоставим с живым запросом. Служит
 * базой для R-07-01: цель этапа — <200 мс на 144k, текущая реализация
 * последовательно перебирает nonce в JS.
 */
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { solvePowAsync } from '../src/deepseek/pow.js';
import type { PowChallenge } from '../src/deepseek/types.js';

/** Реальный challenge из захвата 2026-10-19. */
export const REAL_CHALLENGE: PowChallenge = {
  algorithm: 'DeepSeekHashV1',
  challenge: '15f40151bb8ed93bb6f32dc190f231b6e0387f4d240e86bf4ba75ad27ea8d479',
  salt: '705be849c244481503cc',
  signature: '409ddb30a66930a279baedc358e80b6f9e626f40d35e6bcfc87f5d1663fe54ca',
  difficulty: 144_000,
  expire_at: 1_792_419_860_451,
  expire_after: 300_000,
  target_path: '/api/v0/chat/completion',
};

/** Сводка замеров. */
export interface PowBenchSummary {
  readonly samplesMs: readonly number[];
  readonly minMs: number;
  readonly medianMs: number;
  readonly meanMs: number;
}

/** Результат прогона. */
export interface PowBenchResult {
  readonly summary: PowBenchSummary;
  readonly answer: number;
}

/**
 * Считает min/median/mean по замерам.
 * @param samplesMs Замеры в миллисекундах (хотя бы один).
 * @returns Сводка (samples отсортированы).
 * @throws Error если замеров нет.
 */
export const summarizeSamples = (samplesMs: readonly number[]): PowBenchSummary => {
  if (samplesMs.length === 0) {
    throw new Error('Нет замеров для сводки');
  }
  const sorted = samplesMs.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const medianMs =
    sorted.length % 2 === 1
      ? (sorted[middle] ?? 0)
      : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
  const meanMs = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  return {
    samplesMs: sorted,
    minMs: sorted[0] ?? 0,
    medianMs,
    meanMs,
  };
};

/**
 * Замеряет `solvePowAsync` заданное число раз.
 * @param iterations Количество прогонов.
 * @param challenge Challenge (по умолчанию реальный).
 * @returns Сводка и найденный answer.
 */
export const benchmarkPowAsync = async (
  iterations = 5,
  challenge: PowChallenge = REAL_CHALLENGE,
): Promise<PowBenchResult> => {
  const samplesMs: number[] = [];
  let answer = 0;
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    const pow = await solvePowAsync(challenge);
    samplesMs.push(performance.now() - started);
    answer = pow.answer;
  }
  return { summary: summarizeSamples(samplesMs), answer };
};

/**
 * Определяет, запущен ли модуль напрямую (`pnpm bench:pow`).
 */
const isDirectExecution = (): boolean => {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  return pathToFileURL(resolve(entry)).href === import.meta.url;
};

/** Значение флага `--iterations` (по умолчанию 5). */
const parseIterations = (): number => {
  const index = process.argv.indexOf('--iterations');
  if (index < 0) {
    return 5;
  }
  const raw = process.argv[index + 1];
  const value = raw === undefined ? Number.NaN : Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 50) {
    throw new Error('--iterations требует целое число от 1 до 50');
  }
  return value;
};

if (isDirectExecution()) {
  try {
    const iterations = parseIterations();
    const { summary, answer } = await benchmarkPowAsync(iterations);
    process.stdout.write(`[bench:pow] challenge=${REAL_CHALLENGE.challenge.slice(0, 12)}…\n`);
    process.stdout.write(
      `[bench:pow] difficulty=${String(REAL_CHALLENGE.difficulty)} answer=${String(answer)}\n`,
    );
    process.stdout.write(
      `[bench:pow] прогонов: ${String(iterations)}, min=${summary.minMs.toFixed(0)} мс, median=${summary.medianMs.toFixed(0)} мс, mean=${summary.meanMs.toFixed(0)} мс\n`,
    );
    process.stdout.write(
      `[bench:pow] цель R-07-01: <200 мс; текущий median=${summary.medianMs.toFixed(0)} мс\n`,
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`\n[bench:pow] ${message}\n`);
    process.exitCode = 1;
  }
}
