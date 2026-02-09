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
