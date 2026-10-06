import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ClientSyncError,
  SyncClient,
  type SqlRow,
  type SqlValue,
} from '@syncular/client';
import { BunClientDatabase } from '@syncular/client/bun';
import { CLIENT_SCHEMA, taskValues } from './helpers';

class GuardDatabase extends BunClientDatabase {
  writes = 0;
  failMarkerRead = false;

  override exec(sql: string, params: readonly SqlValue[] = []): void {
    this.writes++;
    super.exec(sql, params);
  }

  override query(sql: string, params: readonly SqlValue[] = []): SqlRow[] {
    if (
      this.failMarkerRead &&
      sql.includes('SELECT value FROM _syncular_meta')
    ) {
      throw new Error('injected marker read failure');
    }
    return super.query(sql, params);
  }
}

test('v3 queued write survives v2 reopen, before bookkeeping and container cleanup', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'syncular-schema-downgrade-'));
  const path = join(dir, 'replica.sqlite');
  const db = new GuardDatabase(path);
  const config = {
    database: db,
    clientId: 'downgrade',
    schema: { ...CLIENT_SCHEMA, version: 3 },
    transport: async (): Promise<Uint8Array> => {
      throw new Error('offline');
    },
    previousVersionContext: { enabled: true },
  };
  try {
    const client = new SyncClient(config);
    await client.start();
    const commit = client.mutate([
      {
        op: 'upsert',
        table: 'tasks',
        values: taskValues(
          'queued',
          'p1',
          'v3-only',
          false,
          null,
          '{"pending":true}',
        ),
      },
    ]);
    await client.close();
    // An orphan container must survive a refused open too.
    const sibling = db.openSibling('prev-context');
    sibling.database.exec('CREATE TABLE sentinel(value TEXT)');
    sibling.database.exec("INSERT INTO sentinel VALUES ('keep')");
    sibling.database.close();
    const containerBefore = readFileSync(`${path}.prev-context`);
    const rows = db.query('SELECT * FROM tasks');
    const outbox = db.query('SELECT * FROM _syncular_outbox');
    const meta = db.query('SELECT * FROM _syncular_meta ORDER BY key');
    const layout = db.query('SELECT * FROM sqlite_master ORDER BY name');
    const writes = db.writes;
    let releases = 0;
    let held = false;
    const leaderLock = {
      acquire: async () => {
        if (held) throw new Error('lock still held');
        held = true;
        return {
          release: () => {
            held = false;
            releases++;
          },
        };
      },
    };
    const older = new SyncClient({
      ...config,
      schema: {
        ...CLIENT_SCHEMA,
        version: 2,
        tables: CLIENT_SCHEMA.tables.map((table) => ({
          ...table,
          columns: table.columns.filter((column) => column.name !== 'meta'),
        })),
      },
      leaderLock,
    });
    await expect(older.start()).rejects.toMatchObject({
      code: 'client.schema_downgrade',
      retryable: false,
      details: { persistedVersion: 3, requestedVersion: 2 },
    });
    expect(releases).toBe(1);
    expect(db.writes).toBe(writes);
    expect(db.query('SELECT * FROM tasks')).toEqual(rows);
    expect(db.query('SELECT * FROM _syncular_outbox')).toEqual(outbox);
    expect(db.query('SELECT * FROM _syncular_meta ORDER BY key')).toEqual(meta);
    expect(db.query('SELECT * FROM sqlite_master ORDER BY name')).toEqual(
      layout,
    );
    expect(readFileSync(`${path}.prev-context`)).toEqual(containerBefore);
    const reopened = new SyncClient({ ...config, leaderLock });
    await reopened.start();
    expect(held).toBe(true);
    expect(
      reopened.pendingCommits().map((item) => item.clientCommitId),
    ).toEqual([commit]);
    expect(db.query('SELECT * FROM tasks')).toEqual(rows);
    await reopened.close();
    expect(held).toBe(false);
    expect(releases).toBe(2);
    // Legacy replicas without a marker still open without wiping local intent.
    db.exec("DELETE FROM _syncular_meta WHERE key = 'localSchemaVersion'");
    const legacy = new SyncClient({ ...config, leaderLock });
    await legacy.start();
    expect(legacy.pendingCommits().map((item) => item.clientCommitId)).toEqual([
      commit,
    ]);
    expect(db.query('SELECT * FROM tasks')).toEqual(rows);
    expect(legacy.statusSnapshot().upgrading).toBe(false);
    await legacy.close();
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const marker of [
  '',
  'bad',
  '0',
  '-1',
  '2.5',
  '03',
  '3\n',
  ' 3',
  '+3',
  '3e0',
  '2147483648',
  null,
  new Uint8Array([51]),
]) {
  test(`invalid marker ${String(marker)} fails without writes`, async () => {
    const db = new GuardDatabase();
    // Permit invalid SQL types to prove that presence is distinct from absence.
    db.exec('CREATE TABLE _syncular_meta(key TEXT PRIMARY KEY, value)');
    db.exec("INSERT INTO _syncular_meta VALUES ('localSchemaVersion', ?)", [
      marker,
    ]);
    const writes = db.writes;
    const client = new SyncClient({
      database: db,
      schema: CLIENT_SCHEMA,
      transport: async () => new Uint8Array(),
    });
    await expect(client.start()).rejects.toBeInstanceOf(ClientSyncError);
    await expect(client.start()).rejects.toMatchObject({
      code: 'sync.local_corrupt',
      retryable: false,
    });
    expect(db.writes).toBe(writes);
    expect(db.query('SELECT count(*) AS count FROM sqlite_master')).toEqual([
      { count: 2 },
    ]);
    db.close();
  });
}

for (const failure of ['missing-value-column', 'read-error', 'view'] as const) {
  test(`unreadable marker (${failure}) fails without bookkeeping writes`, async () => {
    const db = new GuardDatabase();
    if (failure === 'view')
      db.exec(
        "CREATE VIEW _syncular_meta AS SELECT 'localSchemaVersion' AS key, '1' AS value",
      );
    else db.exec('CREATE TABLE _syncular_meta(key TEXT PRIMARY KEY)');
    db.failMarkerRead = failure === 'read-error';
    const writes = db.writes;
    const client = new SyncClient({
      database: db,
      schema: CLIENT_SCHEMA,
      transport: async () => new Uint8Array(),
    });
    await expect(client.start()).rejects.toMatchObject({
      code: 'sync.local_corrupt',
    });
    expect(db.writes).toBe(writes);
    db.close();
  });
}
