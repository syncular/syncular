/**
 * Offline resilience scenarios - Tests disconnect → local mutations → reconnect → sync.
 */

import { expect } from 'bun:test';
import {
  enqueueOutboxCommit,
  syncPullOnce,
  syncPushOnce,
} from '@syncular/client';
import type { ScenarioContext } from '../harness/types';

/**
 * Client enqueues multiple outbox commits while "offline" (no push),
 * then pushes all at once and a second client pulls to verify.
 */
export async function runOfflineWritesSyncOnReconnect(
  ctx: ScenarioContext
): Promise<void> {
  const client = ctx.clients[0]!;

  const sub = {
    id: 'tasks-p1',
    table: 'tasks',
    scopes: { user_id: ctx.userId, project_id: 'p1' },
  };

  // Bootstrap client (empty state)
  await syncPullOnce(client.db, client.transport, client.handlers, {
    clientId: client.clientId,
    subscriptions: [sub],
  });

  // Go "offline" — enqueue 3 commits without pushing
  for (let i = 1; i <= 3; i++) {
    await enqueueOutboxCommit(client.db, {
      schemaVersion: 1,
      operations: [
        {
          table: 'tasks',
          row_id: `offline-${i}`,
          op: 'upsert',
          payload: {
            title: `Offline Task ${i}`,
            completed: 0,
            project_id: 'p1',
          },
          base_version: null,
        },
      ],
    });
  }

  // Verify outbox has 3 pending commits
  const outbox = await client.db
    .selectFrom('sync_outbox_commits')
    .selectAll()
    .where('status', '=', 'pending')
    .execute();
  expect(outbox.length).toBe(3);

  // "Reconnect" — push all pending commits
  for (let i = 0; i < 3; i++) {
    const pushResult = await syncPushOnce(client.db, client.transport, {
      clientId: client.clientId,
    });
    expect(pushResult.pushed).toBe(true);
    expect(pushResult.response?.status).toBe('applied');
  }

  // Second client bootstraps and should see all 3 tasks
  const client2 = await ctx.createClient({
    actorId: ctx.userId,
    clientId: 'client-2',
  });

  await syncPullOnce(client2.db, client2.transport, client2.handlers, {
    clientId: client2.clientId,
    subscriptions: [sub],
  });

  const client2Tasks = await client2.db
    .selectFrom('tasks')
    .selectAll()
    .orderBy('id', 'asc')
    .execute();
  expect(client2Tasks.length).toBe(3);
  expect(client2Tasks.map((t) => t.id)).toEqual([
    'offline-1',
    'offline-2',
    'offline-3',
  ]);
}

/**
 * Client A goes offline and enqueues locally, while Client B pushes changes.
 * When Client A comes back online (push then pull), both sets of changes are present.
 */
export async function runOfflineWithConcurrentChanges(
  ctx: ScenarioContext
): Promise<void> {
  const clientA = ctx.clients[0]!;

  const sub = {
    id: 'tasks-p1',
    table: 'tasks',
    scopes: { user_id: ctx.userId, project_id: 'p1' },
  };

  // Bootstrap Client A
  await syncPullOnce(clientA.db, clientA.transport, clientA.handlers, {
    clientId: clientA.clientId,
    subscriptions: [sub],
  });

  // Client A goes "offline" — enqueue locally
  await enqueueOutboxCommit(clientA.db, {
    schemaVersion: 1,
    operations: [
      {
        table: 'tasks',
        row_id: 'a-task',
        op: 'upsert',
        payload: { title: 'From A (offline)', completed: 0, project_id: 'p1' },
        base_version: null,
      },
    ],
  });

  // Meanwhile, Client B pushes changes via transport
  const clientB = await ctx.createClient({
    actorId: ctx.userId,
    clientId: 'client-b',
  });

  await syncPullOnce(clientB.db, clientB.transport, clientB.handlers, {
    clientId: clientB.clientId,
    subscriptions: [sub],
  });

  await enqueueOutboxCommit(clientB.db, {
    schemaVersion: 1,
    operations: [
      {
        table: 'tasks',
        row_id: 'b-task',
        op: 'upsert',
        payload: {
          title: 'From B (online)',
          completed: 1,
          project_id: 'p1',
        },
        base_version: null,
      },
    ],
  });

  const pushB = await syncPushOnce(clientB.db, clientB.transport, {
    clientId: clientB.clientId,
  });
  expect(pushB.response?.status).toBe('applied');

  // Client A "reconnects" — push first, then pull
  const pushA = await syncPushOnce(clientA.db, clientA.transport, {
    clientId: clientA.clientId,
  });
  expect(pushA.response?.status).toBe('applied');

  await syncPullOnce(clientA.db, clientA.transport, clientA.handlers, {
    clientId: clientA.clientId,
    subscriptions: [sub],
  });

  // Client A should have both tasks
  const aTasks = await clientA.db
    .selectFrom('tasks')
    .selectAll()
    .orderBy('id', 'asc')
    .execute();
  expect(aTasks.length).toBe(2);
  expect(aTasks.map((t) => t.id)).toEqual(['a-task', 'b-task']);
}

/**
 * Client enqueues a commit, pushes (gets an error due to server rejection),
 * fixes the issue, and pushes successfully.
 */
export async function runOutboxRetryAfterFailure(
  ctx: ScenarioContext
): Promise<void> {
  const client = ctx.clients[0]!;

  const sub = {
    id: 'tasks-p1',
    table: 'tasks',
    scopes: { user_id: ctx.userId, project_id: 'p1' },
  };

  // Bootstrap
  await syncPullOnce(client.db, client.transport, client.handlers, {
    clientId: client.clientId,
    subscriptions: [sub],
  });

  // Push a task missing project_id → server rejects with error
  await enqueueOutboxCommit(client.db, {
    schemaVersion: 1,
    operations: [
      {
        table: 'tasks',
        row_id: 'bad-task',
        op: 'upsert',
        payload: { title: 'Missing project' },
        base_version: null,
      },
    ],
  });

  const push1 = await syncPushOnce(client.db, client.transport, {
    clientId: client.clientId,
  });
  expect(push1.pushed).toBe(true);
  expect(push1.response?.status).toBe('rejected');

  // Verify the outbox commit is marked as failed
  const failedCommits = await client.db
    .selectFrom('sync_outbox_commits')
    .selectAll()
    .where('status', '=', 'failed')
    .execute();
  expect(failedCommits.length).toBe(1);

  // Enqueue a correct commit
  await enqueueOutboxCommit(client.db, {
    schemaVersion: 1,
    operations: [
      {
        table: 'tasks',
        row_id: 'good-task',
        op: 'upsert',
        payload: {
          title: 'Good Task',
          completed: 0,
          project_id: 'p1',
        },
        base_version: null,
      },
    ],
  });

  const push2 = await syncPushOnce(client.db, client.transport, {
    clientId: client.clientId,
  });
  expect(push2.pushed).toBe(true);
  expect(push2.response?.status).toBe('applied');

  // Server has the good task
  const serverTasks = await ctx.server.db
    .selectFrom('tasks')
    .selectAll()
    .execute();
  expect(serverTasks.some((t) => t.id === 'good-task')).toBe(true);
}
