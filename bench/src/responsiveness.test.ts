import { expect, test } from 'bun:test';
import { runResponsiveness } from './responsiveness';

test('responsiveness fixture verifies reads before import and eviction finish', async () => {
  const result = await runResponsiveness(2500);
  expect(result.cachedPhase).toBe('ready');
  expect(
    result.measurements.map((m) => [
      m.operation,
      m.rowsAtFirstRead,
      m.readBeforeCompletion,
      m.transactions,
    ]),
  ).toEqual([
    ['import', 1000, true, 3],
    ['evict', 1476, true, 3],
  ]);
});

test('SQLite image imports retain bulk copying and yield between committed chunks', async () => {
  const result = await runResponsiveness(2500, 'sqlite');
  expect(result.cachedPhase).toBe('ready');
  expect(
    result.measurements.map((m) => [
      m.operation,
      m.rowsAtFirstRead,
      m.readBeforeCompletion,
      m.transactions,
    ]),
  ).toEqual([
    ['import', 1024, true, 3],
    ['evict', 1476, true, 3],
  ]);
});
