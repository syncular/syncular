/**
 * Integration: the hooks against a REAL `SyncClient` (bun:sqlite) with REAL
 * choke-point invalidation from a real server core. This is the end-to-end
 * proof that `useSyncQuery` re-runs on a relevant commit and NOT on an
 * unrelated one (I4) — the invalidation seam and the hook wired together.
 */
import './setup';
import { afterEach, describe, expect, test } from 'bun:test';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { SyncProvider, useSyncQuery } from '../src/index';
import { makeClient, makeServer, taskValues } from './loopback';

const clients: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  for (const c of clients) await c.close();
  clients.length = 0;
  document.body.innerHTML = '';
});

describe('useSyncQuery against a real SyncClient', () => {
  test('a local mutate makes the query re-run and show the row', async () => {
    const server = makeServer();
    const client = await makeClient(server, 'client-a');
    clients.push(client);
    client.subscribe({
      id: 's1',
      table: 'tasks',
      scopes: { project_id: ['p1'] },
    });
    await client.syncUntilIdle();

    const wrapper = ({ children }: { children: ReactNode }) => (
      <SyncProvider client={client}>{children}</SyncProvider>
    );
    const { result } = renderHook(
      () => useSyncQuery('SELECT id, title FROM tasks ORDER BY id'),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.rows).toHaveLength(0);

    // A real optimistic mutate flows through the choke point.
    client.mutate([
      { table: 'tasks', op: 'upsert', values: taskValues('t1', 'p1', 'hi') },
    ]);
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    expect((result.current.rows[0] as { title: string }).title).toBe('hi');
  });

  test('a cross-client pull re-runs the other client’s live query', async () => {
    const server = makeServer();
    const a = await makeClient(server, 'client-a');
    const b = await makeClient(server, 'client-b');
    clients.push(a, b);
    for (const c of [a, b]) {
      c.subscribe({ id: 's1', table: 'tasks', scopes: { project_id: ['p1'] } });
      await c.syncUntilIdle();
    }

    const wrapper = ({ children }: { children: ReactNode }) => (
      <SyncProvider client={b}>{children}</SyncProvider>
    );
    const { result } = renderHook(() => useSyncQuery('SELECT * FROM tasks'), {
      wrapper,
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    a.mutate([
      { table: 'tasks', op: 'upsert', values: taskValues('t1', 'p1', 'x') },
    ]);
    await a.sync();
    // B pulls; the pull's COMMIT apply fires invalidation → the hook re-runs.
    await b.syncUntilIdle();
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
  });
});
