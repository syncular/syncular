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

  expect(reopened.statusSnapshot().syncNeeded).toBe(true);
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

for (const storedEpoch of [undefined, 'old-epoch']) {
  test(`epoch ${storedEpoch === undefined ? 'acquisition preserves' : 'change resets'} registered replica state`, async () => {
    const { encodeMessage, decodeMessage } = await import('@syncular/core');
    const db = new BunClientDatabase();
    const upgrading: boolean[] = [];
    const client = new SyncClient({
      database: db,
      schema: CLIENT_SCHEMA,
      onUpgrading: (value) => upgrading.push(value),
      transport: async (bytes) => {
        const request = decodeMessage(bytes);
        expect(request.msgKind).toBe('request');
        if (request.msgKind === 'request')
          expect(
            request.frames.filter((frame) => frame.type === 'PUSH_COMMIT'),
          ).toHaveLength(storedEpoch === undefined ? 0 : 1);
        return encodeMessage({
          wireVersion: 3,
          msgKind: 'response',
          frames: [
            { type: 'RESP_HEADER', logEpoch: 'new-epoch', resetRequired: true },
          ],
        });
      },
    });
    try {
      await client.start();
      client.subscribe({
        id: 'tasks',
        table: 'tasks',
        scopes: { project_id: ['p1'] },
      });
      // A trigger on the existing table proves its physical identity survives
      // acquisition. A real reset must drop it with the table.
      db.exec(
        'CREATE TRIGGER epoch_table_identity AFTER INSERT ON tasks BEGIN SELECT 1; END',
      );
      const commit = client.mutate([
        {
          table: 'tasks',
          op: 'upsert',
          values: {
            id: 'local',
            project_id: 'p1',
            title: 'offline',
            done: false,
            priority: null,
            meta: null,
          },
        },
      ]);
      const before = client.subscription('tasks');
      const statuses: boolean[] = [];
      client.onChange((batch) => {
        if (batch.status) statuses.push(batch.status.upgrading);
      });
      if (storedEpoch !== undefined)
        db.exec('INSERT INTO _syncular_meta(key,value) VALUES(?,?)', [
          'logEpoch',
          storedEpoch,
        ]);
      const report = await client.sync();
      expect(report.resets).toEqual(storedEpoch === undefined ? [] : ['tasks']);
      expect(
        client.pendingCommits().map((entry) => entry.clientCommitId),
      ).toEqual([commit]);
      expect(db.query('SELECT title FROM tasks')[0]?.title).toBe('offline');
      expect(
        db.query("SELECT value FROM _syncular_meta WHERE key='logEpoch'")[0]
          ?.value,
      ).toBe('new-epoch');
      if (storedEpoch === undefined) {
        expect(upgrading).toEqual([]);
        expect(statuses.every((value) => !value)).toBe(true);
        expect(client.statusSnapshot().upgrading).toBe(false);
        expect(client.subscription('tasks')).toEqual(before);
        expect(
          db.query(
            "SELECT name FROM sqlite_master WHERE name='epoch_table_identity'",
          ),
        ).toHaveLength(1);
      } else {
        expect(upgrading).toEqual([true]);
        expect(client.statusSnapshot().upgrading).toBe(true);
        expect(
          db.query(
            "SELECT name FROM sqlite_master WHERE name='epoch_table_identity'",
          ),
        ).toEqual([]);
      }
    } finally {
      await client.close();
      db.close();
    }
  });
}
