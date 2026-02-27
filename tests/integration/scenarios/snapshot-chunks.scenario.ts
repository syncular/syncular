/**
 * Snapshot chunks scenario - Tests chunked bootstrap over HTTP
 */

import { expect } from 'bun:test';
import { syncPullOnce } from '@syncular/client';
import { createHttpTransport } from '@syncular/transport-http';
import type { ScenarioContext } from '../harness/types';

export async function runSnapshotChunksScenario(
  ctx: ScenarioContext
): Promise<void> {
  const { server: origServer } = ctx;
  const client1 = await ctx.createClient({
    actorId: ctx.userId,
    clientId: 'chunk-client-1',
  });
  const client2 = await ctx.createClient({
    actorId: ctx.userId,
    clientId: 'chunk-client-2',
  });

  const subP1 = {
    id: 'p1',
    table: 'tasks',
    scopes: { user_id: ctx.userId, project_id: 'p1' },
  };

  // Seed server
  await origServer.db
    .insertInto('tasks')
    .values({
      id: 'seed',
      title: 'Seed',
      completed: 0,
      user_id: ctx.userId,
      project_id: 'p1',
      server_version: 1,
    })
    .execute();

  // Client 1 bootstraps
  const res1 = await syncPullOnce(
    client1.db,
    client1.transport,
    client1.handlers,
    {
      clientId: client1.clientId,
      subscriptions: [subP1],
    }
  );

  const s1 = res1.subscriptions.find((s) => s.id === 'p1');
  expect(s1?.bootstrap).toBe(true);

  const client1Task = await client1.db
    .selectFrom('tasks')
    .selectAll()
    .where('id', '=', 'seed')
    .executeTakeFirst();
  expect(client1Task?.title).toBe('Seed');

  // Client 2 bootstraps
  const res2 = await syncPullOnce(
    client2.db,
    client2.transport,
    client2.handlers,
    {
      clientId: client2.clientId,
      subscriptions: [subP1],
    }
  );

  const s2 = res2.subscriptions.find((s) => s.id === 'p1');
  expect(s2?.bootstrap).toBe(true);

  const client2Task = await client2.db
    .selectFrom('tasks')
    .selectAll()
    .where('id', '=', 'seed')
    .executeTakeFirst();
  expect(client2Task?.title).toBe('Seed');
}

export async function runSnapshotChunkFaultInjectionScenario(
  ctx: ScenarioContext
): Promise<void> {
  const rowCount = 120;
  const subP1 = {
    id: 'p1',
    table: 'tasks',
    scopes: { user_id: ctx.userId, project_id: 'p1' },
  };
  const baseFetch = (globalThis as Record<string, unknown>).__nativeFetch as
    | typeof globalThis.fetch
    | undefined;
  const realFetch = baseFetch ?? globalThis.fetch;

  const seededRows = Array.from({ length: rowCount }, (_, index) => {
    const suffix = String(index + 1).padStart(4, '0');
    return {
      id: `fault-seed-${suffix}`,
      title: `Fault Seed ${suffix}`,
      completed: index % 2,
      user_id: ctx.userId,
      project_id: 'p1',
      server_version: 1,
    };
  });
  await ctx.server.db.insertInto('tasks').values(seededRows).execute();

  const isChunkRequest = (input: RequestInfo | URL): boolean => {
    if (typeof input === 'string') {
      return input.includes('/snapshot-chunks/');
    }
    if (input instanceof URL) {
      return input.pathname.includes('/snapshot-chunks/');
    }
    return input.url.includes('/snapshot-chunks/');
  };

  const runFaultCase = async (mode: 'missing' | 'server-error' | 'partial') => {
    const client = await ctx.createClient({
      actorId: ctx.userId,
      clientId: `chunk-fault-${mode}`,
    });
    let injected = false;
    const faultFetchBase = async (
      ...args: Parameters<typeof globalThis.fetch>
    ): Promise<Response> => {
      if (!injected && isChunkRequest(args[0])) {
        injected = true;
        if (mode === 'missing') {
          return new Response('not-found', { status: 404 });
        }
        if (mode === 'server-error') {
          return new Response('chunk-error', { status: 500 });
        }

        const response = await realFetch(...args);
        if (!response.ok) {
          return response;
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        const truncated = bytes.subarray(
          0,
          Math.max(1, Math.floor(bytes.length / 4))
        );
        return new Response(truncated, {
          status: 200,
          headers: response.headers,
        });
      }

      return realFetch(...args);
    };
    const faultFetch = Object.assign(faultFetchBase, {
      preconnect: realFetch.preconnect,
    });
    const faultTransport = createHttpTransport({
      baseUrl: ctx.server.baseUrl,
      getHeaders: () => ({ 'x-actor-id': ctx.userId }),
      fetch: faultFetch,
    });

    await expect(
      syncPullOnce(client.db, faultTransport, client.handlers, {
        clientId: client.clientId,
        subscriptions: [subP1],
        limitSnapshotRows: 50,
        maxSnapshotPages: 3,
      })
    ).rejects.toThrow();

    const countAfterFailure = await client.db
      .selectFrom('tasks')
      .select(({ fn }) => fn.countAll().as('total'))
      .executeTakeFirst();
    expect(Number(countAfterFailure?.total ?? 0)).toBe(0);

    await syncPullOnce(client.db, client.transport, client.handlers, {
      clientId: client.clientId,
      subscriptions: [subP1],
      limitSnapshotRows: 50,
      maxSnapshotPages: 3,
    });

    const recoveredRows = await client.db
      .selectFrom('tasks')
      .select(({ fn }) => fn.countAll().as('total'))
      .executeTakeFirst();
    expect(Number(recoveredRows?.total ?? 0)).toBe(rowCount);
  };

  await runFaultCase('missing');
  await runFaultCase('server-error');
  await runFaultCase('partial');
}
