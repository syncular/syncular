/**
 * Reconnect + maintenance scenarios for transport failures and retention churn.
 */

import { expect } from 'bun:test';
import {
  applyPullResponse,
  buildPullRequest,
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

function createTasksSubscription(userId: string) {
  return {
    id: 'tasks-p1',
    table: 'tasks',
    scopes: { user_id: userId, project_id: 'p1' },
  } as const;
}

function createTransport(
  baseUrl: string,
  actorId: string,
  transportPath: 'direct' | 'relay',
  options?: { dropFirstResponse?: boolean }
) {
  if (options?.dropFirstResponse !== true) {
    return createHttpTransport({
      baseUrl,
      getHeaders: () => ({ 'x-actor-id': actorId }),
      transportPath,
      ...(nativeFetch ? { fetch: nativeFetch } : {}),
    });
  }

  let dropped = false;
  const flakyFetchBase = async (
    ...args: Parameters<typeof globalThis.fetch>
  ): Promise<Response> => {
    const response = await (nativeFetch ?? globalThis.fetch)(...args);
    if (!dropped && response.ok) {
      dropped = true;
      await response.arrayBuffer();
      throw new Error('SIMULATED_RECONNECT_DROP');
    }
    return response;
  };
  const flakyFetch = Object.assign(flakyFetchBase, {
    preconnect: (nativeFetch ?? globalThis.fetch).preconnect,
  });

  return createHttpTransport({
    baseUrl,
    getHeaders: () => ({ 'x-actor-id': actorId }),
    transportPath,
    fetch: flakyFetch,
  });
}

export async function runReconnectAckLossScenario(
  ctx: ScenarioContext
): Promise<void> {
  const client = ctx.clients[0]!;
  const sub = createTasksSubscription(ctx.userId);

  await syncPullOnce(client.db, client.transport, client.handlers, {
    clientId: client.clientId,
    subscriptions: [sub],
  });

  let dropFirstAck = true;
  const flakyFetchBase = async (
    ...args: Parameters<typeof globalThis.fetch>
  ): Promise<Response> => {
    const response = await globalThis.fetch(...args);
    if (dropFirstAck && response.ok) {
      dropFirstAck = false;
      await response.arrayBuffer();
      throw new Error('SIMULATED_PUSH_ACK_LOSS');
    }
    return response;
  };
  const flakyFetch = Object.assign(flakyFetchBase, {
    preconnect: globalThis.fetch.preconnect,
  });

  const flakyTransport = createHttpTransport({
    baseUrl: ctx.server.baseUrl,
    getHeaders: () => ({ 'x-actor-id': ctx.userId }),
    fetch: flakyFetch,
  });

  const clientCommitId = 'ack-loss-retry-commit';
  await enqueueOutboxCommit(client.db, {
    clientCommitId,
    schemaVersion: 1,
    operations: [
      {
        table: 'tasks',
        row_id: 'ack-loss-task',
        op: 'upsert',
        payload: {
          title: 'Ack loss task',
          completed: 0,
          project_id: 'p1',
        },
        base_version: null,
      },
    ],
  });

  await expect(
    syncPushOnce(client.db, flakyTransport, {
      clientId: client.clientId,
    })
  ).rejects.toThrow('SIMULATED_PUSH_ACK_LOSS');

  const pendingRow = await client.db
    .selectFrom('sync_outbox_commits')
    .select(({ fn }) => fn.countAll().as('total'))
    .where('status', '=', 'pending')
    .executeTakeFirst();
  expect(Number(pendingRow?.total ?? 0)).toBe(1);

  const retry = await syncPushOnce(client.db, client.transport, {
    clientId: client.clientId,
  });
  expect(retry.pushed).toBe(true);
  expect(retry.response?.status).toBe('cached');

  await syncPullOnce(client.db, client.transport, client.handlers, {
    clientId: client.clientId,
    subscriptions: [sub],
  });

  const clientTask = await client.db
    .selectFrom('tasks')
    .select(['id'])
    .where('id', '=', 'ack-loss-task')
    .executeTakeFirst();
  expect(clientTask?.id).toBe('ack-loss-task');

  const serverTaskCountRow = await ctx.server.db
    .selectFrom('tasks')
    .select(({ fn }) => fn.countAll().as('total'))
    .where('id', '=', 'ack-loss-task')
    .executeTakeFirst();
  expect(Number(serverTaskCountRow?.total ?? 0)).toBe(1);

  const serverCommitCountRow = await ctx.server.db
    .selectFrom('sync_commits')
    .select(({ fn }) => fn.countAll().as('total'))
    .where('client_commit_id', '=', clientCommitId)
    .executeTakeFirst();
  expect(Number(serverCommitCountRow?.total ?? 0)).toBe(1);
}

export async function runTransportPathParityScenario(
  ctx: ScenarioContext
): Promise<void> {
  const directClient = ctx.clients[0]!;
  const relayClient = await ctx.createClient({
    actorId: ctx.userId,
    clientId: 'relay-path-client',
  });
  const sub = createTasksSubscription(ctx.userId);

  const directTransport = createHttpTransport({
    baseUrl: ctx.server.baseUrl,
    getHeaders: () => ({ 'x-actor-id': ctx.userId }),
    transportPath: 'direct',
  });
  const relayTransport = createHttpTransport({
    baseUrl: ctx.server.baseUrl,
    getHeaders: () => ({ 'x-actor-id': ctx.userId }),
    transportPath: 'relay',
  });

  await syncPullOnce(directClient.db, directTransport, directClient.handlers, {
    clientId: directClient.clientId,
    subscriptions: [sub],
  });
  await syncPullOnce(relayClient.db, relayTransport, relayClient.handlers, {
    clientId: relayClient.clientId,
    subscriptions: [sub],
  });

  const directPush = await directTransport.sync({
    clientId: directClient.clientId,
    push: {
      clientCommitId: 'direct-path-commit',
      schemaVersion: 1,
      operations: [
        {
          table: 'tasks',
          row_id: 'path-direct-task',
          op: 'upsert',
          payload: {
            title: 'Direct path task',
            completed: 0,
            project_id: 'p1',
          },
          base_version: null,
        },
      ],
    },
  });
  expect(directPush.push?.status).toBe('applied');

  const relayPush = await relayTransport.sync({
    clientId: relayClient.clientId,
    push: {
      clientCommitId: 'relay-path-commit',
      schemaVersion: 1,
      operations: [
        {
          table: 'tasks',
          row_id: 'path-relay-task',
          op: 'upsert',
          payload: {
            title: 'Relay path task',
            completed: 1,
            project_id: 'p1',
          },
          base_version: null,
        },
      ],
    },
  });
  expect(relayPush.push?.status).toBe('applied');

  await syncPullOnce(directClient.db, directTransport, directClient.handlers, {
    clientId: directClient.clientId,
    subscriptions: [sub],
    limitCommits: 100,
  });
  await syncPullOnce(relayClient.db, relayTransport, relayClient.handlers, {
    clientId: relayClient.clientId,
    subscriptions: [sub],
    limitCommits: 100,
  });

  const directRows = await directClient.db
    .selectFrom('tasks')
    .select(['id'])
    .orderBy('id', 'asc')
    .execute();
  const relayRows = await relayClient.db
    .selectFrom('tasks')
    .select(['id'])
    .orderBy('id', 'asc')
    .execute();
  const serverRows = await ctx.server.db
    .selectFrom('tasks')
    .select(['id'])
    .orderBy('id', 'asc')
    .execute();

  const expectedIds = ['path-direct-task', 'path-relay-task'];
  expect(directRows.map((row) => row.id)).toEqual(expectedIds);
  expect(relayRows.map((row) => row.id)).toEqual(expectedIds);
  expect(serverRows.map((row) => row.id)).toEqual(expectedIds);
}

export async function runReconnectStormCursorScenario(
  ctx: ScenarioContext
): Promise<void> {
  const reader = ctx.clients[0]!;
  const writer = await ctx.createClient({
    actorId: ctx.userId,
    clientId: 'storm-writer',
  });
  const sub = createTasksSubscription(ctx.userId);

  await syncPullOnce(reader.db, reader.transport, reader.handlers, {
    clientId: reader.clientId,
    subscriptions: [sub],
  });

  const totalCommits = 30;
  let writesDone = false;
  let lastCursor = -1;
  const observedCursors: number[] = [];

  const pushLoop = async () => {
    for (let i = 1; i <= totalCommits; i++) {
      const pushResult = await writer.transport.sync({
        clientId: writer.clientId,
        push: {
          clientCommitId: `storm-c${i}`,
          schemaVersion: 1,
          operations: [
            {
              table: 'tasks',
              row_id: `storm-task-${i}`,
              op: 'upsert',
              payload: {
                title: `Storm Task ${i}`,
                completed: i % 2,
                project_id: 'p1',
              },
              base_version: null,
            },
          ],
        },
      });
      expect(pushResult.push?.status).toBe('applied');

      if (i % 3 === 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, 2));
      }
    }
    writesDone = true;
  };

  const pullLoop = async () => {
    for (let cycle = 0; cycle < totalCommits + 20; cycle++) {
      const transportPath: 'direct' | 'relay' =
        cycle % 2 === 0 ? 'direct' : 'relay';
      const shouldDrop = cycle % 5 === 4;
      const reconnectTransport = createTransport(
        ctx.server.baseUrl,
        ctx.userId,
        transportPath,
        shouldDrop ? { dropFirstResponse: true } : undefined
      );

      let pullResult: Awaited<ReturnType<typeof syncPullOnce>> | undefined;
      try {
        pullResult = await syncPullOnce(
          reader.db,
          reconnectTransport,
          reader.handlers,
          {
            clientId: reader.clientId,
            subscriptions: [sub],
            limitCommits: 4,
          }
        );
      } catch (error) {
        if (!shouldDrop) throw error;
        expect(String(error)).toContain('SIMULATED_RECONNECT_DROP');

        pullResult = await syncPullOnce(
          reader.db,
          createTransport(ctx.server.baseUrl, ctx.userId, transportPath),
          reader.handlers,
          {
            clientId: reader.clientId,
            subscriptions: [sub],
            limitCommits: 4,
          }
        );
      }

      const subscription = pullResult.subscriptions.find(
        (entry) => entry.id === sub.id
      );
      expect(subscription?.status).toBe('active');

      const nextCursor = subscription?.nextCursor ?? lastCursor;
      expect(nextCursor).toBeGreaterThanOrEqual(lastCursor);
      lastCursor = nextCursor;
      observedCursors.push(nextCursor);

      if (writesDone && nextCursor >= totalCommits) {
        break;
      }
    }
  };

  await Promise.all([pushLoop(), pullLoop()]);

  const finalPull = await syncPullOnce(
    reader.db,
    createTransport(ctx.server.baseUrl, ctx.userId, 'direct'),
    reader.handlers,
    {
      clientId: reader.clientId,
      subscriptions: [sub],
      limitCommits: 100,
    }
  );
  const finalSub = finalPull.subscriptions.find((entry) => entry.id === sub.id);
  expect(finalSub?.status).toBe('active');
  expect((finalSub?.nextCursor ?? -1) >= lastCursor).toBe(true);

  for (let i = 1; i < observedCursors.length; i++) {
    expect((observedCursors[i] ?? -1) >= (observedCursors[i - 1] ?? -1)).toBe(
      true
    );
  }

  const serverRows = await ctx.server.db
    .selectFrom('tasks')
    .select(['id'])
    .where('id', 'like', 'storm-task-%')
    .orderBy('id', 'asc')
    .execute();
  const clientRows = await reader.db
    .selectFrom('tasks')
    .select(['id'])
    .where('id', 'like', 'storm-task-%')
    .orderBy('id', 'asc')
    .execute();

  expect(serverRows.length).toBe(totalCommits);
  expect(clientRows.map((row) => row.id)).toEqual(
    serverRows.map((row) => row.id)
  );

  const localState = await reader.db
    .selectFrom('sync_subscription_state')
    .select(['cursor'])
    .where('subscription_id', '=', sub.id)
    .executeTakeFirst();
  expect(Number(localState?.cursor ?? -1)).toBe(totalCommits);
}

export async function runRelayDuplicateOutOfOrderScenario(
  ctx: ScenarioContext
): Promise<void> {
  const reader = ctx.clients[0]!;
  const writer = await ctx.createClient({
    actorId: ctx.userId,
    clientId: 'relay-ordering-writer',
  });
  const sub = createTasksSubscription(ctx.userId);
  const relayTransport = createTransport(
    ctx.server.baseUrl,
    ctx.userId,
    'relay'
  );

  await syncPullOnce(reader.db, relayTransport, reader.handlers, {
    clientId: reader.clientId,
    subscriptions: [sub],
  });

  for (let version = 1; version <= 3; version += 1) {
    const write = await writer.transport.sync({
      clientId: writer.clientId,
      push: {
        clientCommitId: `relay-ooo-c${version}`,
        schemaVersion: 1,
        operations: [
          {
            table: 'tasks',
            row_id: 'relay-ooo-row',
            op: 'upsert',
            payload: {
              title: `Relay Version ${version}`,
              completed: version % 2,
              project_id: 'p1',
            },
            base_version: version === 1 ? null : version - 1,
          },
        ],
      },
    });
    expect(write.push?.status).toBe('applied');
  }

  const stalePullState = await buildPullRequest(reader.db, {
    clientId: reader.clientId,
    subscriptions: [sub],
    limitCommits: 20,
  });
  const { clientId: pullClientId, ...basePull } = stalePullState.request;

  const staleCombined = await relayTransport.sync({
    clientId: pullClientId,
    pull: {
      ...basePull,
      limitCommits: 1,
    },
  });
  const freshCombined = await relayTransport.sync({
    clientId: pullClientId,
    pull: {
      ...basePull,
      limitCommits: 20,
    },
  });

  if (!freshCombined.pull || !staleCombined.pull) {
    throw new Error('Expected relay pulls to include payloads');
  }

  await applyPullResponse(
    reader.db,
    relayTransport,
    reader.handlers,
    {
      clientId: reader.clientId,
      subscriptions: [sub],
      limitCommits: 20,
    },
    stalePullState,
    freshCombined.pull
  );
  await applyPullResponse(
    reader.db,
    relayTransport,
    reader.handlers,
    {
      clientId: reader.clientId,
      subscriptions: [sub],
      limitCommits: 20,
    },
    stalePullState,
    staleCombined.pull
  );
  await applyPullResponse(
    reader.db,
    relayTransport,
    reader.handlers,
    {
      clientId: reader.clientId,
      subscriptions: [sub],
      limitCommits: 20,
    },
    stalePullState,
    staleCombined.pull
  );

  const localRow = await reader.db
    .selectFrom('tasks')
    .select(['id', 'title'])
    .where('id', '=', 'relay-ooo-row')
    .executeTakeFirst();
  expect(localRow?.title).toBe('Relay Version 3');

  const state = await reader.db
    .selectFrom('sync_subscription_state')
    .select(['cursor'])
    .where('subscription_id', '=', sub.id)
    .executeTakeFirst();
  expect(Number(state?.cursor ?? -1)).toBe(3);
}

export async function runMaintenanceChurnScenario(
  ctx: ScenarioContext
): Promise<void> {
  const writer = ctx.clients[0]!;
  const reader = await ctx.createClient({
    actorId: ctx.userId,
    clientId: 'maintenance-reader',
  });
  const lagging = await ctx.createClient({
    actorId: ctx.userId,
    clientId: 'maintenance-lagging',
  });
  const sub = createTasksSubscription(ctx.userId);

  await syncPullOnce(writer.db, writer.transport, writer.handlers, {
    clientId: writer.clientId,
    subscriptions: [sub],
  });
  await syncPullOnce(reader.db, reader.transport, reader.handlers, {
    clientId: reader.clientId,
    subscriptions: [sub],
  });
  await syncPullOnce(lagging.db, lagging.transport, lagging.handlers, {
    clientId: lagging.clientId,
    subscriptions: [sub],
  });

  const totalCommits = 36;
  let prunedAtLeastOnce = false;
  const runMaintenancePass = async () => {
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
      keepNewestCommits: 6,
    });

    if (watermark <= 0) return;
    const deleted = await pruneSync(ctx.server.db, {
      watermarkCommitSeq: watermark,
      keepNewestCommits: 6,
    });
    if (deleted > 0) {
      prunedAtLeastOnce = true;
    }
  };

  const pushLoop = async () => {
    for (let i = 1; i <= totalCommits; i++) {
      const pushResult = await writer.transport.sync({
        clientId: writer.clientId,
        push: {
          clientCommitId: `maintenance-c${i}`,
          schemaVersion: 1,
          operations: [
            {
              table: 'tasks',
              row_id: `maintenance-task-${i}`,
              op: 'upsert',
              payload: {
                title: `Maintenance Task ${i}`,
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
        await syncPullOnce(reader.db, reader.transport, reader.handlers, {
          clientId: reader.clientId,
          subscriptions: [sub],
          limitCommits: 25,
        });
      }
    }
  };

  const maintenanceLoop = async () => {
    for (let i = 0; i < 8; i++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      await runMaintenancePass();
    }
  };

  await Promise.all([pushLoop(), maintenanceLoop()]);
  // Guarantee at least one prune attempt after churn has fully materialized.
  await runMaintenancePass();
  expect(prunedAtLeastOnce).toBe(true);

  const laggingCatchup = await syncPullOnce(
    lagging.db,
    lagging.transport,
    lagging.handlers,
    {
      clientId: lagging.clientId,
      subscriptions: [sub],
      limitCommits: 25,
    }
  );
  expect(
    laggingCatchup.subscriptions.find(
      (subscription) => subscription.id === sub.id
    )?.bootstrap
  ).toBe(true);

  await syncPullOnce(reader.db, reader.transport, reader.handlers, {
    clientId: reader.clientId,
    subscriptions: [sub],
    limitCommits: 25,
  });

  const serverRows = await ctx.server.db
    .selectFrom('tasks')
    .select(['id'])
    .where('id', 'like', 'maintenance-task-%')
    .orderBy('id', 'asc')
    .execute();
  const readerRows = await reader.db
    .selectFrom('tasks')
    .select(['id'])
    .where('id', 'like', 'maintenance-task-%')
    .orderBy('id', 'asc')
    .execute();
  const laggingRows = await lagging.db
    .selectFrom('tasks')
    .select(['id'])
    .where('id', 'like', 'maintenance-task-%')
    .orderBy('id', 'asc')
    .execute();

  const serverIds = serverRows.map((row) => row.id);
  expect(serverIds.length).toBe(totalCommits);
  expect(readerRows.map((row) => row.id)).toEqual(serverIds);
  expect(laggingRows.map((row) => row.id)).toEqual(serverIds);
}
