/**
 * Fast unit tests for the pure load-harness logic (no server spawn) — these
 * are the only tests kept sub-second. The scenario smokes are a separate,
 * ~30s sweep (`bun run load:smoke`) and deliberately NOT in the default
 * `bun test` (load brief: load stays out of the default sweep). Run these
 * with `bun test` from `load/`.
 */
import { describe, expect, test } from 'bun:test';
import { Histogram, percentile, seriesOf } from './metrics';

describe('percentile', () => {
  test('empty is NaN', () => {
    expect(Number.isNaN(percentile([], 50))).toBe(true);
  });

  test('nearest-rank on a sorted series', () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(sorted, 50)).toBe(5);
    expect(percentile(sorted, 95)).toBe(10);
    expect(percentile(sorted, 100)).toBe(10);
  });

  test('single sample', () => {
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 99)).toBe(42);
  });
});

describe('Histogram', () => {
  test('empty summary is all-NaN with zero count', () => {
    const s = new Histogram().summary();
    expect(s.count).toBe(0);
    expect(Number.isNaN(s.p95)).toBe(true);
  });

  test('summary computes count, min/max, mean, and percentiles', () => {
    const h = new Histogram();
    for (let i = 1; i <= 100; i++) h.add(i);
    const s = h.summary();
    expect(s.count).toBe(100);
    expect(s.min).toBe(1);
    expect(s.max).toBe(100);
    expect(s.mean).toBeCloseTo(50.5, 5);
    expect(s.p50).toBe(50);
    expect(s.p95).toBe(95);
    expect(s.p99).toBe(99);
  });

  test('order-independence (unsorted inserts)', () => {
    const h = new Histogram();
    for (const v of [9, 1, 7, 3, 5, 2, 8, 4, 6, 10]) h.add(v);
    const s = h.summary();
    expect(s.min).toBe(1);
    expect(s.max).toBe(10);
    expect(s.p50).toBe(5);
  });

  test('seriesOf names the summary', () => {
    const h = new Histogram();
    h.add(1);
    const series = seriesOf('round', h);
    expect(series.name).toBe('round');
    expect(series.count).toBe(1);
  });
});
