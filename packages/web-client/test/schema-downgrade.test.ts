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

for (const version of [0, -1, 2147483648]) {
  test(`a generated schema version of ${version} is refused before any write`, () => {
    const db = new GuardDatabase();
    const writes = db.writes;
    let constructed: SyncClient | undefined;
    let failure: unknown;
    try {
      constructed = new SyncClient({
        database: db,
        schema: { ...CLIENT_SCHEMA, version },
        transport: async () => new Uint8Array(),
      });
    } catch (error) {
      failure = error;
    }
    expect(constructed).toBeUndefined();
    expect(failure).toBeInstanceOf(ClientSyncError);
    expect(failure).toMatchObject({
      code: 'sync.invalid_request',
      retryable: false,
    });
    expect(db.writes).toBe(writes);
    expect(db.query('SELECT count(*) AS count FROM sqlite_master')).toEqual([
      { count: 0 },
    ]);
    db.close();
  });
}

test('a duplicated local schema marker fails without a reset', async () => {
  const db = new GuardDatabase();
  // A hand-built/legacy metadata table without its primary key, older first:
  // picking the first row would drive the destructive reset.
  db.exec('CREATE TABLE _syncular_meta(key TEXT, value)');
  db.exec("INSERT INTO _syncular_meta VALUES ('localSchemaVersion', '1')");
  db.exec("INSERT INTO _syncular_meta VALUES ('localSchemaVersion', '2')");
  const writes = db.writes;
  const client = new SyncClient({
    database: db,
    schema: { ...CLIENT_SCHEMA, version: 3 },
    transport: async () => new Uint8Array(),
  });
  await expect(client.start()).rejects.toMatchObject({
    code: 'sync.local_corrupt',
    retryable: false,
  });
  expect(db.writes).toBe(writes);
  expect(
    db.query(
      "SELECT count(*) AS count FROM _syncular_meta WHERE key = 'localSchemaVersion'",
    ),
  ).toEqual([{ count: 2 }]);
  expect(
    db.query(
      "SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_syncular_%'",
    ),
  ).toEqual([{ count: 0 }]);
  db.close();
});

class InterleavedMarkerDatabase extends GuardDatabase {
  #markerReads = 0;
  #upgrade: (() => void) | undefined;

  /** Runs after the startup transaction's marker read, before its first write. */
  upgradeAfterMarkerRead(run: () => void): void {
    this.#upgrade = run;
  }

  override query(sql: string, params: readonly SqlValue[] = []): SqlRow[] {
    const rows = super.query(sql, params);
    if (
      sql.includes('SELECT value FROM _syncular_meta') &&
      params[0] === 'localSchemaVersion'
    ) {
      this.#markerReads++;
      if (this.#markerReads === 1) {
        const upgrade = this.#upgrade;
        this.#upgrade = undefined;
        upgrade?.();
      }
    }
    return rows;
  }
}

test('a marker upgraded after the startup read cannot commit a stale schema', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'syncular-marker-race-'));
  const path = join(dir, 'replica.sqlite');
  const seed = new BunClientDatabase(path);
  const banner = new BunClientDatabase(path);
  const db = new InterleavedMarkerDatabase(path);
  try {
    const installed = new SyncClient({
      database: seed,
      clientId: 'race',
      schema: CLIENT_SCHEMA,
      transport: async () => new Uint8Array(),
    });
    await installed.start();
    await installed.close();
    // The concurrent upgrade commits exactly after the startup transaction's
    // marker read, so that transaction's snapshot is stale before its writes.
    db.upgradeAfterMarkerRead(() => {
      banner.exec('PRAGMA busy_timeout = 0');
      banner.exec('BEGIN IMMEDIATE');
      banner.exec(
        "UPDATE _syncular_meta SET value = '2' WHERE key = 'localSchemaVersion'",
      );
      banner.exec('COMMIT');
    });
    db.exec('PRAGMA busy_timeout = 0');
    const stale = new SyncClient({
      database: db,
      clientId: 'race',
      schema: CLIENT_SCHEMA,
      transport: async () => new Uint8Array(),
    });
    const changes: unknown[] = [];
    stale.onChange((batch) => changes.push(batch));
    let failure: unknown;
    try {
      await stale.start();
    } catch (error) {
      failure = error;
    }
    // The stale snapshot cannot be promoted to a write (SQLITE_BUSY_SNAPSHOT).
    expect(failure).toBeInstanceOf(ClientSyncError);
    expect(failure).toMatchObject({
      code: 'client.storage_busy',
      retryable: true,
    });
    // The rolled-back transaction published no change event.
    expect(changes).toEqual([]);
    // The concurrent upgrade stands; the stale open never wrote its own marker.
    const probe = new BunClientDatabase(path);
    expect(
      probe.query(
        "SELECT value FROM _syncular_meta WHERE key = 'localSchemaVersion'",
      ),
    ).toEqual([{ value: '2' }]);
    probe.close();
  } finally {
    db.close();
    banner.close();
    seed.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a marker upgraded before the startup read refuses as a downgrade', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'syncular-marker-upgraded-'));
  const path = join(dir, 'replica.sqlite');
  const seed = new BunClientDatabase(path);
  const banner = new BunClientDatabase(path);
  const db = new GuardDatabase(path);
  try {
    const installed = new SyncClient({
      database: seed,
      clientId: 'race',
      schema: CLIENT_SCHEMA,
      transport: async () => new Uint8Array(),
    });
    await installed.start();
    await installed.close();
    // Another process completes the upgrade before this open reads the marker.
    banner.exec('PRAGMA busy_timeout = 0');
    banner.exec('BEGIN IMMEDIATE');
    banner.exec(
      "UPDATE _syncular_meta SET value = '2' WHERE key = 'localSchemaVersion'",
    );
    banner.exec('COMMIT');
    const writes = db.writes;
    const stale = new SyncClient({
      database: db,
      clientId: 'race',
      schema: CLIENT_SCHEMA,
      transport: async () => new Uint8Array(),
    });
    const changes: unknown[] = [];
    stale.onChange((batch) => changes.push(batch));
    let failure: unknown;
    try {
      await stale.start();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ClientSyncError);
    expect(failure).toMatchObject({
      code: 'client.schema_downgrade',
      retryable: false,
      details: { persistedVersion: 2, requestedVersion: 1 },
    });
    // Refusal precedes every bookkeeping and schema write, and publishes no
    // change event.
    expect(db.writes).toBe(writes);
    expect(changes).toEqual([]);
    const probe = new BunClientDatabase(path);
    expect(
      probe.query(
        "SELECT value FROM _syncular_meta WHERE key = 'localSchemaVersion'",
      ),
    ).toEqual([{ value: '2' }]);
    probe.close();
  } finally {
    db.close();
    banner.close();
    seed.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
