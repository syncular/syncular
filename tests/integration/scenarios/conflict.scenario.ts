/**
 * Conflict detection scenario - Tests version conflicts over HTTP
 */

import { expect } from 'bun:test';
import {
  enqueueOutboxCommit,
  syncPullOnce,
  syncPushOnce,
} from '@syncular/client';
import type { ScenarioContext } from '../harness/types';

export async function runConflictScenario(ctx: ScenarioContext): Promise<void> {
  const { server } = ctx;
  const client = ctx.clients[0]!;

  // Seed server with a task at version 3
  await server.db
    .insertInto('tasks')
    .values({
      id: 'conflict-task',
      title: 'Server Version',
      completed: 1,
      user_id: ctx.userId,
      project_id: 'p1',
      server_version: 3,
    })
    .execute();

  // Bootstrap client
  await syncPullOnce(client.db, client.transport, client.handlers, {
    clientId: client.clientId,
    subscriptions: [
      {
        id: 'my-tasks',
        table: 'tasks',
        scopes: { user_id: ctx.userId, project_id: 'p1' },
      },
    ],
  });

  // Try to push with stale base_version (1 instead of 3)
  await enqueueOutboxCommit(client.db, {
    operations: [
      {
        table: 'tasks',
        row_id: 'conflict-task',
        op: 'upsert',
        payload: {
          title: 'Client Update',
          completed: 0,
          project_id: 'p1',
        },
        base_version: 1,
      },
    ],
  });

  const pushResult = await syncPushOnce(client.db, client.transport, {
    clientId: client.clientId,
  });

  // Verify conflict was detected
  expect(pushResult.response?.status).toBe('rejected');

  // Verify conflict was stored
  const conflicts = await client.db
    .selectFrom('sync_conflicts')
    .selectAll()
    .execute();
  expect(conflicts.length).toBe(1);
  expect(conflicts[0]?.result_status).toBe('conflict');
  expect(conflicts[0]?.server_version).toBe(3);

  const serverRowJson = conflicts[0]?.server_row_json;
  const serverRow =
    typeof serverRowJson === 'string'
      ? JSON.parse(serverRowJson)
      : serverRowJson;
  expect(serverRow.title).toBe('Server Version');
  expect(serverRow.server_version).toBe(3);
}
