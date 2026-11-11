import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClientSyncError, SyncClient, type SyncIntent } from '@syncular/client';
import { PROTOCOL_WIRE_VERSION, unitId } from '@syncular/core';
import { BunClientDatabase } from '@syncular/client/bun';
import { CLIENT_SCHEMA } from './helpers';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test('reopening active persistent units emits a catch-up intent', async () => {
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
  await first.setWindowCommand({ variable: 'project_id' }, ['persisted']);
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

test('reopening preserves a unit and its progress; registering it again changes nothing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'syncular-unit-identity-'));
  roots.push(root);
  const path = join(root, 'client.db');

  const firstDb = new BunClientDatabase(path);
  const first = new SyncClient({
    database: firstDb,
    schema: CLIENT_SCHEMA,
    transport: async () => new Uint8Array(),
  });
  await first.start();
  const id = first.subscribe({ project_id: 'p1' });
  expect(id).toBe(unitId({ project_id: 'p1' }));
  firstDb.exec(
    `UPDATE _syncular_units SET cursor = 41, bootstrap_state = ?, seeded = ?, echo = '[]' WHERE id = ?`,
    ['resume-token', '["tasks"]', id],
  );
  await first.close();
  firstDb.close();

  const intents: SyncIntent[] = [];
  const reopenedDb = new BunClientDatabase(path);
  const reopened = new SyncClient({
    database: reopenedDb,
    schema: CLIENT_SCHEMA,
    transport: async () => new Uint8Array(),
    onSyncIntent: (intent) => intents.push(intent),
  });
  await reopened.start();
  const progress = reopened.unit(id);
  expect(progress).toMatchObject({
    cursor: 41,
    bootstrapState: 'resume-token',
    seeded: ['tasks'],
    echo: [],
  });
  intents.length = 0;
  expect(reopened.subscribe({ project_id: 'p1' })).toBe(id);
  expect(reopened.unit(id)).toEqual(progress);
  expect(intents).toEqual([]);

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
          wireVersion: PROTOCOL_WIRE_VERSION,
          msgKind: 'response',
          frames: [
            { type: 'RESP_HEADER', logEpoch: 'new-epoch', resetRequired: true },
          ],
        });
      },
    });
    try {
      await client.start();
      const id = client.subscribe({ project_id: 'p1' });
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
      const before = client.unit(id);
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
      expect(report.resets).toEqual(storedEpoch === undefined ? [] : [id]);
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
        expect(client.unit(id)).toEqual(before);
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

test('subscribeMany registers all units or none, with one intent', async () => {
  const db = new BunClientDatabase();
  const intents: SyncIntent[] = [];
  const client = new SyncClient({
    database: db,
    schema: CLIENT_SCHEMA,
    transport: async () => new Uint8Array(),
    onSyncIntent: (intent) => intents.push(intent),
  });
  await client.start();
  intents.length = 0;
  const ids = client.subscribeMany([
    { project_id: 'p1' },
    { project_id: 'p2' },
  ]);
  expect(client.units().map((unit) => unit.id)).toEqual(ids);
  expect(intents).toHaveLength(1);
  // A wildcard value fails the whole call: `p3` stays out.
  expect(() =>
    client.subscribeMany([{ project_id: 'p3' }, { project_id: '*' }]),
  ).toThrow(ClientSyncError);
  expect(client.unit(unitId({ project_id: 'p3' }))).toBeUndefined();
  expect(intents).toHaveLength(1);
  await client.close();
  db.close();
});
