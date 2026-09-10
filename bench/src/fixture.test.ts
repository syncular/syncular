import { expect, test } from 'bun:test';
import { pairedEffects } from './fixture';

test('paired effects preserve equality, scale, direction, and the pair unit', () => {
  const same = Array.from({ length: 10 }, (_, index) => ({
    baseline: index + 1,
    candidate: index + 1,
  }));
  expect(pairedEffects(same).changePct).toBe(0);
  expect(pairedEffects(same).interval95Pct).toEqual([0, 0]);
  const twice = pairedEffects(
    same.map((pair) => ({ ...pair, candidate: pair.candidate * 2 })),
  );
  expect(twice.changePct).toBeCloseTo(100, 10);
  for (const bound of twice.interval95Pct) expect(bound).toBeCloseTo(100, 10);
  const half = pairedEffects(
    same.map((pair) => ({ ...pair, candidate: pair.candidate / 2 })),
  );
  expect(half.changePct).toBeCloseTo(-50, 10);
  for (const bound of half.interval95Pct) expect(bound).toBeCloseTo(-50, 10);

  // Five ratios of one and five of two: bootstrap counts follow Binomial(10, .5).
  // Its central 95% nearest-rank quantiles are two and eight doubled pairs.
  const mixed = same.map((pair, index) => ({
    ...pair,
    candidate: pair.candidate * (index < 5 ? 1 : 2),
  }));
  const effect = pairedEffects(mixed);
  expect(effect.changePct).toBeCloseTo(100 * (Math.sqrt(2) - 1), 10);
  expect(effect.interval95Pct[0]).toBeCloseTo(100 * (2 ** 0.2 - 1), 10);
  expect(effect.interval95Pct[1]).toBeCloseTo(100 * (2 ** 0.8 - 1), 10);
  const scaled = pairedEffects(
    mixed.map((pair) => ({
      baseline: pair.baseline * 1000,
      candidate: pair.candidate * 1000,
    })),
  );
  expect(scaled.changePct).toBe(effect.changePct);
  expect(scaled.interval95Pct).toEqual(effect.interval95Pct);
  expect(scaled.absoluteChangeMedian).toBe(effect.absoluteChangeMedian * 1000);
});

test('paired effects reject missing, nonpositive, and nonfinite observations', () => {
  const pairs = Array.from({ length: 10 }, () => ({
    baseline: 1,
    candidate: 1,
  }));
  expect(() => pairedEffects(pairs.slice(1))).toThrow('ten');
  for (const value of [0, -1, Infinity, Number.NaN]) {
    expect(() =>
      pairedEffects([{ baseline: value, candidate: 1 }, ...pairs]),
    ).toThrow('positive finite');
    expect(() =>
      pairedEffects([{ baseline: 1, candidate: value }, ...pairs]),
    ).toThrow('positive finite');
  }
});
