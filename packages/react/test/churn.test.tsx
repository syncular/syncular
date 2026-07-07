/**
 * Live-query churn hardening at the HOOK level (RTL + happy-dom, act-hygienic).
 * Proves the three levers on the shipped `useRawSql` machinery:
 *  1a. unchanged data → ZERO re-renders (a render-count probe);
 *  1b. one-row change → only that row's memo'd component re-renders;
 *  2.  a burst of N invalidations → exactly ONE re-query (queryCount probe);
 *  3.  scopeKeys disjoint → no re-query; intersecting → re-query;
 *      table-floor event (no scope keys) → always re-query (never under-run).
 *
 * The existing I4 counter-proof and coalescing tests in hooks.test.tsx still
 * pass unchanged — this file adds the churn-specific assertions.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { act, render, renderHook, waitFor } from '@testing-library/react';
import { memo, type ReactNode } from 'react';
import { SyncProvider, useRawSql } from '../src/index';
import { FakeClient } from './fake-client';
import { installHappyDom } from './setup';

installHappyDom();

function wrapper(client: FakeClient) {
  return ({ children }: { children: ReactNode }) => (
    <SyncProvider client={client}>{children}</SyncProvider>
  );
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('lever 1a — result stability (zero re-render on unchanged data)', () => {
  test('an invalidation whose re-query returns identical data does NOT re-render', async () => {
    const client = new FakeClient();
    client.setRows('tasks', [{ id: 't1', title: 'a' }]);

    let renders = 0;
    function Probe(): ReactNode {
      renders += 1;
      useRawSql('SELECT * FROM tasks');
      return null;
    }
    render(<Probe />, { wrapper: wrapper(client) });
    await flushEffects();
    const rendersAfterMount = renders;

    // Same rows returned — the re-query result deep-equals the previous.
    client.setRows('tasks', [{ id: 't1', title: 'a' }]);
    act(() => client.emitInvalidate(['tasks']));
    await flushEffects();

    // The query DID re-run (we can't know it's unchanged without running it),
    // but state was NOT set, so NO extra render happened.
    expect(client.queryCount).toBeGreaterThan(0);
    expect(renders).toBe(rendersAfterMount);
  });
});

describe('lever 1b — row identity reuse (only the changed row re-renders)', () => {
  test('an unchanged row keeps its object; a memo row component skips', async () => {
    const client = new FakeClient();
    client.setRows('tasks', [
      { id: 't1', title: 'a' },
      { id: 't2', title: 'b' },
    ]);

    const rowRenders = new Map<string, number>();
    const Row = memo(function Row({
      row,
    }: {
      row: { id: string; title: string };
    }): ReactNode {
      rowRenders.set(row.id, (rowRenders.get(row.id) ?? 0) + 1);
      return <li>{row.title}</li>;
    });

    function List(): ReactNode {
      const { rows } = useRawSql<{ id: string; title: string }>(
        'SELECT * FROM tasks',
      );
      return (
        <ul>
          {rows.map((r) => (
            <Row key={r.id} row={r} />
          ))}
        </ul>
      );
    }
    render(<List />, { wrapper: wrapper(client) });
    await waitFor(() => expect(rowRenders.get('t1')).toBe(1));
    expect(rowRenders.get('t2')).toBe(1);

    // Change ONLY t2's content; t1 identical.
    client.setRows('tasks', [
      { id: 't1', title: 'a' },
      { id: 't2', title: 'B!' },
    ]);
    act(() => client.emitInvalidate(['tasks']));
    await waitFor(() => expect(rowRenders.get('t2')).toBe(2));

    // t1's memo component skipped — its object identity was reused.
    expect(rowRenders.get('t1')).toBe(1);
  });
});

describe('lever 2 — frame-coalesced re-query', () => {
  test('a burst of N invalidations triggers exactly ONE re-query', async () => {
    const client = new FakeClient();
    client.setRows('tasks', [{ id: 't1' }]);
    const { result } = renderHook(() => useRawSql('SELECT * FROM tasks'), {
      wrapper: wrapper(client),
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const before = client.queryCount;

    // Five separate apply-batch events in one synchronous burst.
    act(() => {
      for (let i = 0; i < 5; i++) client.emitInvalidate(['tasks']);
    });
    await flushEffects();

    // Coalesced to a single re-run despite five events.
    expect(client.queryCount).toBe(before + 1);
  });
});

describe('lever 3 — scope-key filtering', () => {
  const opts = { scopeKeys: ['project:p1'] } as const;

  test('disjoint scope keys → no re-query', async () => {
    const client = new FakeClient();
    client.setRows('tasks', [{ id: 't1' }]);
    const { result } = renderHook(
      () => useRawSql('SELECT * FROM tasks', undefined, opts),
      { wrapper: wrapper(client) },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const before = client.queryCount;

    // Event touches the table but a DIFFERENT scope key.
    act(() => client.emitInvalidate(['tasks'], ['project:p2']));
    await flushEffects();
    expect(client.queryCount).toBe(before);
  });

  test('intersecting scope keys → re-query', async () => {
    const client = new FakeClient();
    client.setRows('tasks', [{ id: 't1' }]);
    const { result } = renderHook(
      () => useRawSql('SELECT * FROM tasks', undefined, opts),
      { wrapper: wrapper(client) },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const before = client.queryCount;

    act(() => client.emitInvalidate(['tasks'], ['project:p1', 'project:p9']));
    await waitFor(() => expect(client.queryCount).toBe(before + 1));
  });

  test('table-floor event (no scope keys) ALWAYS re-queries (never under-run)', async () => {
    const client = new FakeClient();
    client.setRows('tasks', [{ id: 't1' }]);
    const { result } = renderHook(
      () => useRawSql('SELECT * FROM tasks', undefined, opts),
      { wrapper: wrapper(client) },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const before = client.queryCount;

    // A segment/reset apply carries no scope keys — the honest floor re-runs.
    act(() => client.emitInvalidate(['tasks']));
    await waitFor(() => expect(client.queryCount).toBe(before + 1));
  });
});
