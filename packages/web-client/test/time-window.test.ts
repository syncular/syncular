import { expect, test } from 'bun:test';
import { creationTimeBucket, last } from '@syncular/client';

test('creation-time month buckets and rolling windows use UTC', () => {
  const now = Date.UTC(2026, 1, 8);
  expect(creationTimeBucket(now, 'month')).toBe('2026-02');
  expect(last(3, 'month', now)).toEqual(['2025-12', '2026-01', '2026-02']);
});

test('time window sugar rejects unbounded input with a stable code', () => {
  for (const run of [
    () => last(0, 'month', 0),
    () => last(1_201, 'month', 0),
    () => last(2, 'month', 0),
    () => creationTimeBucket(-1, 'month'),
  ]) {
    expect(run).toThrowError(
      expect.objectContaining({ code: 'sync.invalid_request' }),
    );
  }
});
