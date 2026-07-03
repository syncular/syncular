/**
 * Hook semantics against a controllable `SyncClientLike` (the fake exercises
 * the SHIPPED hook logic; only the substrate is faked). Covers:
 * - `useSyncQuery` re-runs on a relevant-table invalidation ONLY (I4 the
 *   counter-proof: an unrelated-table event never re-runs);
 * - coalescing (one apply batch = one re-run);
 * - status / conflicts / presence hooks;
 * - the explicit `tables` option overriding the inference heuristic.
 *
 * Worker-handle mode parity is covered by `parity.test.tsx` — both cores
 * satisfy the same interface these hooks target.
 */
import './setup';
import { afterEach, describe, expect, test } from 'bun:test';
import { act, render, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import {
  SyncProvider,
  useConflicts,
  usePresence,
  useSyncQuery,
  useSyncStatus,
} from '../src/index';
import { FakeClient } from './fake-client';

function wrapper(client: FakeClient) {
  return ({ children }: { children: ReactNode }) => (
    <SyncProvider client={client}>{children}</SyncProvider>
  );
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('useSyncQuery', () => {
  test('runs on mount and returns rows', async () => {
    const client = new FakeClient();
    client.setRows('tasks', [{ id: 't1', title: 'hello' }]);
    const { result } = renderHook(() => useSyncQuery('SELECT * FROM tasks'), {
      wrapper: wrapper(client),
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.rows).toEqual([{ id: 't1', title: 'hello' }]);
  });

  test('re-runs when a depended-on table invalidates', async () => {
    const client = new FakeClient();
    client.setRows('tasks', [{ id: 't1' }]);
    const { result } = renderHook(() => useSyncQuery('SELECT * FROM tasks'), {
      wrapper: wrapper(client),
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const before = client.queryCount;

    client.setRows('tasks', [{ id: 't1' }, { id: 't2' }]);
    act(() => client.emitInvalidate(['tasks'], ['project:p1']));
    await waitFor(() => expect(result.current.rows).toHaveLength(2));
    expect(client.queryCount).toBe(before + 1);
  });

  test('I4 counter-proof: an unrelated-table invalidation NEVER re-runs', async () => {
    const client = new FakeClient();
    client.setRows('tasks', [{ id: 't1' }]);
    const { result } = renderHook(() => useSyncQuery('SELECT * FROM tasks'), {
      wrapper: wrapper(client),
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const before = client.queryCount;

    // A commit to `docs` — the tasks query must not re-run.
    act(() => client.emitInvalidate(['docs'], ['org:o1']));
    // Give any stray effect a tick to (not) fire.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    expect(client.queryCount).toBe(before);
  });

  test('coalescing: one apply batch = exactly one re-run', async () => {
    const client = new FakeClient();
    client.setRows('tasks', []);
    const { result } = renderHook(() => useSyncQuery('SELECT * FROM tasks'), {
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
      () =>
        useSyncQuery('SELECT * FROM tasks', undefined, { tables: ['docs'] }),
      { wrapper: wrapper(client) },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const before = client.queryCount;

    act(() => client.emitInvalidate(['tasks']));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    expect(client.queryCount).toBe(before);

    act(() => client.emitInvalidate(['docs']));
    await waitFor(() => expect(client.queryCount).toBe(before + 1));
  });

  test('refresh() forces a re-run', async () => {
    const client = new FakeClient();
    client.setRows('tasks', []);
    const { result } = renderHook(() => useSyncQuery('SELECT * FROM tasks'), {
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
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
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
  useSyncQuery('SELECT 1');
  return null;
}
