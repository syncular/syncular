import { describe, expect, it } from 'bun:test';
import { buildSeedPlan, createSeededRandom } from './seeding';

describe('buildSeedPlan', () => {
  it('distributes exactly the requested total rows', () => {
    const plan = buildSeedPlan(100, 2, ['alpha', 'beta']);
    const totalRows = plan.reduce((sum, entry) => sum + entry.rowCount, 0);

    expect(plan.map((entry) => entry.userId)).toEqual([
      'alpha-0',
      'beta-0',
      'alpha-1',
      'beta-1',
    ]);
    expect(totalRows).toBe(100);
    expect(plan.every((entry) => entry.rowCount >= 25)).toBe(true);
  });

  it('returns empty plan for zero rows/users', () => {
    expect(buildSeedPlan(0, 100).length).toBe(0);
    expect(buildSeedPlan(100, 0).length).toBe(0);
  });
});

describe('createSeededRandom', () => {
  it('is deterministic for the same seed', () => {
    const randomA = createSeededRandom('seed-42');
    const randomB = createSeededRandom('seed-42');

    const valuesA = Array.from({ length: 5 }, () => randomA());
    const valuesB = Array.from({ length: 5 }, () => randomB());

    expect(valuesA).toEqual(valuesB);
  });

  it('changes sequence for different seeds', () => {
    const randomA = createSeededRandom('seed-42');
    const randomB = createSeededRandom('seed-43');

    const valuesA = Array.from({ length: 5 }, () => randomA());
    const valuesB = Array.from({ length: 5 }, () => randomB());

    expect(valuesA).not.toEqual(valuesB);
  });
});
