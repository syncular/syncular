/**
 * Push-pull scenario - Tests pushing local changes and pulling them back over HTTP
 */

import { expect } from 'bun:test';
import {
  createScenarioFlow,
  createSyncSubscription,
  createSyncUpsertOperation,
} from '@syncular/testkit';
import type { ScenarioContext } from '../harness/types';

export async function runPushPullScenario(ctx: ScenarioContext): Promise<void> {
  const client = ctx.clients[0]!;
  const flow = createScenarioFlow(client);
  const tasksSubscription = createSyncSubscription({
    id: 'my-tasks',
    table: 'tasks',
    scopes: { user_id: ctx.userId, project_id: 'p1' },
  });

  // Bootstrap first (empty)
  await flow.pull({
    subscriptions: [tasksSubscription],
  });

  const { pushResult, pullResult } = await flow.pushThenPull({
    enqueue: {
      operations: [
        createSyncUpsertOperation({
          table: 'tasks',
          rowId: 'new-task-1',
          payload: {
            title: 'New Task',
            completed: 0,
            project_id: 'p1',
          },
          baseVersion: null,
        }),
      ],
    },
    pull: {
      subscriptions: [tasksSubscription],
    },
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

  expect(
    pullResult.subscriptions.find((s) => s.id === 'my-tasks')?.bootstrap
  ).toBe(false);

  // Verify client has the data with server version
  const clientTasks = await client.db.selectFrom('tasks').selectAll().execute();
  expect(clientTasks.length).toBe(1);
  expect(clientTasks[0]?.id).toBe('new-task-1');
  expect(clientTasks[0]?.server_version).toBe(1);
}
