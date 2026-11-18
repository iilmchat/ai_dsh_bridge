/**
 * Unit-тесты бенчмарка PoW: сводка min/median/mean. Живой перебор здесь не
 * запускается (он медленный и уже покрыт `test/pow.test.ts`).
 */
import { describe, expect, it } from 'vitest';
import { summarizeSamples } from '../scripts/bench-pow.js';

describe('summarizeSamples', () => {
  it('считает min/median/mean для нечётного числа замеров', () => {
    const summary = summarizeSamples([30, 10, 20]);
    expect(summary.minMs).toBe(10);
    expect(summary.medianMs).toBe(20);
    expect(summary.meanMs).toBe(20);
    expect(summary.samplesMs).toEqual([10, 20, 30]);
  });

  it('усредняет два центральных значения для чётного числа', () => {
    const summary = summarizeSamples([40, 10, 30, 20]);
    expect(summary.medianMs).toBe(25);
    expect(summary.minMs).toBe(10);
  });

  it('бросает ошибку на пустом списке замеров', () => {
    expect(() => summarizeSamples([])).toThrow(/Нет замеров/u);
  });
});
