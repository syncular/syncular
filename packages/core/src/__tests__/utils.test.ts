import { describe, expect, it } from 'bun:test';
import { isRecord, randomId } from '../utils';

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
