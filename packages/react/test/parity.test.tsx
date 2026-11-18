/**
 * Hook behavior over a real client with promise-based snapshots and mutations.
 * Worker RPC tests separately cover the transport and event boundary.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BunClientDatabase } from '@syncular/client/bun';
import { act, renderHook, waitFor } from '@testing-library/react';
import { type ReactNode, StrictMode } from 'react';
import {
  SyncProvider,
  useCommitDelivery,
  useRawSql,
  useSyncStatus,
} from '../src/index';
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
    client.subscribe({ project_id: 'p1' });
    await client.syncUntilIdle();

    const handle = handleShapeOf(client);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <SyncProvider client={handle}>{children}</SyncProvider>
    );
    const { result } = renderHook(
      () => useRawSql('SELECT * FROM tasks', undefined, { tables: ['tasks'] }),
      {
        wrapper,
      },
    );
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

  // StrictMode regression on the REAL client surface (hooks.test.tsx covers
  // the FakeClient variant): the shared external-store subscription must stay
  // live across the double-effect cycle.
  test('StrictMode remount: the shared store re-runs through the promise path', async () => {
    const server = makeServer();
    const client = await makeClient(server, 'strict-a');
    clients.push(client);
    client.subscribe({ project_id: 'p1' });
    await client.syncUntilIdle();

    const handle = handleShapeOf(client);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <StrictMode>
        <SyncProvider client={handle}>{children}</SyncProvider>
      </StrictMode>
    );
    const { result } = renderHook(
      () => useRawSql('SELECT * FROM tasks', undefined, { tables: ['tasks'] }),
      {
        wrapper,
      },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));

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
    client.subscribe({ project_id: 'p1' });
    await act(async () => {
      client.mutate([
        { table: 'tasks', op: 'upsert', values: taskValues('t1', 'p1') },
      ]);
    });
    await waitFor(() => expect(result.current.outbox).toBe(1));
  });
});

describe('useCommitDelivery through the promise path', () => {
  test('offline → online: pending, then the applied outcome; a foreign id is unknown', async () => {
    const server = makeServer();
    let online = false;
    const client = await makeClient(server, 'delivery-a', {
      online: () => online,
    });
    clients.push(client);
    client.subscribe({ project_id: 'p1' });
    const commitId = client.mutate([
      { table: 'tasks', op: 'upsert', values: taskValues('t1', 'p1') },
    ]);

    const handle = handleShapeOf(client);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <StrictMode>
        <SyncProvider client={handle}>{children}</SyncProvider>
      </StrictMode>
    );
    const { result } = renderHook(
      () => useCommitDelivery([commitId, 'never-written']),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.deliveries).toEqual([
      { status: 'pending', clientCommitId: commitId },
      { status: 'unknown', clientCommitId: 'never-written' },
    ]);

    // An offline round leaves the commit in the outbox.
    await act(async () => {
      await client.sync().catch(() => undefined);
    });
    expect(result.current.deliveries[0]?.status).toBe('pending');

    online = true;
    await act(async () => {
      await client.syncUntilIdle();
    });
    await waitFor(() =>
      expect(result.current.deliveries[0]).toMatchObject({
        status: 'known',
        clientCommitId: commitId,
        outcome: { status: 'applied', clientCommitId: commitId },
      }),
    );
    expect(result.current.deliveries[1]?.status).toBe('unknown');
  });

  test('a reload while pending reads the commit from the reopened outbox', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'syncular-delivery-'));
    const path = join(directory, 'replica.sqlite');
    try {
      const server = makeServer();
      const first = new BunClientDatabase(path);
      const before = await makeClient(server, 'delivery-b', {
        database: first,
        online: () => false,
      });
      before.subscribe({ project_id: 'p1' });
      const commitId = before.mutate([
        { table: 'tasks', op: 'upsert', values: taskValues('t1', 'p1') },
      ]);
      await before.close();
      first.close();

      const client = await makeClient(server, 'delivery-b', {
        database: new BunClientDatabase(path),
      });
      clients.push(client);
      const handle = handleShapeOf(client);
      const wrapper = ({ children }: { children: ReactNode }) => (
        <SyncProvider client={handle}>{children}</SyncProvider>
      );
      const { result } = renderHook(() => useCommitDelivery([commitId]), {
        wrapper,
      });
      await waitFor(() =>
        expect(result.current.deliveries).toEqual([
          { status: 'pending', clientCommitId: commitId },
        ]),
      );
      await act(async () => {
        await client.syncUntilIdle();
      });
      await waitFor(() =>
        expect(result.current.deliveries[0]).toMatchObject({
          status: 'known',
          outcome: { status: 'applied' },
        }),
      );
    } finally {
      for (const c of clients) await c.close();
      clients.length = 0;
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
