/**
 * Auth enforcement scenarios - Verifies scope resolution rejects unauthorized actors.
 */

import { expect } from 'bun:test';
import {
  enqueueOutboxCommit,
  syncPullOnce,
  syncPushOnce,
} from '@syncular/client';
import { computePruneWatermarkCommitSeq, pruneSync } from '@syncular/server';
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

/**
 * Client reconnects with changed auth scope on the same client id.
 * Unauthorized prior subscription scope must be revoked with no data leak,
 * while authorized scope continues syncing normally.
 */
export async function runReconnectStaleScopeRevocation(
  ctx: ScenarioContext
): Promise<void> {
  const client = ctx.clients[0]!;
  const staleSub = {
    id: 'tasks-p1',
    table: 'tasks',
    scopes: { user_id: ctx.userId, project_id: 'p1' },
  };
  const authorizedSub = {
    id: 'tasks-p1',
    table: 'tasks',
    scopes: { user_id: 'other-user', project_id: 'p1' },
  };

  await ctx.server.db
    .insertInto('tasks')
    .values([
      {
        id: 'u1-visible',
        title: 'U1 Visible',
        completed: 0,
        user_id: ctx.userId,
        project_id: 'p1',
        server_version: 1,
      },
      {
        id: 'u2-visible',
        title: 'U2 Visible',
        completed: 0,
        user_id: 'other-user',
        project_id: 'p1',
        server_version: 1,
      },
    ])
    .execute();

  const firstPull = await syncPullOnce(
    client.db,
    client.transport,
    client.handlers,
    {
      clientId: client.clientId,
      subscriptions: [staleSub],
    }
  );
  expect(
    firstPull.subscriptions.find((s) => s.id === staleSub.id)?.status
  ).toBe('active');

  const beforeRows = await client.db
    .selectFrom('tasks')
    .select(['id'])
    .orderBy('id', 'asc')
    .execute();
  expect(beforeRows.map((row) => row.id)).toEqual(['u1-visible']);

  const reconnectTransport = createHttpTransport({
    baseUrl: ctx.server.baseUrl,
    getHeaders: () => ({ 'x-actor-id': 'other-user' }),
    ...(nativeFetch ? { fetch: nativeFetch } : {}),
  });

  const reconnectPull = await syncPullOnce(
    client.db,
    reconnectTransport,
    client.handlers,
    {
      clientId: client.clientId,
      subscriptions: [staleSub],
    }
  );
  const reconnectSub = reconnectPull.subscriptions.find(
    (entry) => entry.id === staleSub.id
  );
  expect(reconnectSub?.status).toBe('revoked');

  const afterRevokeRows = await client.db
    .selectFrom('tasks')
    .select(['id', 'user_id'])
    .orderBy('id', 'asc')
    .execute();
  expect(afterRevokeRows.length).toBe(0);

  const authorizedPull = await syncPullOnce(
    client.db,
    reconnectTransport,
    client.handlers,
    {
      clientId: client.clientId,
      subscriptions: [authorizedSub],
    }
  );
  const authorizedSubResult = authorizedPull.subscriptions.find(
    (entry) => entry.id === authorizedSub.id
  );
  expect(authorizedSubResult?.status).toBe('active');
  expect(authorizedSubResult?.bootstrap).toBe(true);

  const afterRows = await client.db
    .selectFrom('tasks')
    .select(['id', 'user_id'])
    .orderBy('id', 'asc')
    .execute();
  expect(afterRows.map((row) => row.id)).toEqual(['u2-visible']);
  expect(afterRows[0]?.user_id).toBe('other-user');

  const pushed = await reconnectTransport.sync({
    clientId: client.clientId,
    push: {
      clientCommitId: 'other-user-reconnect-commit',
      schemaVersion: 1,
      operations: [
        {
          table: 'tasks',
          row_id: 'u2-after-reconnect',
          op: 'upsert',
          payload: {
            title: 'U2 After Reconnect',
            completed: 0,
            project_id: 'p1',
          },
          base_version: null,
        },
      ],
    },
  });
  expect(pushed.push?.status).toBe('applied');

  await syncPullOnce(client.db, reconnectTransport, client.handlers, {
    clientId: client.clientId,
    subscriptions: [authorizedSub],
    limitCommits: 50,
  });

  const continuedRows = await client.db
    .selectFrom('tasks')
    .select(['id'])
    .orderBy('id', 'asc')
    .execute();
  expect(continuedRows.map((row) => row.id)).toEqual([
    'u2-after-reconnect',
    'u2-visible',
  ]);

  const stateRow = await client.db
    .selectFrom('sync_subscription_state')
    .select(['scopes_json'])
    .where('subscription_id', '=', authorizedSub.id)
    .executeTakeFirst();
  const scopesText =
    typeof stateRow?.scopes_json === 'string'
      ? stateRow.scopes_json
      : JSON.stringify(stateRow?.scopes_json ?? {});
  expect(scopesText).toContain('other-user');
}

export async function runReconnectScopeChangeStormScenario(
  ctx: ScenarioContext
): Promise<void> {
  const client = ctx.clients[0]!;

  await ctx.server.db
    .insertInto('tasks')
    .values([
      {
        id: 'storm-seed-u1',
        title: 'Storm Seed U1',
        completed: 0,
        user_id: ctx.userId,
        project_id: 'p1',
        server_version: 1,
      },
      {
        id: 'storm-seed-u2',
        title: 'Storm Seed U2',
        completed: 0,
        user_id: 'other-user',
        project_id: 'p1',
        server_version: 1,
      },
    ])
    .execute();

  const transportFor = (actorId: string) =>
    createHttpTransport({
      baseUrl: ctx.server.baseUrl,
      getHeaders: () => ({ 'x-actor-id': actorId }),
      ...(nativeFetch ? { fetch: nativeFetch } : {}),
    });

  const subFor = (userId: string) => ({
    id: 'tasks-p1',
    table: 'tasks',
    scopes: { user_id: userId, project_id: 'p1' },
  });

  const actors = [ctx.userId, 'other-user', ctx.userId, 'other-user'];
  for (let i = 0; i < actors.length; i += 1) {
    const actorId = actors[i]!;
    const unauthorizedUserId =
      actorId === ctx.userId ? 'other-user' : ctx.userId;
    const transport = transportFor(actorId);

    const revoked = await syncPullOnce(client.db, transport, client.handlers, {
      clientId: client.clientId,
      subscriptions: [subFor(unauthorizedUserId)],
    });
    expect(
      revoked.subscriptions.find((entry) => entry.id === 'tasks-p1')?.status
    ).toBe('revoked');

    const authorized = await syncPullOnce(
      client.db,
      transport,
      client.handlers,
      {
        clientId: client.clientId,
        subscriptions: [subFor(actorId)],
      }
    );
    expect(
      authorized.subscriptions.find((entry) => entry.id === 'tasks-p1')?.status
    ).toBe('active');

    const pushResult = await transport.sync({
      clientId: client.clientId,
      push: {
        clientCommitId: `scope-storm-c${i + 1}`,
        schemaVersion: 1,
        operations: [
          {
            table: 'tasks',
            row_id: `scope-storm-${actorId}-${i + 1}`,
            op: 'upsert',
            payload: {
              title: `Scope Storm ${actorId} ${i + 1}`,
              completed: i % 2,
              project_id: 'p1',
            },
            base_version: null,
          },
        ],
      },
    });
    expect(pushResult.push?.status).toBe('applied');

    await syncPullOnce(client.db, transport, client.handlers, {
      clientId: client.clientId,
      subscriptions: [subFor(actorId)],
      limitCommits: 50,
    });

    const localRows = await client.db
      .selectFrom('tasks')
      .select(['id', 'user_id'])
      .orderBy('id', 'asc')
      .execute();
    expect(localRows.length).toBeGreaterThan(0);
    expect(localRows.every((row) => row.user_id === actorId)).toBe(true);
    expect(
      localRows.some((row) => row.id === `scope-storm-${actorId}-${i + 1}`)
    ).toBe(true);
    expect(localRows.some((row) => row.user_id === unauthorizedUserId)).toBe(
      false
    );
  }
}

/**
 * Multi-tenant isolation under high churn with reconnect + maintenance activity.
 * Verifies no cross-user leakage while compaction/prune run during concurrent writes.
 */
export async function runPartitionIsolationHighChurnScenario(
  ctx: ScenarioContext
): Promise<void> {
  const writerA = ctx.clients[0]!;
  const writerB = await ctx.createClient({
    actorId: 'tenant-b',
    clientId: 'tenant-b-writer',
  });
  const laggingA = await ctx.createClient({
    actorId: ctx.userId,
    clientId: 'tenant-a-lagging',
  });
  const laggingB = await ctx.createClient({
    actorId: 'tenant-b',
    clientId: 'tenant-b-lagging',
  });

  const subA = {
    id: 'tasks-a',
    table: 'tasks',
    scopes: { user_id: ctx.userId, project_id: 'p1' },
  };
  const subB = {
    id: 'tasks-b',
    table: 'tasks',
    scopes: { user_id: 'tenant-b', project_id: 'p1' },
  };

  await syncPullOnce(writerA.db, writerA.transport, writerA.handlers, {
    clientId: writerA.clientId,
    subscriptions: [subA],
  });
  await syncPullOnce(writerB.db, writerB.transport, writerB.handlers, {
    clientId: writerB.clientId,
    subscriptions: [subB],
  });
  await syncPullOnce(laggingA.db, laggingA.transport, laggingA.handlers, {
    clientId: laggingA.clientId,
    subscriptions: [subA],
  });
  await syncPullOnce(laggingB.db, laggingB.transport, laggingB.handlers, {
    clientId: laggingB.clientId,
    subscriptions: [subB],
  });

  const commitsPerTenant = 24;

  const pushTenantLoop = async (
    writer: typeof writerA,
    prefix: 'a' | 'b',
    userId: string
  ) => {
    for (let i = 1; i <= commitsPerTenant; i += 1) {
      const pushResult = await writer.transport.sync({
        clientId: writer.clientId,
        push: {
          clientCommitId: `${prefix}-tenant-c${i}`,
          schemaVersion: 1,
          operations: [
            {
              table: 'tasks',
              row_id: `${prefix}-tenant-task-${i}`,
              op: 'upsert',
              payload: {
                title: `Tenant ${prefix.toUpperCase()} Task ${i}`,
                completed: i % 2,
                project_id: 'p1',
              },
              base_version: null,
            },
          ],
        },
      });
      expect(pushResult.push?.status).toBe('applied');

      if (i % 4 === 0) {
        await syncPullOnce(writer.db, writer.transport, writer.handlers, {
          clientId: writer.clientId,
          subscriptions: [
            {
              id: `tasks-${prefix}`,
              table: 'tasks',
              scopes: { user_id: userId, project_id: 'p1' },
            },
          ],
          limitCommits: 30,
        });
      }
    }
  };

  const maintenanceLoop = async () => {
    for (let i = 0; i < 6; i += 1) {
      await Bun.sleep(5);

      await ctx.server.db
        .updateTable('sync_commits')
        .set({ created_at: '2000-01-01T00:00:00.000Z' })
        .execute();

      await ctx.server.dialect.compactChanges(ctx.server.db, {
        fullHistoryHours: 1,
      });

      const watermark = await computePruneWatermarkCommitSeq(ctx.server.db, {
        activeWindowMs: 60 * 1000,
        fallbackMaxAgeMs: 60 * 1000,
        keepNewestCommits: 16,
      });
      if (watermark <= 0) continue;

      await pruneSync(ctx.server.db, {
        watermarkCommitSeq: watermark,
        keepNewestCommits: 16,
      });
    }
  };

  await Promise.all([
    pushTenantLoop(writerA, 'a', ctx.userId),
    pushTenantLoop(writerB, 'b', 'tenant-b'),
    maintenanceLoop(),
  ]);

  const catchupA = await syncPullOnce(
    laggingA.db,
    laggingA.transport,
    laggingA.handlers,
    {
      clientId: laggingA.clientId,
      subscriptions: [subA],
      limitCommits: 50,
    }
  );
  const catchupB = await syncPullOnce(
    laggingB.db,
    laggingB.transport,
    laggingB.handlers,
    {
      clientId: laggingB.clientId,
      subscriptions: [subB],
      limitCommits: 50,
    }
  );

  expect(
    catchupA.subscriptions.find((entry) => entry.id === subA.id)?.status
  ).toBe('active');
  expect(
    catchupB.subscriptions.find((entry) => entry.id === subB.id)?.status
  ).toBe('active');

  const tenantARows = await laggingA.db
    .selectFrom('tasks')
    .select(['id', 'user_id'])
    .orderBy('id', 'asc')
    .execute();
  const tenantBRows = await laggingB.db
    .selectFrom('tasks')
    .select(['id', 'user_id'])
    .orderBy('id', 'asc')
    .execute();

  expect(tenantARows.length).toBe(commitsPerTenant);
  expect(tenantBRows.length).toBe(commitsPerTenant);
  expect(tenantARows.every((row) => row.user_id === ctx.userId)).toBe(true);
  expect(tenantBRows.every((row) => row.user_id === 'tenant-b')).toBe(true);
  expect(tenantARows.some((row) => row.id.startsWith('b-tenant-task-'))).toBe(
    false
  );
  expect(tenantBRows.some((row) => row.id.startsWith('a-tenant-task-'))).toBe(
    false
  );
}
