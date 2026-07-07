/**
 * Worker-handle mode parity: the SAME hook behavior against the handle's
 * DIVERGENT surface (all-async methods, not getters). The hooks target one
 * `SyncClientLike`; the normalizer collapses the getter-vs-method /
 * sync-vs-promise split. This test runs a real `SyncClient` behind a
 * handle-shaped adapter so the promise-everywhere path is exercised end to
 * end (the web-client worker-rpc test proves the real worker forwards these
 * same events).
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { SyncProvider, useRawSql, useSyncStatus } from '../src/index';
import { handleShapeOf } from './handle-shape';
import { makeClient, makeServer, taskValues } from './loopback';
import { installHappyDom } from './setup';

installHappyDom();

const clients: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  for (const c of clients) await c.close();
  clients.length = 0;
  document.body.innerHTML = '';
});

describe('hooks against the handle (all-async) surface', () => {
  test('useRawSql re-runs on invalidation through the promise path', async () => {
    const server = makeServer();
    const client = await makeClient(server, 'handle-a');
    clients.push(client);
    client.subscribe({
      id: 's1',
      table: 'tasks',
      scopes: { project_id: ['p1'] },
    });
    await client.syncUntilIdle();

    const handle = handleShapeOf(client);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <SyncProvider client={handle}>{children}</SyncProvider>
    );
    const { result } = renderHook(() => useRawSql('SELECT * FROM tasks'), {
      wrapper,
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // Wrap the mutate so the invalidation→re-query→setState it drives flushes
    // inside act (the promise-path core resolves the re-query asynchronously).
    await act(async () => {
      client.mutate([
        { table: 'tasks', op: 'upsert', values: taskValues('t1', 'p1', 'hi') },
      ]);
    });
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
  });

  test('useSyncStatus resolves the async accessors (methods, not getters)', async () => {
    const server = makeServer();
    const client = await makeClient(server, 'handle-b');
    clients.push(client);

    const handle = handleShapeOf(client);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <SyncProvider client={handle}>{children}</SyncProvider>
    );
    const { result } = renderHook(() => useSyncStatus(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.outbox).toBe(0);
    expect(result.current.upgrading).toBe(false);

    // An offline mutate raises the outbox; status re-reads on the batch.
    client.subscribe({
      id: 's1',
      table: 'tasks',
      scopes: { project_id: ['p1'] },
    });
    await act(async () => {
      client.mutate([
        { table: 'tasks', op: 'upsert', values: taskValues('t1', 'p1') },
      ]);
    });
    await waitFor(() => expect(result.current.outbox).toBe(1));
  });
});
