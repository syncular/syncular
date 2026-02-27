/**
 * E2EE scenario - Tests field encryption over HTTP transport
 */

import { expect } from 'bun:test';
import {
  enqueueOutboxCommit,
  syncPullOnce,
  syncPushOnce,
} from '@syncular/client';
import {
  createFieldEncryptionPlugin,
  createStaticFieldEncryptionKeys,
} from '@syncular/client-plugin-encryption';
import { createHttpTransport } from '@syncular/transport-http';
import type { ScenarioContext } from '../harness/types';

export async function runE2eeScenario(ctx: ScenarioContext): Promise<void> {
  const { server } = ctx;
  const clientA = ctx.clients[0]!;
  const clientB = await ctx.createClient({
    actorId: ctx.userId,
    clientId: 'client-b',
  });

  const keys = createStaticFieldEncryptionKeys({
    keys: { default: new Uint8Array(32).fill(7) },
  });
  const e2ee = createFieldEncryptionPlugin({
    rules: [{ scope: 'tasks', table: 'tasks', fields: ['title'] }],
    keys,
  });

  const subP1 = {
    id: 'p1',
    table: 'tasks',
    scopes: { user_id: ctx.userId, project_id: 'p1' },
  };

  // Client A creates an encrypted row
  await enqueueOutboxCommit(clientA.db, {
    operations: [
      {
        table: 'tasks',
        row_id: 't1',
        op: 'upsert',
        payload: { title: 'Secret', completed: 0, project_id: 'p1' },
        base_version: null,
      },
    ],
  });

  await syncPushOnce(clientA.db, clientA.transport, {
    clientId: clientA.clientId,
    actorId: ctx.userId,
    plugins: [e2ee],
  });

  // Verify server has encrypted data
  const serverRow = await server.db
    .selectFrom('tasks')
    .select(['title'])
    .where('id', '=', 't1')
    .executeTakeFirstOrThrow();
  expect(serverRow.title).not.toBe('Secret');
  expect(String(serverRow.title)).toMatch(/^dgsync:e2ee:1:/);

  // Client B bootstraps and should get plaintext locally
  await syncPullOnce(clientB.db, clientB.transport, clientB.handlers, {
    clientId: clientB.clientId,
    actorId: ctx.userId,
    plugins: [e2ee],
    subscriptions: [subP1],
  });

  const rowB = await clientB.db
    .selectFrom('tasks')
    .select(['id', 'title'])
    .where('id', '=', 't1')
    .executeTakeFirstOrThrow();
  expect(rowB.title).toBe('Secret');

  // Update via Client A, pull incrementally on Client B
  await enqueueOutboxCommit(clientA.db, {
    operations: [
      {
        table: 'tasks',
        row_id: 't1',
        op: 'upsert',
        payload: { title: 'Secret 2', completed: 0, project_id: 'p1' },
        base_version: 1,
      },
    ],
  });
  await syncPushOnce(clientA.db, clientA.transport, {
    clientId: clientA.clientId,
    actorId: ctx.userId,
    plugins: [e2ee],
  });

  await syncPullOnce(clientB.db, clientB.transport, clientB.handlers, {
    clientId: clientB.clientId,
    actorId: ctx.userId,
    plugins: [e2ee],
    subscriptions: [subP1],
  });

  const rowB2 = await clientB.db
    .selectFrom('tasks')
    .select(['id', 'title'])
    .where('id', '=', 't1')
    .executeTakeFirstOrThrow();
  expect(rowB2.title).toBe('Secret 2');
}

export async function runE2eeReconnectKeyRotationScenario(
  ctx: ScenarioContext
): Promise<void> {
  const clientA = ctx.clients[0]!;
  const clientB = await ctx.createClient({
    actorId: ctx.userId,
    clientId: 'client-b-rotation',
  });
  const clientUnauthorized = await ctx.createClient({
    actorId: ctx.userId,
    clientId: 'client-unauthorized-rotation',
  });

  const keyV1 = new Uint8Array(32).fill(11);
  const keyV2 = new Uint8Array(32).fill(29);
  let activeKid: 'k1' | 'k2' = 'k1';

  const writerPlugin = createFieldEncryptionPlugin({
    rules: [{ scope: 'tasks', table: 'tasks', fields: ['title'] }],
    keys: {
      async getKey(kid: string) {
        if (kid === 'k1') return keyV1;
        if (kid === 'k2') return keyV2;
        throw new Error(`Missing encryption key for kid "${kid}"`);
      },
      async getEncryptionKid() {
        return activeKid;
      },
    },
  });
  const authorizedReaderPlugin = createFieldEncryptionPlugin({
    rules: [{ scope: 'tasks', table: 'tasks', fields: ['title'] }],
    keys: createStaticFieldEncryptionKeys({
      keys: { k1: keyV1, k2: keyV2 },
    }),
  });
  const unauthorizedReaderPlugin = createFieldEncryptionPlugin({
    rules: [{ scope: 'tasks', table: 'tasks', fields: ['title'] }],
    keys: createStaticFieldEncryptionKeys({
      keys: { k2: keyV2 },
    }),
  });

  const sub = {
    id: 'p1',
    table: 'tasks',
    scopes: { user_id: ctx.userId, project_id: 'p1' },
  };

  await enqueueOutboxCommit(clientA.db, {
    operations: [
      {
        table: 'tasks',
        row_id: 'legacy-k1-task',
        op: 'upsert',
        payload: { title: 'Legacy K1', completed: 0, project_id: 'p1' },
        base_version: null,
      },
    ],
  });
  await syncPushOnce(clientA.db, clientA.transport, {
    clientId: clientA.clientId,
    actorId: ctx.userId,
    plugins: [writerPlugin],
  });

  await syncPullOnce(clientB.db, clientB.transport, clientB.handlers, {
    clientId: clientB.clientId,
    actorId: ctx.userId,
    plugins: [authorizedReaderPlugin],
    subscriptions: [sub],
  });

  const beforeRotation = await clientB.db
    .selectFrom('tasks')
    .select(['id', 'title'])
    .where('id', '=', 'legacy-k1-task')
    .executeTakeFirst();
  expect(beforeRotation?.title).toBe('Legacy K1');

  activeKid = 'k2';

  await enqueueOutboxCommit(clientA.db, {
    operations: [
      {
        table: 'tasks',
        row_id: 'post-rotation-k2-task',
        op: 'upsert',
        payload: { title: 'Post Rotation K2', completed: 0, project_id: 'p1' },
        base_version: null,
      },
    ],
  });
  await enqueueOutboxCommit(clientA.db, {
    operations: [
      {
        table: 'tasks',
        row_id: 'post-rotation-k2-task-2',
        op: 'upsert',
        payload: {
          title: 'Post Rotation K2 Second',
          completed: 1,
          project_id: 'p1',
        },
        base_version: null,
      },
    ],
  });
  await syncPushOnce(clientA.db, clientA.transport, {
    clientId: clientA.clientId,
    actorId: ctx.userId,
    plugins: [writerPlugin],
  });
  await syncPushOnce(clientA.db, clientA.transport, {
    clientId: clientA.clientId,
    actorId: ctx.userId,
    plugins: [writerPlugin],
  });

  const nativeFetch = (globalThis as Record<string, unknown>).__nativeFetch as
    | typeof globalThis.fetch
    | undefined;
  const reconnectTransport = createHttpTransport({
    baseUrl: ctx.server.baseUrl,
    getHeaders: () => ({ 'x-actor-id': ctx.userId }),
    ...(nativeFetch ? { fetch: nativeFetch } : {}),
  });

  await syncPullOnce(clientB.db, reconnectTransport, clientB.handlers, {
    clientId: clientB.clientId,
    actorId: ctx.userId,
    plugins: [authorizedReaderPlugin],
    subscriptions: [sub],
    limitCommits: 100,
  });

  const afterRotation = await clientB.db
    .selectFrom('tasks')
    .select(['id', 'title'])
    .where('id', 'in', [
      'legacy-k1-task',
      'post-rotation-k2-task',
      'post-rotation-k2-task-2',
    ])
    .orderBy('id', 'asc')
    .execute();
  expect(afterRotation.map((row) => row.id)).toEqual([
    'legacy-k1-task',
    'post-rotation-k2-task',
    'post-rotation-k2-task-2',
  ]);
  expect(afterRotation.map((row) => row.title)).toEqual([
    'Legacy K1',
    'Post Rotation K2',
    'Post Rotation K2 Second',
  ]);

  const encryptedOnServer = await ctx.server.db
    .selectFrom('tasks')
    .select(['id', 'title'])
    .where('id', 'in', [
      'legacy-k1-task',
      'post-rotation-k2-task',
      'post-rotation-k2-task-2',
    ])
    .orderBy('id', 'asc')
    .execute();
  expect(
    encryptedOnServer.every((row) =>
      String(row.title).startsWith('dgsync:e2ee:1:')
    )
  ).toBe(true);

  await expect(
    syncPullOnce(
      clientUnauthorized.db,
      clientUnauthorized.transport,
      clientUnauthorized.handlers,
      {
        clientId: clientUnauthorized.clientId,
        actorId: ctx.userId,
        plugins: [unauthorizedReaderPlugin],
        subscriptions: [sub],
      }
    )
  ).rejects.toThrow('Missing encryption key for kid "k1"');
}

export async function runE2eeOfflineRotationReconnectScenario(
  ctx: ScenarioContext
): Promise<void> {
  const writer = ctx.clients[0]!;
  const authorized = await ctx.createClient({
    actorId: ctx.userId,
    clientId: 'client-e2ee-authorized-offline',
  });
  const unauthorizedMissingK1 = await ctx.createClient({
    actorId: ctx.userId,
    clientId: 'client-e2ee-unauthorized-k1',
  });
  const unauthorizedMissingK2 = await ctx.createClient({
    actorId: ctx.userId,
    clientId: 'client-e2ee-unauthorized-k2',
  });

  const keyV1 = new Uint8Array(32).fill(41);
  const keyV2 = new Uint8Array(32).fill(59);
  let activeKid: 'k1' | 'k2' = 'k1';

  const writerPlugin = createFieldEncryptionPlugin({
    rules: [{ scope: 'tasks', table: 'tasks', fields: ['title'] }],
    keys: {
      async getKey(kid: string) {
        if (kid === 'k1') return keyV1;
        if (kid === 'k2') return keyV2;
        throw new Error(`Missing encryption key for kid "${kid}"`);
      },
      async getEncryptionKid() {
        return activeKid;
      },
    },
  });
  const authorizedPlugin = createFieldEncryptionPlugin({
    rules: [{ scope: 'tasks', table: 'tasks', fields: ['title'] }],
    keys: createStaticFieldEncryptionKeys({
      keys: { k1: keyV1, k2: keyV2 },
    }),
  });
  const unauthorizedOnlyK2 = createFieldEncryptionPlugin({
    rules: [{ scope: 'tasks', table: 'tasks', fields: ['title'] }],
    keys: createStaticFieldEncryptionKeys({
      keys: { k2: keyV2 },
    }),
  });
  const unauthorizedOnlyK1 = createFieldEncryptionPlugin({
    rules: [{ scope: 'tasks', table: 'tasks', fields: ['title'] }],
    keys: createStaticFieldEncryptionKeys({
      keys: { k1: keyV1 },
    }),
  });

  const sub = {
    id: 'p1',
    table: 'tasks',
    scopes: { user_id: ctx.userId, project_id: 'p1' },
  };

  // Offline enqueue under key k1 (no push yet).
  await enqueueOutboxCommit(writer.db, {
    operations: [
      {
        table: 'tasks',
        row_id: 'offline-k1-task',
        op: 'upsert',
        payload: { title: 'Offline K1', completed: 0, project_id: 'p1' },
        base_version: null,
      },
    ],
  });

  // Reconnect and flush first offline commit with the pre-rotation key.
  await syncPushOnce(writer.db, writer.transport, {
    clientId: writer.clientId,
    actorId: ctx.userId,
    plugins: [writerPlugin],
  });

  // Rotate key, enqueue new offline writes, then reconnect and flush.
  activeKid = 'k2';
  await enqueueOutboxCommit(writer.db, {
    operations: [
      {
        table: 'tasks',
        row_id: 'offline-k2-task-1',
        op: 'upsert',
        payload: { title: 'Offline K2 One', completed: 0, project_id: 'p1' },
        base_version: null,
      },
    ],
  });
  await enqueueOutboxCommit(writer.db, {
    operations: [
      {
        table: 'tasks',
        row_id: 'offline-k2-task-2',
        op: 'upsert',
        payload: { title: 'Offline K2 Two', completed: 1, project_id: 'p1' },
        base_version: null,
      },
    ],
  });

  const nativeFetch = (globalThis as Record<string, unknown>).__nativeFetch as
    | typeof globalThis.fetch
    | undefined;
  const reconnectTransport = createHttpTransport({
    baseUrl: ctx.server.baseUrl,
    getHeaders: () => ({ 'x-actor-id': ctx.userId }),
    ...(nativeFetch ? { fetch: nativeFetch } : {}),
  });

  await syncPushOnce(writer.db, reconnectTransport, {
    clientId: writer.clientId,
    actorId: ctx.userId,
    plugins: [writerPlugin],
  });
  await syncPushOnce(writer.db, reconnectTransport, {
    clientId: writer.clientId,
    actorId: ctx.userId,
    plugins: [writerPlugin],
  });

  await syncPullOnce(authorized.db, reconnectTransport, authorized.handlers, {
    clientId: authorized.clientId,
    actorId: ctx.userId,
    plugins: [authorizedPlugin],
    subscriptions: [sub],
    limitCommits: 100,
  });

  const authorizedRows = await authorized.db
    .selectFrom('tasks')
    .select(['id', 'title'])
    .where('id', 'in', [
      'offline-k1-task',
      'offline-k2-task-1',
      'offline-k2-task-2',
    ])
    .orderBy('id', 'asc')
    .execute();
  expect(authorizedRows.map((row) => row.id)).toEqual([
    'offline-k1-task',
    'offline-k2-task-1',
    'offline-k2-task-2',
  ]);
  expect(authorizedRows.map((row) => row.title)).toEqual([
    'Offline K1',
    'Offline K2 One',
    'Offline K2 Two',
  ]);

  const serverRows = await ctx.server.db
    .selectFrom('tasks')
    .select(['id', 'title'])
    .where('id', 'in', [
      'offline-k1-task',
      'offline-k2-task-1',
      'offline-k2-task-2',
    ])
    .orderBy('id', 'asc')
    .execute();
  expect(
    serverRows.every((row) => String(row.title).startsWith('dgsync:e2ee:1:'))
  ).toBe(true);

  await expect(
    syncPullOnce(
      unauthorizedMissingK1.db,
      reconnectTransport,
      unauthorizedMissingK1.handlers,
      {
        clientId: unauthorizedMissingK1.clientId,
        actorId: ctx.userId,
        plugins: [unauthorizedOnlyK2],
        subscriptions: [sub],
      }
    )
  ).rejects.toThrow('Missing encryption key for kid "k1"');

  await expect(
    syncPullOnce(
      unauthorizedMissingK2.db,
      reconnectTransport,
      unauthorizedMissingK2.handlers,
      {
        clientId: unauthorizedMissingK2.clientId,
        actorId: ctx.userId,
        plugins: [unauthorizedOnlyK1],
        subscriptions: [sub],
      }
    )
  ).rejects.toThrow('Missing encryption key for kid "k2"');
}
