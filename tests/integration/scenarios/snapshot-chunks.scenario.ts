/**
 * Snapshot chunks scenario - Tests chunked bootstrap over HTTP
 */

import { expect } from 'bun:test';
import { syncPullOnce } from '@syncular/client';
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
