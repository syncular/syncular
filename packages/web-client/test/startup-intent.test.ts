import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClientSyncError, SyncClient, type SyncIntent } from '@syncular/client';
import { BunClientDatabase } from '@syncular/client/bun';
import { CLIENT_SCHEMA } from './helpers';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test('reopening active persistent subscriptions emits a catch-up intent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'syncular-startup-'));
  roots.push(root);
  const path = join(root, 'client.db');

  const firstDb = new BunClientDatabase(path);
  const first = new SyncClient({
    database: firstDb,
    schema: CLIENT_SCHEMA,
    transport: async () => new Uint8Array(),
  });
  await first.start();
  await first.setWindowCommand({ table: 'tasks', variable: 'project_id' }, [
    'persisted',
  ]);
  await first.close();
  firstDb.close();

  const wakes: string[] = [];
  const intents: SyncIntent[] = [];
  const reopenedDb = new BunClientDatabase(path);
  const reopened = new SyncClient({
    database: reopenedDb,
    schema: CLIENT_SCHEMA,
    transport: async () => new Uint8Array(),
    onSyncNeeded: (reason) => wakes.push(reason),
    onSyncIntent: (intent) => intents.push(intent),
  });
  await reopened.start();

  expect(reopened.syncNeeded).toBe(true);
  expect(wakes).toEqual(['startup']);
  expect(intents).toEqual([{ kind: 'interactive' }]);

  await reopened.close();
  reopenedDb.close();
});

test('reopening preserves immutable subscription identity and progress', async () => {
  const root = mkdtempSync(join(tmpdir(), 'syncular-subscription-identity-'));
  roots.push(root);
  const path = join(root, 'client.db');

  const firstDb = new BunClientDatabase(path);
  const first = new SyncClient({
    database: firstDb,
    schema: CLIENT_SCHEMA,
    transport: async () => new Uint8Array(),
  });
  await first.start();
  first.subscribe({
    id: 'stable-subscription',
    table: 'tasks',
    scopes: { project_id: ['p2', 'p1'] },
    params: '{"view":"v1"}',
  });
  firstDb.exec(
    `UPDATE _syncular_subscriptions
       SET cursor = 41, bootstrap_state = ?, effective_scopes = ?
       WHERE id = ?`,
    ['resume-token', '{"project_id":["p1","p2"]}', 'stable-subscription'],
  );
  await first.close();
  firstDb.close();

  const reopenedDb = new BunClientDatabase(path);
  const reopened = new SyncClient({
    database: reopenedDb,
    schema: CLIENT_SCHEMA,
    transport: async () => new Uint8Array(),
  });
  await reopened.start();
  const progress = reopened.subscription('stable-subscription');
  expect(progress).toMatchObject({
    cursor: 41,
    bootstrapState: 'resume-token',
    effectiveScopes: { project_id: ['p1', 'p2'] },
  });

  reopened.subscribe({
    id: 'stable-subscription',
    table: 'tasks',
    scopes: { project_id: ['p1', 'p2', 'p1'] },
    params: '{"view":"v1"}',
  });
  expect(reopened.subscription('stable-subscription')).toEqual(progress);

  for (const input of [
    {
      id: 'stable-subscription',
      table: 'tasks',
      scopes: { project_id: ['p1'] },
      params: '{"view":"v1"}',
    },
    {
      id: 'stable-subscription',
      table: 'tasks',
      scopes: { project_id: ['p2', 'p1'] },
      params: '{"view":"v2"}',
    },
    {
      id: 'stable-subscription',
      table: 'docs',
      scopes: { org_id: ['o1'], projectId: ['p1'] },
      params: '{"view":"v1"}',
    },
  ]) {
    try {
      reopened.subscribe(input);
      throw new Error('expected subscription identity mismatch');
    } catch (error) {
      expect(error).toBeInstanceOf(ClientSyncError);
      expect((error as ClientSyncError).code).toBe(
        'client.subscription_intent_mismatch',
      );
    }
    expect(reopened.subscription('stable-subscription')).toEqual(progress);
  }

  await reopened.close();
  reopenedDb.close();
});
