/**
 * Auth enforcement scenarios - Verifies scope resolution rejects unauthorized actors.
 */

import { expect } from 'bun:test';
import {
  enqueueOutboxCommit,
  syncPullOnce,
  syncPushOnce,
} from '@syncular/client';
import { createHttpTransport } from '@syncular/transport-http';
import type { ScenarioContext } from '../harness/types';

const nativeFetch = (globalThis as Record<string, unknown>).__nativeFetch as
  | typeof globalThis.fetch
  | undefined;

/**
 * Client subscribes with a different user_id than their actorId.
 * The server's resolveScopes returns only the actor's own user_id,
 * so the subscription should be narrowed and the other user's data excluded.
 */
export async function runCrossScopePullRejected(
  ctx: ScenarioContext
): Promise<void> {
  const { server } = ctx;
  const client = ctx.clients[0]!;

  // Seed data for two users
  await server.db
    .insertInto('tasks')
    .values([
      {
        id: 'u1-task',
        title: 'User 1 task',
        completed: 0,
        user_id: ctx.userId,
        project_id: 'p1',
        server_version: 1,
      },
      {
        id: 'u2-task',
        title: 'User 2 task',
        completed: 0,
        user_id: 'other-user',
        project_id: 'p1',
        server_version: 1,
      },
    ])
    .execute();

  // Client (acting as test-user) subscribes requesting their own scope
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

  const subResult = result.subscriptions.find((s) => s.id === 'my-tasks');
  expect(subResult?.status).toBe('active');

  // Client should only see their own task
  const tasks = await client.db
    .selectFrom('tasks')
    .selectAll()
    .orderBy('id', 'asc')
    .execute();
  expect(tasks.length).toBe(1);
  expect(tasks[0]?.id).toBe('u1-task');
}

/**
 * Client requests multiple project scopes but resolveScopes allows all.
 * Verifies narrowed scope filtering works correctly.
 */
export async function runNarrowedScopes(ctx: ScenarioContext): Promise<void> {
  const { server } = ctx;
  const client = ctx.clients[0]!;

  // Seed data across two projects
  await server.db
    .insertInto('tasks')
    .values([
      {
        id: 't-p1',
        title: 'P1 Task',
        completed: 0,
        user_id: ctx.userId,
        project_id: 'p1',
        server_version: 1,
      },
      {
        id: 't-p2',
        title: 'P2 Task',
        completed: 0,
        user_id: ctx.userId,
        project_id: 'p2',
        server_version: 1,
      },
    ])
    .execute();

  // Subscribe to both projects separately
  const result = await syncPullOnce(
    client.db,
    client.transport,
    client.handlers,
    {
      clientId: client.clientId,
      subscriptions: [
        {
          id: 'sub-p1',
          table: 'tasks',
          scopes: { user_id: ctx.userId, project_id: 'p1' },
        },
        {
          id: 'sub-p2',
          table: 'tasks',
          scopes: { user_id: ctx.userId, project_id: 'p2' },
        },
      ],
    }
  );

  // Both should be active
  expect(result.subscriptions.find((s) => s.id === 'sub-p1')?.status).toBe(
    'active'
  );
  expect(result.subscriptions.find((s) => s.id === 'sub-p2')?.status).toBe(
    'active'
  );

  // Should have both tasks
  const tasks = await client.db
    .selectFrom('tasks')
    .selectAll()
    .orderBy('id', 'asc')
    .execute();
  expect(tasks.length).toBe(2);
  expect(tasks.map((t) => t.id)).toEqual(['t-p1', 't-p2']);
}

/**
 * An attacker pushes data. It lands under the attacker's user_id scope,
 * not the victim's scope, so the victim never sees it.
 */
export async function runPushToUnauthorizedScope(
  ctx: ScenarioContext
): Promise<void> {
  const { server } = ctx;

  // Seed a task belonging to test-user
  await server.db
    .insertInto('tasks')
    .values({
      id: 'target-task',
      title: 'Original',
      completed: 0,
      user_id: ctx.userId,
      project_id: 'p1',
      server_version: 1,
    })
    .execute();

  // Attacker pushes their own task (different row_id)
  const attackerTransport = createHttpTransport({
    baseUrl: server.baseUrl,
    getHeaders: () => ({ 'x-actor-id': 'attacker' }),
    ...(nativeFetch && { fetch: nativeFetch }),
  });

  const combined = await attackerTransport.sync({
    clientId: 'attacker-client',
    push: {
      clientCommitId: 'attack-1',
      schemaVersion: 1,
      operations: [
        {
          table: 'tasks',
          row_id: 'attacker-task',
          op: 'upsert',
          payload: { title: 'Attacker Task', completed: 0, project_id: 'p1' },
          base_version: null,
        },
      ],
    },
  });
  expect(combined.push!.ok).toBe(true);

  // Victim client pulls — should NOT see attacker's task
  const client = ctx.clients[0]!;
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

  const victimTasks = await client.db.selectFrom('tasks').selectAll().execute();
  // Victim sees only their own task, not the attacker's
  expect(victimTasks.length).toBe(1);
  expect(victimTasks[0]?.id).toBe('target-task');
  expect(victimTasks[0]?.title).toBe('Original');
}

/**
 * Different actors have isolated data views even when subscribing to the same project.
 * Actor A's changes are invisible to Actor B and vice versa.
 */
export async function runActorIsolation(ctx: ScenarioContext): Promise<void> {
  // Create two clients with different actors
  const clientA = ctx.clients[0]!;
  const clientB = await ctx.createClient({
    actorId: 'actor-b',
    clientId: 'client-b',
  });

  const sub = {
    id: 'tasks-p1',
    table: 'tasks',
    scopes: { user_id: ctx.userId, project_id: 'p1' },
  };
  const subB = {
    id: 'tasks-p1',
    table: 'tasks',
    scopes: { user_id: 'actor-b', project_id: 'p1' },
  };

  // Bootstrap both clients
  await syncPullOnce(clientA.db, clientA.transport, clientA.handlers, {
    clientId: clientA.clientId,
    subscriptions: [sub],
  });
  await syncPullOnce(clientB.db, clientB.transport, clientB.handlers, {
    clientId: clientB.clientId,
    subscriptions: [subB],
  });

  // Actor A pushes a task
  await enqueueOutboxCommit(clientA.db, {
    schemaVersion: 1,
    operations: [
      {
        table: 'tasks',
        row_id: 'a-only',
        op: 'upsert',
        payload: { title: 'A only', completed: 0, project_id: 'p1' },
        base_version: null,
      },
    ],
  });
  const pushA = await syncPushOnce(clientA.db, clientA.transport, {
    clientId: clientA.clientId,
  });
  expect(pushA.response?.status).toBe('applied');

  // Actor B pushes a task
  await enqueueOutboxCommit(clientB.db, {
    schemaVersion: 1,
    operations: [
      {
        table: 'tasks',
        row_id: 'b-only',
        op: 'upsert',
        payload: { title: 'B only', completed: 0, project_id: 'p1' },
        base_version: null,
      },
    ],
  });
  const pushB = await syncPushOnce(clientB.db, clientB.transport, {
    clientId: clientB.clientId,
  });
  expect(pushB.response?.status).toBe('applied');

  // Pull for both
  await syncPullOnce(clientA.db, clientA.transport, clientA.handlers, {
    clientId: clientA.clientId,
    subscriptions: [sub],
  });
  await syncPullOnce(clientB.db, clientB.transport, clientB.handlers, {
    clientId: clientB.clientId,
    subscriptions: [subB],
  });

  // A should only see A's task
  const aTasks = await clientA.db.selectFrom('tasks').selectAll().execute();
  expect(aTasks.length).toBe(1);
  expect(aTasks[0]?.id).toBe('a-only');

  // B should only see B's task
  const bTasks = await clientB.db.selectFrom('tasks').selectAll().execute();
  expect(bTasks.length).toBe(1);
  expect(bTasks[0]?.id).toBe('b-only');
}
