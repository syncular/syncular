import { describe, expect, it } from 'bun:test';
import { createRealtimeChangeScopeIndex, isRecord, randomId } from '../utils';

describe('isRecord', () => {
  it('returns true for plain objects', () => {
    expect(isRecord({ a: 1 })).toBe(true);
  });

  it('returns false for null and arrays', () => {
    expect(isRecord(null)).toBe(false);
    expect(isRecord([])).toBe(false);
  });
});

describe('randomId', () => {
  it('returns a non-empty string id', () => {
    const id = randomId();
    expect(typeof id).toBe('string');
    expect(id.length > 0).toBe(true);
  });

  it('generates different ids across sequential calls', () => {
    const first = randomId();
    const second = randomId();
    expect(first).not.toBe(second);
  });
});

describe('createRealtimeChangeScopeIndex', () => {
  it('selects matching changes once while preserving source order', () => {
    const index = createRealtimeChangeScopeIndex([
      { item: { id: 'a' }, scopeKeys: ['s1'] },
      { item: { id: 'b' }, scopeKeys: ['s2', 's3'] },
      { item: { id: 'c' }, scopeKeys: ['s1', 's2'] },
      { item: { id: 'd' }, scopeKeys: ['s4'] },
    ]);

    expect(index.selectForScopeKeys(['s2', 's1'])).toEqual([
      { id: 'a' },
      { id: 'b' },
      { id: 'c' },
    ]);
  });
});
