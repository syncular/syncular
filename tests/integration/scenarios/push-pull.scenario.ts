/**
 * Push-pull scenario - Tests pushing local changes and pulling them back over HTTP
 */

import { expect } from 'bun:test';
import {
  enqueueOutboxCommit,
  syncPullOnce,
  syncPushOnce,
} from '@syncular/client';
import type { ScenarioContext } from '../harness/types';

export async function runPushPullScenario(ctx: ScenarioContext): Promise<void> {
  const client = ctx.clients[0]!;

  // Bootstrap first (empty)
  await syncPullOnce(client.db, client.transport, client.shapes, {
    clientId: client.clientId,
    subscriptions: [
      {
        id: 'my-tasks',
        shape: 'tasks',
        scopes: { user_id: ctx.userId, project_id: 'p1' },
      },
    ],
  });

  // Enqueue a local commit
  await enqueueOutboxCommit(client.db, {
    operations: [
      {
        table: 'tasks',
        row_id: 'new-task-1',
        op: 'upsert',
        payload: {
          title: 'New Task',
          completed: 0,
          project_id: 'p1',
        },
        base_version: null,
      },
    ],
  });

  // Push the commit over HTTP
  const pushResult = await syncPushOnce(client.db, client.transport, {
    clientId: client.clientId,
  });

  expect(pushResult.pushed).toBe(true);
  expect(pushResult.response?.status).toBe('applied');

  // Verify server has the data
  const serverTasks = await ctx.server.db
    .selectFrom('tasks')
    .selectAll()
    .execute();
  expect(serverTasks.length).toBe(1);
  expect(serverTasks[0]?.id).toBe('new-task-1');
  expect(serverTasks[0]?.title).toBe('New Task');

  // Pull incremental changes over HTTP
  const pullResult = await syncPullOnce(
    client.db,
    client.transport,
    client.shapes,
    {
      clientId: client.clientId,
      subscriptions: [
        {
          id: 'my-tasks',
          shape: 'tasks',
          scopes: { user_id: ctx.userId, project_id: 'p1' },
        },
      ],
    }
  );

  expect(
    pullResult.subscriptions.find((s) => s.id === 'my-tasks')?.bootstrap
  ).toBe(false);

  // Verify client has the data with server version
  const clientTasks = await client.db.selectFrom('tasks').selectAll().execute();
  expect(clientTasks.length).toBe(1);
  expect(clientTasks[0]?.id).toBe('new-task-1');
  expect(clientTasks[0]?.server_version).toBe(1);
}
