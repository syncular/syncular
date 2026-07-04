/**
 * `useNamedQuery` against the controllable `SyncClientLike` fake. Proves the
 * generated NAMED-query tier composes with the invalidation machinery:
 * - a descriptor runs live and returns the seeded rows;
 * - the descriptor's `tables` set is the EXACT dependency set — a depended-on
 *   table re-runs, an unrelated one never does (I4);
 * - a JOIN descriptor (two tables) re-runs when either invalidates;
 * - `bind(params)` reorders the typed params object into the positional args.
 *
 * The descriptors here are hand-written to the SAME structural shape typegen
 * emits (`{ sql, tables, bind }`) — the emitter's byte-exact output is gated by
 * the typegen goldens; this file gates the hook behavior.
 */
import './setup';
import { afterEach, describe, expect, test } from 'bun:test';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { NamedQueryDescriptor } from '../src/index';
import { SyncProvider, useNamedQuery } from '../src/index';
import { FakeClient } from './fake-client';

interface TodoRow {
  id: string;
  title: string;
}
interface ListTodosParams {
  listId: string;
}

const listTodosQuery: NamedQueryDescriptor<TodoRow, ListTodosParams> = {
  sql: 'SELECT id, title FROM todos WHERE list_id = ? ORDER BY title',
  tables: ['todos'],
  bind: (params) => [params.listId],
};

const allTitlesQuery: NamedQueryDescriptor<TodoRow, undefined> = {
  sql: 'SELECT id, title FROM todos',
  tables: ['todos'],
  bind: () => [],
};

const joinedQuery: NamedQueryDescriptor<TodoRow, undefined> = {
  sql: 'SELECT t.id, l.name AS title FROM todos t JOIN lists l ON l.id = t.list_id',
  tables: ['todos', 'lists'],
  bind: () => [],
};

function wrapper(client: FakeClient) {
  return ({ children }: { children: ReactNode }) => (
    <SyncProvider client={client}>{children}</SyncProvider>
  );
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('useNamedQuery', () => {
  test('runs a parameterized descriptor and returns rows', async () => {
    const client = new FakeClient();
    client.setRows('todos', [{ id: 't1', title: 'hello' }]);
    const { result } = renderHook(
      () => useNamedQuery(listTodosQuery, { listId: 'a' }),
      { wrapper: wrapper(client) },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.rows).toEqual([{ id: 't1', title: 'hello' }]);
  });

  test('binds params positionally (the wrapper takes ? args)', async () => {
    const client = new FakeClient();
    let lastParams: readonly unknown[] | undefined;
    const original = client.query.bind(client);
    // Capture the bound params the hook passes to query().
    client.query = ((sql: string, params?: readonly unknown[]) => {
      lastParams = params;
      return original(sql);
    }) as typeof client.query;
    client.setRows('todos', [{ id: 't1', title: 'x' }]);
    const { result } = renderHook(
      () => useNamedQuery(listTodosQuery, { listId: 'my-list' }),
      { wrapper: wrapper(client) },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(lastParams).toEqual(['my-list']);
  });

  test('a param-less descriptor takes no params argument', async () => {
    const client = new FakeClient();
    client.setRows('todos', [{ id: 't1', title: 'a' }]);
    const { result } = renderHook(() => useNamedQuery(allTitlesQuery), {
      wrapper: wrapper(client),
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.rows).toHaveLength(1);
  });

  test('re-runs on a depended-on table, NOT on an unrelated one (exact tables)', async () => {
    const client = new FakeClient();
    client.setRows('todos', [{ id: 't1', title: 'a' }]);
    const { result } = renderHook(
      () => useNamedQuery(listTodosQuery, { listId: 'a' }),
      { wrapper: wrapper(client) },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const before = client.queryCount;

    act(() => client.emitInvalidate(['lists']));
    expect(client.queryCount).toBe(before);

    client.setRows('todos', [
      { id: 't1', title: 'a' },
      { id: 't2', title: 'b' },
    ]);
    act(() => client.emitInvalidate(['todos']));
    await waitFor(() => expect(result.current.rows).toHaveLength(2));
    expect(client.queryCount).toBe(before + 1);
  });

  test('a JOIN descriptor depends on BOTH its tables', async () => {
    const client = new FakeClient();
    client.setRows('todos', [{ id: 't1', title: 'a' }]);
    const { result } = renderHook(() => useNamedQuery(joinedQuery), {
      wrapper: wrapper(client),
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const before = client.queryCount;
    // The joined `lists` table invalidating must re-run the query.
    act(() => client.emitInvalidate(['lists']));
    await waitFor(() => expect(client.queryCount).toBe(before + 1));
  });
});
