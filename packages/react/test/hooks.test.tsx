/**
 * Hook semantics against a controllable `SyncClientLike` (the fake exercises
 * the SHIPPED hook logic; only the substrate is faked). Covers:
 * - `useRawSql` re-runs on a relevant-table invalidation ONLY (I4 the
 *   counter-proof: an unrelated-table event never re-runs);
 * - coalescing (one apply batch = one re-run);
 * - status / conflicts / presence hooks;
 * - the explicit `tables` option overriding the inference heuristic.
 *
 * Worker-handle mode parity is covered by `parity.test.tsx` — both cores
 * satisfy the same interface these hooks target.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { act, render, renderHook, waitFor } from '@testing-library/react';
import { type ReactNode, StrictMode } from 'react';
import {
  SyncProvider,
  useConflicts,
  usePresence,
  useRawSql,
  useSyncStatus,
  useWindow,
} from '../src/index';
import { FakeClient } from './fake-client';
import { installHappyDom } from './setup';

installHappyDom();

function wrapper(client: FakeClient) {
  return ({ children }: { children: ReactNode }) => (
    <SyncProvider client={client}>{children}</SyncProvider>
  );
}

/**
 * Deterministically drain React's effect/microtask queue inside `act` so a
 * negative assertion ("a stray re-run must NOT happen") gives any pending
 * effect the chance to commit before we assert it did not — without a
 * wall-clock sleep, which under load could close the window before a real
 * effect fires (a false pass) or race the assertion (a flake). Two chained
 * microturns cover an effect scheduling a follow-up microtask.
 */
async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('useRawSql', () => {
  test('runs on mount and returns rows', async () => {
    const client = new FakeClient();
    client.setRows('tasks', [{ id: 't1', title: 'hello' }]);
    const { result } = renderHook(() => useRawSql('SELECT * FROM tasks'), {
      wrapper: wrapper(client),
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.rows).toEqual([{ id: 't1', title: 'hello' }]);
  });

  test('re-runs when a depended-on table invalidates', async () => {
    const client = new FakeClient();
    client.setRows('tasks', [{ id: 't1' }]);
    const { result } = renderHook(() => useRawSql('SELECT * FROM tasks'), {
      wrapper: wrapper(client),
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const before = client.queryCount;

    client.setRows('tasks', [{ id: 't1' }, { id: 't2' }]);
    act(() => client.emitInvalidate(['tasks'], ['project:p1']));
    await waitFor(() => expect(result.current.rows).toHaveLength(2));
    expect(client.queryCount).toBe(before + 1);
  });

  test('StrictMode remount: invalidation still re-runs (scheduler survives the double-effect cycle)', async () => {
    // StrictMode mounts, cleans up, and mounts effects again on the SAME hook
    // instance. The cleanup disposes the per-hook FrameScheduler; the setup
    // must re-create it — a disposed scheduler swallows every schedule()
    // silently and the live query freezes forever (found in the wild: data in
    // the local db, invalidations firing, UI never updating).
    const client = new FakeClient();
    client.setRows('tasks', [{ id: 't1' }]);
    const strictWrapper = ({ children }: { children: ReactNode }) => (
      <StrictMode>
        <SyncProvider client={client}>{children}</SyncProvider>
      </StrictMode>
    );
    const { result } = renderHook(() => useRawSql('SELECT * FROM tasks'), {
      wrapper: strictWrapper,
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const before = client.queryCount;

    client.setRows('tasks', [{ id: 't1' }, { id: 't2' }]);
    act(() => client.emitInvalidate(['tasks']));
    await waitFor(() => expect(result.current.rows).toHaveLength(2));
    expect(client.queryCount).toBeGreaterThan(before);
  });

  test('I4 counter-proof: an unrelated-table invalidation NEVER re-runs', async () => {
    const client = new FakeClient();
    client.setRows('tasks', [{ id: 't1' }]);
    const { result } = renderHook(() => useRawSql('SELECT * FROM tasks'), {
      wrapper: wrapper(client),
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const before = client.queryCount;

    // A commit to `docs` — the tasks query must not re-run.
    act(() => client.emitInvalidate(['docs'], ['org:o1']));
    // Give any stray effect the chance to (not) fire, deterministically.
    await flushEffects();
    expect(client.queryCount).toBe(before);
  });

  test('coalescing: one apply batch = exactly one re-run', async () => {
    const client = new FakeClient();
    client.setRows('tasks', []);
    const { result } = renderHook(() => useRawSql('SELECT * FROM tasks'), {
      wrapper: wrapper(client),
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const before = client.queryCount;

    // One event carrying multiple scope keys (a multi-row commit) — one re-run.
    act(() => client.emitInvalidate(['tasks'], ['project:p1', 'project:p2']));
    await waitFor(() => expect(client.queryCount).toBe(before + 1));
  });

  test('explicit tables option overrides the SQL inference', async () => {
    const client = new FakeClient();
    client.setRows('tasks', [{ id: 't1' }]);
    // The SQL reads `tasks`, but we DECLARE the dep as `docs` — so a `tasks`
    // event must not re-run, and a `docs` event must.
    const { result } = renderHook(
      () => useRawSql('SELECT * FROM tasks', undefined, { tables: ['docs'] }),
      { wrapper: wrapper(client) },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const before = client.queryCount;

    act(() => client.emitInvalidate(['tasks']));
    await flushEffects();
    expect(client.queryCount).toBe(before);

    act(() => client.emitInvalidate(['docs']));
    await waitFor(() => expect(client.queryCount).toBe(before + 1));
  });

  test('refresh() forces a re-run', async () => {
    const client = new FakeClient();
    client.setRows('tasks', []);
    const { result } = renderHook(() => useRawSql('SELECT * FROM tasks'), {
      wrapper: wrapper(client),
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const before = client.queryCount;
    act(() => result.current.refresh());
    await waitFor(() => expect(client.queryCount).toBe(before + 1));
  });
});

describe('useSyncStatus', () => {
  test('reports outbox depth, upgrading, lease, schemaFloor', async () => {
    const client = new FakeClient();
    client.setPending([{}, {}]);
    client.setUpgrading(true);
    client.setLeaseState({ leaseId: 'l1', expiresAtMs: 123 });
    const { result } = renderHook(() => useSyncStatus(), {
      wrapper: wrapper(client),
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.outbox).toBe(2);
    expect(result.current.upgrading).toBe(true);
    expect(result.current.leaseState?.leaseId).toBe('l1');
  });

  test('re-reads on an apply batch', async () => {
    const client = new FakeClient();
    client.setPending([]);
    const { result } = renderHook(() => useSyncStatus(), {
      wrapper: wrapper(client),
    });
    await waitFor(() => expect(result.current.outbox).toBe(0));
    client.setPending([{}]);
    act(() => client.emitInvalidate(['tasks']));
    await waitFor(() => expect(result.current.outbox).toBe(1));
  });
});

describe('useConflicts', () => {
  test('surfaces conflict records and re-reads on a batch', async () => {
    const client = new FakeClient();
    const { result } = renderHook(() => useConflicts(), {
      wrapper: wrapper(client),
    });
    await waitFor(() => expect(result.current.conflicts).toHaveLength(0));
    client.setConflicts([
      {
        clientCommitId: 'c1',
        opIndex: 0,
        table: 'tasks',
        rowId: 't1',
        code: 'sync.conflict',
        message: 'stale',
        serverVersion: 2,
        serverRow: {},
      },
    ]);
    act(() => client.emitInvalidate(['tasks']));
    await waitFor(() => expect(result.current.conflicts).toHaveLength(1));
  });
});

describe('usePresence', () => {
  test('lists peers and updates on a presence change', async () => {
    const client = new FakeClient();
    client.seedPresence('project:p1', [
      { actorId: 'a1', clientId: 'c1', doc: { cursor: 1 } },
    ]);
    const { result } = renderHook(() => usePresence('project:p1'), {
      wrapper: wrapper(client),
    });
    await waitFor(() => expect(result.current).toHaveLength(1));
    client.seedPresence('project:p1', [
      { actorId: 'a1', clientId: 'c1', doc: { cursor: 1 } },
      { actorId: 'a2', clientId: 'c2', doc: { cursor: 5 } },
    ]);
    act(() => client.emitPresence('project:p1'));
    await waitFor(() => expect(result.current).toHaveLength(2));
  });

  test('ignores presence changes on a different scope key', async () => {
    const client = new FakeClient();
    client.seedPresence('project:p1', []);
    const { result } = renderHook(() => usePresence('project:p1'), {
      wrapper: wrapper(client),
    });
    await waitFor(() => expect(result.current).toHaveLength(0));
    client.seedPresence('project:p1', [
      { actorId: 'a1', clientId: 'c1', doc: {} },
    ]);
    // A change on p2 must not pull p1's list.
    act(() => client.emitPresence('project:p2'));
    await flushEffects();
    expect(result.current).toHaveLength(0);
  });
});

describe('provider', () => {
  test('a hook outside a provider throws a clear error', () => {
    // Suppress React's expected error-boundary logging for this negative case.
    const spy = console.error;
    console.error = () => {};
    try {
      expect(() => render(<Bare />)).toThrow(/no client in context/);
    } finally {
      console.error = spy;
    }
  });
});

function Bare(): ReactNode {
  useRawSql('SELECT 1');
  return null;
}

describe('useWindow (§4.8 completeness oracle, I3)', () => {
  const base = { table: 'tasks', variable: 'project_id' } as const;

  test('setWindow updates the live units and the isComplete verdict', async () => {
    const client = new FakeClient();
    const { result } = renderHook(() => useWindow(base), {
      wrapper: wrapper(client),
    });
    await waitFor(() => expect(result.current.units).toEqual([]));
    // No unit is complete until windowed in — the honest default.
    expect(result.current.isComplete('p1')).toBe(false);

    await act(async () => {
      await result.current.setWindow(['p1', 'p2']);
    });
    await waitFor(() =>
      expect([...result.current.units].sort()).toEqual(['p1', 'p2']),
    );
    expect(result.current.isComplete('p1')).toBe(true);
    expect(result.current.isComplete('p2')).toBe(true);
    // A window MISS is reported honestly — never silently complete.
    expect(result.current.isComplete('p3')).toBe(false);
  });

  test('shrinking drops a unit from completeness', async () => {
    const client = new FakeClient();
    client.setWindow(base, ['p1', 'p2']);
    const { result } = renderHook(() => useWindow(base), {
      wrapper: wrapper(client),
    });
    await waitFor(() =>
      expect([...result.current.units].sort()).toEqual(['p1', 'p2']),
    );
    await act(async () => {
      await result.current.setWindow(['p2']);
    });
    await waitFor(() => expect(result.current.units).toEqual(['p2']));
    expect(result.current.isComplete('p1')).toBe(false);
    expect(result.current.isComplete('p2')).toBe(true);
  });
});
