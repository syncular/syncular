/**
 * `useTypedQuery` against the controllable `SyncClientLike` fake (the shipped
 * hook logic; only the substrate is faked). Proves:
 * - a Kysely builder compiles + runs, returning the seeded rows;
 * - table dependencies are extracted from the compiled query's AST, so a
 *   depended-on-table invalidation re-runs and an UNRELATED one never does
 *   (I4 — the whole point of the typed layer over string inference);
 * - the `deps` array re-keys the builder (new filter value ⇒ new query).
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { SyncProvider } from '../src/index';
import { useTypedQuery } from '../src/typed';
import { FakeClient } from './fake-client';
import { installHappyDom } from './setup';

installHappyDom();

interface Database {
  todos: { id: string; list_id: string; title: string };
  lists: { id: string; name: string };
}

function wrapper(client: FakeClient) {
  return ({ children }: { children: ReactNode }) => (
    <SyncProvider client={client}>{children}</SyncProvider>
  );
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('useTypedQuery', () => {
  test('compiles a builder and returns rows', async () => {
    const client = new FakeClient();
    client.setRows('todos', [{ id: 't1', list_id: 'a', title: 'hello' }]);
    const { result } = renderHook(
      () =>
        useTypedQuery<Database>((db) =>
          db.selectFrom('todos').selectAll().where('list_id', '=', 'a'),
        ),
      { wrapper: wrapper(client) },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.rows).toEqual([
      { id: 't1', list_id: 'a', title: 'hello' },
    ]);
  });

  test('re-runs on a depended-on table, NOT on an unrelated one (AST tables)', async () => {
    const client = new FakeClient();
    client.setRows('todos', [{ id: 't1' }]);
    const { result } = renderHook(
      () => useTypedQuery<Database>((db) => db.selectFrom('todos').selectAll()),
      { wrapper: wrapper(client) },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const before = client.queryCount;

    // Unrelated table: never re-runs (extractTables saw only `todos`).
    act(() => client.emitInvalidate(['lists']));
    expect(client.queryCount).toBe(before);

    // Depended-on table: re-runs exactly once.
    client.setRows('todos', [{ id: 't1' }, { id: 't2' }]);
    act(() => client.emitInvalidate(['todos']));
    await waitFor(() => expect(result.current.rows).toHaveLength(2));
    expect(client.queryCount).toBe(before + 1);
  });

  test('a JOIN extracts BOTH tables as dependencies', async () => {
    const client = new FakeClient();
    client.setRows('todos', [{ id: 't1' }]);
    const { result } = renderHook(
      () =>
        useTypedQuery<Database>((db) =>
          db
            .selectFrom('todos')
            .innerJoin('lists', 'lists.id', 'todos.list_id')
            .selectAll('todos'),
        ),
      { wrapper: wrapper(client) },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const before = client.queryCount;
    // The joined table invalidating must re-run the query too.
    act(() => client.emitInvalidate(['lists']));
    await waitFor(() => expect(client.queryCount).toBe(before + 1));
  });

  test('deps re-key the builder', async () => {
    const client = new FakeClient();
    client.setRows('todos', [{ id: 't1' }]);
    let listId = 'a';
    const { result, rerender } = renderHook(
      () =>
        useTypedQuery<Database>(
          (db) =>
            db.selectFrom('todos').selectAll().where('list_id', '=', listId),
          [listId],
        ),
      { wrapper: wrapper(client) },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const before = client.queryCount;
    listId = 'b';
    rerender();
    await waitFor(() => expect(client.queryCount).toBe(before + 1));
  });
});
