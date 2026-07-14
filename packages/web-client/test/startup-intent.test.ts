import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SyncClient, type SyncIntent } from '@syncular/client';
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
