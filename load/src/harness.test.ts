/**
 * Fast unit test for the ramp shaping (no server spawn). See metrics.test.ts
 * for why the scenario smokes stay out of the default sweep.
 */
import { describe, expect, test } from 'bun:test';
import { rampTargetAt } from './harness';

describe('rampTargetAt', () => {
  const stages = [
    { target: 10, durationMs: 1000 },
    { target: 10, durationMs: 2000 },
  ];

  test('ramps linearly to the first target', () => {
    expect(rampTargetAt(stages, 0)).toBe(0);
    expect(rampTargetAt(stages, 500)).toBe(5);
    expect(rampTargetAt(stages, 1000)).toBe(10);
  });

  test('holds the plateau through the second stage', () => {
    expect(rampTargetAt(stages, 2000)).toBe(10);
    expect(rampTargetAt(stages, 3000)).toBe(10);
  });

  test('holds the last target past the end', () => {
    expect(rampTargetAt(stages, 999_999)).toBe(10);
  });

  test('a zero-duration stage jumps to its target', () => {
    expect(rampTargetAt([{ target: 20, durationMs: 0 }], 0)).toBe(20);
  });

  test('ramps down when a later target is lower', () => {
    const down = [
      { target: 10, durationMs: 1000 },
      { target: 0, durationMs: 1000 },
    ];
    expect(rampTargetAt(down, 1500)).toBe(5);
    expect(rampTargetAt(down, 2000)).toBe(0);
  });
});
