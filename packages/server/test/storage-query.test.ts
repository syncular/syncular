import { expect, test } from 'bun:test';
import { chooseScanVariable, type ScanProbe } from '../src/storage-query';

/** A probe double over fixed per-variable entry counts, logging each call. */
function counter(entries: Record<string, number>) {
  const calls: { readonly vars: string[]; readonly cap: number }[] = [];
  return {
    calls,
    count: async (probes: readonly ScanProbe[], cap: number) => {
      calls.push({ vars: probes.map((probe) => probe.var), cap });
      return probes.map((probe) => ({
        sub: probe.i,
        n: Math.min(entries[probe.var] ?? 0, cap),
      }));
    },
  };
}

const query = (scopeFilter: Record<string, string[]>, limit = 10) => ({
  table: 't',
  scopeFilter,
  afterRowId: null,
  limit,
});

test('the variable with the fewest entries wins after one probe', async () => {
  const { calls, count } = counter({ a: 5_000, b: 900, c: 10 });
  expect(
    await chooseScanVariable(
      'p',
      query({ a: ['x'], b: ['y'], c: ['z'] }),
      new Map(),
      count,
    ),
  ).toBe('c');
  expect(calls).toEqual([{ vars: ['a', 'b', 'c'], cap: 64 }]);
});

test('the cap grows fourfold while variables tie at it', async () => {
  const { calls, count } = counter({ a: 300, b: 70, c: 1_000 });
  expect(
    await chooseScanVariable(
      'p',
      query({ a: ['x'], b: ['y'], c: ['z'] }, 100),
      new Map(),
      count,
    ),
  ).toBe('b');
  // The cap starts at the limit when it is above 64.
  expect(calls).toEqual([{ vars: ['a', 'b', 'c'], cap: 100 }]);

  const tied = counter({ a: 300, b: 1_000_000, c: 1_000_000 });
  expect(
    await chooseScanVariable(
      'p',
      query({ b: ['y'], c: ['z'], a: ['x'] }),
      new Map(),
      tied.count,
    ),
  ).toBe('a');
  expect(tied.calls).toEqual([
    { vars: ['a', 'b', 'c'], cap: 64 },
    { vars: ['a', 'b', 'c'], cap: 256 },
    { vars: ['a', 'b', 'c'], cap: 1_024 },
  ]);
});

test('a three-way tie past 65,536 entries goes to the fewest entries', async () => {
  // A catalogue release unit: every variable has more than 65,536 entries,
  // and the alphabetically first one covers every release.
  const catalogue = counter({
    catalogue_availability: 330_000,
    catalogue_content_release_id: 200_000,
    catalogue_content_set_id: 300_000,
  });
  expect(
    await chooseScanVariable(
      'p',
      query(
        {
          catalogue_availability: ['offered'],
          catalogue_content_release_id: ['R1'],
          catalogue_content_set_id: ['S1'],
        },
        1_000,
      ),
      new Map(),
      catalogue.count,
    ),
  ).toBe('catalogue_content_release_id');
  // The probe stops at the first cap above the fewest entries.
  expect(catalogue.calls.map((call) => call.cap)).toEqual([
    1_000, 4_000, 16_000, 64_000, 256_000,
  ]);

  // Equal counts end the growth once the cap passes them; the
  // alphabetically first variable wins.
  const equal = counter({ a: 1_000_000, b: 1_000_000, c: 2_000_000 });
  expect(
    await chooseScanVariable(
      'p',
      query({ c: ['z'], b: ['y'], a: ['x'] }),
      new Map(),
      equal.count,
    ),
  ).toBe('a');
  expect(equal.calls.at(-1)).toEqual({
    vars: ['a', 'b', 'c'],
    cap: 1_048_576,
  });
});

test('an empty intersection needs at most one probe', async () => {
  const { calls, count } = counter({ a: 5_000 });
  expect(
    await chooseScanVariable(
      'p',
      query({ a: ['x'], b: ['y'] }),
      new Map(),
      count,
    ),
  ).toBeUndefined();
  expect(calls).toHaveLength(1);
  expect(
    await chooseScanVariable('p', query({ a: ['x'], b: [] }), new Map(), count),
  ).toBeUndefined();
  expect(calls).toHaveLength(1);
});

test('a single variable needs no probe and an empty filter fails', async () => {
  const { calls, count } = counter({});
  expect(
    await chooseScanVariable('p', query({ a: ['x'] }), new Map(), count),
  ).toBe('a');
  expect(calls).toHaveLength(0);
  await expect(
    chooseScanVariable('p', query({}), new Map(), count),
  ).rejects.toMatchObject({ code: 'sync.storage.scan_requires_scope' });
});

test('the pick is memoized per filter in at most 1,024 entries', async () => {
  const chosen = new Map<string, string>();
  const { calls, count } = counter({ a: 5_000, b: 10 });
  await chooseScanVariable(
    'p',
    query({ a: ['x'], b: ['y', 'z'] }),
    chosen,
    count,
  );
  // Value and key order do not change the filter.
  expect(
    await chooseScanVariable(
      'p',
      query({ b: ['z', 'y'], a: ['x'] }),
      chosen,
      count,
    ),
  ).toBe('b');
  expect(calls).toHaveLength(1);
  await chooseScanVariable(
    'q',
    query({ a: ['x'], b: ['y', 'z'] }),
    chosen,
    count,
  );
  expect(calls).toHaveLength(2);
  for (let i = 0; i < 1_100; i++) {
    await chooseScanVariable(
      'p',
      query({ a: [`x${i}`], b: ['y'] }),
      chosen,
      count,
    );
  }
  expect(chosen.size).toBe(1_024);
});
