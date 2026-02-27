/**
 * Subscription scenarios - Tests scope-based filtering, adding subs without
 * reset, deduplication, cursor correction, and forced re-bootstrap.
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

export async function runSubscriptionScenario(
  ctx: ScenarioContext
): Promise<void> {
  const { server } = ctx;
  const client = ctx.clients[0]!;

  const subP1 = {
    id: 'p1',
    table: 'tasks',
    scopes: { user_id: ctx.userId, project_id: 'p1' },
  };

  // Seed server with a task in p1
  await server.db
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

  // Bootstrap p1
  const bootstrap = await syncPullOnce(
    client.db,
    client.transport,
    client.handlers,
    {
      clientId: client.clientId,
      subscriptions: [subP1],
    }
  );
  expect(bootstrap.subscriptions.find((s) => s.id === 'p1')?.bootstrap).toBe(
    true
  );

  const afterBootstrap = await client.db
    .selectFrom('tasks')
    .selectAll()
    .execute();
  expect(afterBootstrap.map((t) => t.id)).toEqual(['seed']);

  // Push a local commit (create t1 in p1)
  await enqueueOutboxCommit(client.db, {
    schemaVersion: 1,
    operations: [
      {
        table: 'tasks',
        row_id: 't1',
        op: 'upsert',
        payload: { title: 'Hello', completed: 1, project_id: 'p1' },
        base_version: null,
      },
    ],
  });

  const pushRes = await syncPushOnce(client.db, client.transport, {
    clientId: client.clientId,
  });
  expect(pushRes.pushed).toBe(true);
  expect(pushRes.response?.status).toBe('applied');

  // Pull incremental
  const inc = await syncPullOnce(client.db, client.transport, client.handlers, {
    clientId: client.clientId,
    subscriptions: [subP1],
  });
  expect(inc.subscriptions.find((s) => s.id === 'p1')?.bootstrap).toBe(false);

  const afterInc = await client.db
    .selectFrom('tasks')
    .selectAll()
    .orderBy('id', 'asc')
    .execute();
  expect(afterInc.map((t) => t.id)).toEqual(['seed', 't1']);

  // Another actor pushes data (should NOT be visible due to scope isolation)
  const nativeFetch = (globalThis as Record<string, unknown>).__nativeFetch as
    | typeof globalThis.fetch
    | undefined;
  const u2Transport = createHttpTransport({
    baseUrl: server.baseUrl,
    getHeaders: () => ({ 'x-actor-id': 'u2' }),
    ...(nativeFetch && { fetch: nativeFetch }),
  });

  await u2Transport.sync({
    clientId: 'client-u2',
    push: {
      clientCommitId: 'commit-u2-1',
      schemaVersion: 1,
      operations: [
        {
          table: 'tasks',
          row_id: 't2',
          op: 'upsert',
          payload: { title: 'Nope', completed: 0, project_id: 'p1' },
          base_version: null,
        },
      ],
    },
  });

  // Pull should NOT receive u2's changes
  await syncPullOnce(client.db, client.transport, client.handlers, {
    clientId: client.clientId,
    subscriptions: [subP1],
  });

  const afterInc2 = await client.db
    .selectFrom('tasks')
    .selectAll()
    .orderBy('id', 'asc')
    .execute();
  expect(afterInc2.map((t) => t.id)).toEqual(['seed', 't1']);
}

export async function runAddSubscriptionScenario(
  ctx: ScenarioContext
): Promise<void> {
  const { server } = ctx;
  const client = ctx.clients[0]!;

  const subP1 = {
    id: 'p1',
    table: 'tasks',
    scopes: { user_id: ctx.userId, project_id: 'p1' },
  };
  const subP2 = {
    id: 'p2',
    table: 'tasks',
    scopes: { user_id: ctx.userId, project_id: 'p2' },
  };

  await server.db
    .insertInto('tasks')
    .values([
      {
        id: 'p1-seed',
        title: 'P1',
        completed: 0,
        user_id: ctx.userId,
        project_id: 'p1',
        server_version: 1,
      },
      {
        id: 'p2-seed',
        title: 'P2',
        completed: 0,
        user_id: ctx.userId,
        project_id: 'p2',
        server_version: 1,
      },
    ])
    .execute();

  // First: sync only p1
  const first = await syncPullOnce(
    client.db,
    client.transport,
    client.handlers,
    {
      clientId: client.clientId,
      subscriptions: [subP1],
    }
  );
  expect(first.subscriptions.find((s) => s.id === 'p1')?.bootstrap).toBe(true);

  const rows1 = await client.db
    .selectFrom('tasks')
    .selectAll()
    .orderBy('id', 'asc')
    .execute();
  expect(rows1.map((t) => t.id)).toEqual(['p1-seed']);

  // Then: add p2 (p1 should not re-bootstrap)
  const second = await syncPullOnce(
    client.db,
    client.transport,
    client.handlers,
    {
      clientId: client.clientId,
      subscriptions: [subP1, subP2],
    }
  );

  expect(second.subscriptions.find((s) => s.id === 'p1')?.bootstrap).toBe(
    false
  );
  expect(second.subscriptions.find((s) => s.id === 'p2')?.bootstrap).toBe(true);

  const rows2 = await client.db
    .selectFrom('tasks')
    .selectAll()
    .orderBy('id', 'asc')
    .execute();
  expect(rows2.map((t) => t.id)).toEqual(['p1-seed', 'p2-seed']);
}

export async function runSubscriptionReshapeScenario(
  ctx: ScenarioContext
): Promise<void> {
  const { server } = ctx;
  const client = ctx.clients[0]!;

  const subP1 = {
    id: 'p1',
    table: 'tasks',
    scopes: { user_id: ctx.userId, project_id: 'p1' },
  };
  const subP2 = {
    id: 'p2',
    table: 'tasks',
    scopes: { user_id: ctx.userId, project_id: 'p2' },
  };
  const subP3 = {
    id: 'p3',
    table: 'tasks',
    scopes: { user_id: ctx.userId, project_id: 'p3' },
  };

  await server.db
    .insertInto('tasks')
    .values([
      {
        id: 'reshape-p1-seed',
        title: 'P1 Seed',
        completed: 0,
        user_id: ctx.userId,
        project_id: 'p1',
        server_version: 1,
      },
      {
        id: 'reshape-p2-seed',
        title: 'P2 Seed',
        completed: 0,
        user_id: ctx.userId,
        project_id: 'p2',
        server_version: 1,
      },
      {
        id: 'reshape-p3-seed',
        title: 'P3 Seed',
        completed: 0,
        user_id: ctx.userId,
        project_id: 'p3',
        server_version: 1,
      },
    ])
    .execute();

  const initial = await syncPullOnce(
    client.db,
    client.transport,
    client.handlers,
    {
      clientId: client.clientId,
      subscriptions: [subP1, subP2],
    }
  );
  expect(
    initial.subscriptions.find((entry) => entry.id === subP1.id)?.bootstrap
  ).toBe(true);
  expect(
    initial.subscriptions.find((entry) => entry.id === subP2.id)?.bootstrap
  ).toBe(true);

  const firstRows = await client.db
    .selectFrom('tasks')
    .select(['id'])
    .orderBy('id', 'asc')
    .execute();
  expect(firstRows.map((row) => row.id)).toEqual([
    'reshape-p1-seed',
    'reshape-p2-seed',
  ]);

  const narrow = await syncPullOnce(
    client.db,
    client.transport,
    client.handlers,
    {
      clientId: client.clientId,
      subscriptions: [subP2],
    }
  );
  expect(
    narrow.subscriptions.find((entry) => entry.id === subP2.id)?.bootstrap
  ).toBe(false);

  const narrowedRows = await client.db
    .selectFrom('tasks')
    .select(['id'])
    .orderBy('id', 'asc')
    .execute();
  expect(narrowedRows.map((row) => row.id)).toEqual(['reshape-p2-seed']);

  const widen = await syncPullOnce(
    client.db,
    client.transport,
    client.handlers,
    {
      clientId: client.clientId,
      subscriptions: [subP2, subP3],
    }
  );
  expect(
    widen.subscriptions.find((entry) => entry.id === subP2.id)?.bootstrap
  ).toBe(false);
  expect(
    widen.subscriptions.find((entry) => entry.id === subP3.id)?.bootstrap
  ).toBe(true);

  await client.transport.sync({
    clientId: client.clientId,
    push: {
      clientCommitId: 'reshape-p3-write',
      schemaVersion: 1,
      operations: [
        {
          table: 'tasks',
          row_id: 'reshape-p3-new',
          op: 'upsert',
          payload: {
            title: 'P3 New',
            completed: 0,
            project_id: 'p3',
          },
          base_version: null,
        },
      ],
    },
  });

  await syncPullOnce(client.db, client.transport, client.handlers, {
    clientId: client.clientId,
    subscriptions: [subP3],
  });

  const finalRows = await client.db
    .selectFrom('tasks')
    .select(['id'])
    .orderBy('id', 'asc')
    .execute();
  expect(finalRows.map((row) => row.id)).toEqual([
    'reshape-p3-new',
    'reshape-p3-seed',
  ]);
}

export async function runDedupeScenario(ctx: ScenarioContext): Promise<void> {
  const client = ctx.clients[0]!;

  const subP1 = {
    id: 'p1',
    table: 'tasks',
    scopes: { user_id: ctx.userId, project_id: 'p1' },
  };

  // Bootstrap empty state
  await syncPullOnce(client.db, client.transport, client.handlers, {
    clientId: client.clientId,
    subscriptions: [subP1],
  });

  // Push multiple commits updating the same row
  for (let i = 1; i <= 3; i++) {
    await client.transport.sync({
      clientId: client.clientId,
      push: {
        clientCommitId: `hot-${i}`,
        schemaVersion: 1,
        operations: [
          {
            table: 'tasks',
            row_id: 't1',
            op: 'upsert',
            payload: { title: `v${i}`, completed: 0, project_id: 'p1' },
            base_version: null,
          },
        ],
      },
    });
  }

  const res = await syncPullOnce(client.db, client.transport, client.handlers, {
    clientId: client.clientId,
    subscriptions: [subP1],
    dedupeRows: true,
    limitCommits: 50,
  });

  const subRes = res.subscriptions.find((s) => s.id === 'p1');
  expect(subRes?.bootstrap).toBe(false);
  expect(subRes?.nextCursor).toBe(3);
  expect(subRes?.commits.length).toBe(1);
  expect(subRes?.commits[0]?.commitSeq).toBe(3);
  expect(subRes?.commits[0]?.changes.length).toBe(1);
  const changeRowJson = subRes?.commits[0]?.changes[0]?.row_json as
    | Record<string, unknown>
    | undefined;
  expect(changeRowJson?.title).toBe('v3');

  const row = await client.db
    .selectFrom('tasks')
    .selectAll()
    .where('id', '=', 't1')
    .executeTakeFirstOrThrow();
  expect(row.title).toBe('v3');
  expect(row.server_version).toBe(3);
}

export async function runForcedBootstrapAfterPruneScenario(
  ctx: ScenarioContext
): Promise<void> {
  const { server } = ctx;
  const client = ctx.clients[0]!;

  // Create a second client for the "fast" client
  const fastClient = await ctx.createClient({
    actorId: ctx.userId,
    clientId: 'client-fast',
  });

  const subP1 = {
    id: 'p1',
    table: 'tasks',
    scopes: { user_id: ctx.userId, project_id: 'p1' },
  };

  // Seed server
  await server.db
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

  // Create 10 commits
  for (let i = 1; i <= 10; i++) {
    await fastClient.transport.sync({
      clientId: fastClient.clientId,
      push: {
        clientCommitId: `c${i}`,
        schemaVersion: 1,
        operations: [
          {
            table: 'tasks',
            row_id: `t${i}`,
            op: 'upsert',
            payload: { title: `Task ${i}`, completed: 0, project_id: 'p1' },
            base_version: null,
          },
        ],
      },
    });
  }

  // Fast client bootstraps
  const fastBootstrap = await syncPullOnce(
    fastClient.db,
    fastClient.transport,
    fastClient.handlers,
    {
      clientId: fastClient.clientId,
      subscriptions: [subP1],
    }
  );
  expect(
    fastBootstrap.subscriptions.find((s) => s.id === 'p1')?.bootstrap
  ).toBe(true);

  // Prune old commits
  const watermark = await computePruneWatermarkCommitSeq(server.db, {
    activeWindowMs: 24 * 60 * 60 * 1000,
    keepNewestCommits: 5,
  });
  expect(watermark).toBeGreaterThanOrEqual(10);

  await pruneSync(server.db, {
    watermarkCommitSeq: watermark,
    keepNewestCommits: 5,
  });

  // Old client at cursor 0 should be forced to bootstrap
  await client.db
    .insertInto('sync_subscription_state')
    .values({
      state_id: 'default',
      subscription_id: 'p1',
      table: 'tasks',
      scopes_json: JSON.stringify({ user_id: ctx.userId, project_id: 'p1' }),
      params_json: JSON.stringify({}),
      cursor: 0,
      bootstrap_state_json: null,
      status: 'active',
      created_at: Date.now(),
      updated_at: Date.now(),
    })
    .execute();

  const oldRes = await syncPullOnce(
    client.db,
    client.transport,
    client.handlers,
    {
      clientId: client.clientId,
      subscriptions: [subP1],
    }
  );
  expect(oldRes.subscriptions.find((s) => s.id === 'p1')?.bootstrap).toBe(true);

  const rows = await client.db.selectFrom('tasks').selectAll().execute();
  expect(rows.length).toBe(11); // seed + t1..t10
}

export async function runCursorAheadScenario(
  ctx: ScenarioContext
): Promise<void> {
  const { server } = ctx;
  const client = ctx.clients[0]!;

  const subP1 = {
    id: 'p1',
    table: 'tasks',
    scopes: { user_id: ctx.userId, project_id: 'p1' },
  };

  // Seed server
  await server.db
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

  // Create some commits
  for (let i = 1; i <= 3; i++) {
    await client.transport.sync({
      clientId: 'client-fast',
      push: {
        clientCommitId: `c${i}`,
        schemaVersion: 1,
        operations: [
          {
            table: 'tasks',
            row_id: `t${i}`,
            op: 'upsert',
            payload: { title: `Task ${i}`, completed: 0, project_id: 'p1' },
            base_version: null,
          },
        ],
      },
    });
  }

  // Client thinks it's far ahead (simulating server restore)
  await client.db
    .insertInto('sync_subscription_state')
    .values({
      state_id: 'default',
      subscription_id: 'p1',
      table: 'tasks',
      scopes_json: JSON.stringify({ user_id: ctx.userId, project_id: 'p1' }),
      params_json: JSON.stringify({}),
      cursor: 100,
      bootstrap_state_json: null,
      status: 'active',
      created_at: Date.now(),
      updated_at: Date.now(),
    })
    .execute();

  const res = await syncPullOnce(client.db, client.transport, client.handlers, {
    clientId: client.clientId,
    subscriptions: [subP1],
  });

  const subRes = res.subscriptions.find((s) => s.id === 'p1');
  expect(subRes?.bootstrap).toBe(true);
  expect(subRes?.nextCursor).toBe(3);

  // After cursor correction, incremental pulls must work
  await client.transport.sync({
    clientId: 'client-fast',
    push: {
      clientCommitId: 'c4',
      schemaVersion: 1,
      operations: [
        {
          table: 'tasks',
          row_id: 't4',
          op: 'upsert',
          payload: { title: 'Task 4', completed: 0, project_id: 'p1' },
          base_version: null,
        },
      ],
    },
  });

  const inc = await syncPullOnce(client.db, client.transport, client.handlers, {
    clientId: client.clientId,
    subscriptions: [subP1],
  });

  expect(inc.subscriptions.find((s) => s.id === 'p1')?.bootstrap).toBe(false);

  const rows = await client.db
    .selectFrom('tasks')
    .selectAll()
    .orderBy('id', 'asc')
    .execute();
  expect(rows.map((t) => t.id)).toEqual(['seed', 't1', 't2', 't3', 't4']);
}
