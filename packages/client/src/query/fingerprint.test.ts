import { describe, expect, it } from 'bun:test';
import { computeRowFingerprint } from './fingerprint';

function createTimestampSource(values: Record<string, number>): {
  getMutationTimestamp: (table: string, rowId: string) => number;
} {
  return {
    getMutationTimestamp(table: string, rowId: string): number {
      return values[`${table}:${rowId}`] ?? 0;
    },
  };
}

describe('computeRowFingerprint', () => {
  it('is deterministic for the same input rows', () => {
    const source = createTimestampSource({
      'tasks:a': 1,
      'tasks:b': 2,
    });
    const rows = [{ id: 'a' }, { id: 'b' }];

    const first = computeRowFingerprint(rows, 'tasks', source, 'id');
    const second = computeRowFingerprint(rows, 'tasks', source, 'id');

    expect(first).toBe(second);
  });

  it('changes when row order changes', () => {
    const source = createTimestampSource({
      'tasks:a': 1,
      'tasks:b': 2,
    });

    const first = computeRowFingerprint(
      [{ id: 'a' }, { id: 'b' }],
      'tasks',
      source,
      'id'
    );
    const second = computeRowFingerprint(
      [{ id: 'b' }, { id: 'a' }],
      'tasks',
      source,
      'id'
    );

    expect(first).not.toBe(second);
  });

  it('changes when mutation timestamps change', () => {
    const rows = [{ id: 'a' }];
    const first = computeRowFingerprint(
      rows,
      'tasks',
      createTimestampSource({ 'tasks:a': 1 }),
      'id'
    );
    const second = computeRowFingerprint(
      rows,
      'tasks',
      createTimestampSource({ 'tasks:a': 2 }),
      'id'
    );

    expect(first).not.toBe(second);
  });

  it('returns compact hash format', () => {
    const source = createTimestampSource({});
    const fingerprint = computeRowFingerprint([], 'tasks', source, 'id');
    expect(fingerprint).toMatch(/^tasks:0:[0-9a-f]{8}$/);
  });
});
