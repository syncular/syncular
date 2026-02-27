/**
 * Reconnect + maintenance scenarios for transport failures and retention churn.
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

function createTasksSubscription(userId: string) {
  return {
    id: 'tasks-p1',
    table: 'tasks',
    scopes: { user_id: userId, project_id: 'p1' },
  } as const;
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
