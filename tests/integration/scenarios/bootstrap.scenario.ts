/**
 * Bootstrap scenario - Tests initial data sync from server to client over HTTP
 */

import { expect } from 'bun:test';
import { syncPullOnce } from '@syncular/client';
import type { ScenarioContext } from '../harness/types';

export async function runBootstrapScenario(
  ctx: ScenarioContext
): Promise<void> {
  const { server } = ctx;
  const client = ctx.clients[0]!;

  // Seed server with data
  await server.db
    .insertInto('tasks')
    .values([
      {
        id: 'seed-1',
        title: 'Task 1',
        completed: 0,
        user_id: ctx.userId,
        project_id: 'p1',
        server_version: 1,
      },
      {
        id: 'seed-2',
        title: 'Task 2',
        completed: 1,
        user_id: ctx.userId,
        project_id: 'p1',
        server_version: 1,
      },
      {
        id: 'seed-3',
        title: 'Task 3',
        completed: 0,
        user_id: ctx.userId,
        project_id: 'p1',
        server_version: 1,
      },
    ])
    .execute();

  // Bootstrap client via real HTTP transport
  const result = await syncPullOnce(
    client.db,
    client.transport,
    client.handlers,
    {
      clientId: client.clientId,
      subscriptions: [
        {
          id: 'my-tasks',
          table: 'tasks',
          scopes: { user_id: ctx.userId, project_id: 'p1' },
        },
      ],
    }
  );

  // Verify bootstrap occurred
  const subResult = result.subscriptions.find((s) => s.id === 'my-tasks');
  expect(subResult?.bootstrap).toBe(true);

  // Verify data synced to client
  const clientTasks = await client.db
    .selectFrom('tasks')
    .selectAll()
    .orderBy('id', 'asc')
    .execute();

  expect(clientTasks.length).toBe(3);
  expect(clientTasks.map((t) => t.id)).toEqual(['seed-1', 'seed-2', 'seed-3']);
  expect(clientTasks[0]?.title).toBe('Task 1');
  expect(clientTasks[1]?.completed).toBe(1);
}
