/**
 * Both in-tree server storages against the shared `ServerStorage` contract:
 * `SqliteServerStorage` (bun:sqlite, the reference) and
 * `PostgresServerStorage` (pglite, embedded WASM Postgres — hermetic, no
 * docker). The two run identical assertions so the Postgres path matches the
 * reference key-for-key (index-first fanout, dense commitSeq, §4.6 horizon).
 */

import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { PGlite } from '@electric-sql/pglite';
import {
  decodeRow,
  decodeRowsSegment,
  encodeRow,
  type SegmentInlineFrame,
} from '@syncular/core';
import {
  compileSchema,
  SyncularAdmin,
  pruneCommitLog,
  prepareAuthorityTransaction,
  type D1PreparedStatement,
  D1ServerStorage,
  PostgresServerStorage,
  SqliteServerStorage,
  type StoredPushResult,
  type ServerStorage,
  type SqliteValue,
  type SqliteStatement,
} from '@syncular/server';
import type { PgExecutor } from '../src/pg-executor';
import type { NewChange } from '../src/storage';
import { pgliteExecutor } from '@syncular/server/pglite';
import { BunSqliteDatabase, SqliteLeaseStore } from '@syncular/server/sqlite';
import { StorageConstraintError } from '../src/storage-errors';
import { D1DatabaseDouble } from './d1-double';
import { CONTRACT_SCHEMA, runStorageContract } from './storage-contract';
import { deleteSqliteRowScopesSql } from '../src/relational-rows';
import {
  makeContext,
  pullHeader,
  pushCommit,
  pushResults,
  section,
  subFrame,
  sync,
  taskRow,
  upsert,
} from './helpers';

for (const backend of ['sqlite', 'postgres', 'd1'] as const) {
  test(`${backend} scope replacement removes exact old keys across repeated writes and rollback`, async () => {
    const pg = backend === 'postgres' ? await PGlite.create() : undefined;
    const sqlite = backend === 'sqlite' ? new BunSqliteDatabase() : undefined;
    const d1 = backend === 'd1' ? new Database(':memory:') : undefined;
    const storage: ServerStorage = pg
      ? new PostgresServerStorage(pgliteExecutor(pg))
      : sqlite
        ? new SqliteServerStorage(sqlite)
        : new D1ServerStorage(new D1DatabaseDouble(d1!), {
            pushApplySerialized: true,
          });
    const columns = CONTRACT_SCHEMA.tables.find(
      (table) => table.name === 'docs',
    )!.columns;
    const row = (id: string, org: string, project: string) => ({
      rowId: id,
      serverVersion: 1,
      scopes: { org_id: org, project_id: project },
      payload: encodeRow(columns, [id, org, project]),
    });
    const entries = async () => {
      const sql =
        'SELECT partition, tbl, var, value, row_id FROM sync_row_scopes ORDER BY partition, tbl, var, value, row_id';
      type Entry = {
        partition: string;
        tbl: string;
        var: string;
        value: string;
        row_id: string;
      };
      if (pg) return (await pg.query<Entry>(sql)).rows;
      if (sqlite) return sqlite.query<Entry, []>(sql).all();
      return d1!.query<Entry, []>(sql).all();
    };
    try {
      if (storage instanceof D1ServerStorage) await prepareD1(storage);
      await storage.ensureSchema(compileSchema(CONTRACT_SCHEMA));
      for (const partition of ['part', 'other']) {
        const tx = await storage.begin(partition);
        await tx.upsertRow('docs', row('shared', 'o1', 'p1'));
        if (partition === 'part') {
          await tx.upsertRow('docs', row('sibling', 'o1', 'p1'));
          await tx.upsertRow('tasks', {
            rowId: 'shared',
            serverVersion: 1,
            scopes: { project_id: 'p1' },
            payload: encodeRow(CONTRACT_SCHEMA.tables[0]!.columns, [
              'shared',
              'p1',
              null,
            ]),
          });
        }
        await tx.commit();
      }
      const baseline = await entries();
      if (pg) {
        // Bun's executor also has existing rows whose JSONB is JSON-encoded
        // text. The storage reader already supports this representation.
        await pg.query(
          `UPDATE docs SET _sync_scopes=to_jsonb(_sync_scopes::text) WHERE _sync_partition=$1 AND _sync_row_id=$2`,
          ['part', 'shared'],
        );
      }
      const isolated = baseline.filter(
        (entry) =>
          entry.partition !== 'part' ||
          entry.tbl !== 'docs' ||
          entry.row_id !== 'shared',
      );
      for (const empty of [false, true, false]) {
        const tx = await storage.begin('part');
        await tx.upsertRow('docs', row('shared', 'o2', 'p2'));
        await tx.deleteRow('docs', 'shared');
        await tx.deleteRow('docs', 'absent');
        await tx.upsertRow('docs', row('shared', 'o3', 'p3'));
        await tx.upsertRow('docs', {
          ...row('shared', 'o4', 'p4'),
          ...(empty ? { scopes: {} } : {}),
        });
        await tx.commit();
        const actual = await entries();
        expect(
          actual.filter(
            (entry) =>
              entry.partition !== 'part' ||
              entry.tbl !== 'docs' ||
              entry.row_id !== 'shared',
          ),
        ).toEqual(isolated);
        expect(
          actual
            .filter(
              (entry) =>
                entry.partition === 'part' &&
                entry.tbl === 'docs' &&
                entry.row_id === 'shared',
            )
            .map(({ var: variable, value }) => [variable, value]),
        ).toEqual(
          empty
            ? []
            : [
                ['org_id', 'o4'],
                ['project_id', 'p4'],
              ],
        );
      }
      const before = await entries();
      // Scope-map semantics: rewriting a row with the same scope map leaves the
      // exact same scope entries in place (the no-rewrite mechanism is pinned
      // separately against real D1 in the server-workers cost test).
      const identical = await storage.begin('part');
      await identical.upsertRow('docs', {
        ...row('shared', 'o4', 'p4'),
        serverVersion: 2,
      });
      await identical.commit();
      expect(await entries()).toEqual(before);
      for (const rejected of [false, true]) {
        const tx = await storage.begin('part');
        await tx.preparePushApply('test-client', 'test-commit', 1);
        await tx.upsertRow('docs', row('shared', 'rejected', 'rejected'));
        await tx.deleteRow('docs', 'sibling');
        if (rejected) {
          await expect(
            tx.upsertRow('docs', {
              ...row('shared', 'invalid', 'invalid'),
              payload: new Uint8Array([255]),
            }),
          ).rejects.toThrow();
          await tx.commitRejectedPushResult?.('client', 'bad-row', {
            status: 'rejected',
            results: [
              {
                opIndex: 1,
                status: 'error',
                code: 'sync.invalid_request',
                message: 'injected invalid row',
                retryable: false,
              },
            ],
          });
        } else await tx.rollback();
        expect(await entries()).toEqual(before);
        expect(
          (await storage.getRow('part', 'docs', 'shared'))?.scopes,
        ).toEqual({ org_id: 'o4', project_id: 'p4' });
        expect(
          (await storage.getRow('part', 'docs', 'sibling'))?.scopes,
        ).toEqual({ org_id: 'o1', project_id: 'p1' });
      }
      const deleted = await storage.begin('part');
      await deleted.deleteRow('docs', 'shared');
      await deleted.deleteRow('docs', 'shared');
      await deleted.commit();
      expect(await entries()).toEqual(isolated);
      if (sqlite) {
        const table = compileSchema(CONTRACT_SCHEMA).tables.get('docs')!;
        const plan = sqlite
          .query<{ detail: string }, string[]>(
            `EXPLAIN QUERY PLAN ${deleteSqliteRowScopesSql(table)}`,
          )
          .all('part', 'docs', 'shared', 'part', 'shared');
        expect(
          plan.some(
            ({ detail }) =>
              detail.includes('SEARCH sync_row_scopes') &&
              detail.includes('var=?') &&
              detail.includes('value=?') &&
              detail.includes('row_id=?'),
          ),
        ).toBe(true);
      }
    } finally {
      sqlite?.close();
      d1?.close();
      await pg?.close();
    }
  });
}

runStorageContract('sqlite', () => new SqliteServerStorage());

runStorageContract('postgres/pglite', async () => {
  const db = await PGlite.create();
  const storage = new PostgresServerStorage(pgliteExecutor(db));
  await storage.migrate();
  return storage;
});

// D1 (Cloudflare Workers) against the local bun:sqlite-backed double
// (test/d1-double.ts documents its fidelity limits). Same contract, so the
// D1 path is held to the reference behavior key-for-key.
for (const backend of [
  'sqlite',
  'postgres',
  'd1/migrate',
  'd1/migrateSchema',
  'd1/same-version open',
] as const) {
  test(`${backend} adds the tombstone version and scopes to an existing tombstone table`, async () => {
    // The table as released before tombstones recorded version and scopes.
    const legacy = [
      'CREATE TABLE sync_tombstones(partition TEXT NOT NULL, tbl TEXT NOT NULL, row_id TEXT NOT NULL, commit_seq BIGINT NOT NULL, PRIMARY KEY(partition, tbl, row_id))',
      "INSERT INTO sync_tombstones VALUES ('part', 'tasks', 'old', 7)",
    ];
    let storage: ServerStorage;
    if (backend === 'postgres') {
      const pg = await PGlite.create();
      for (const sql of legacy) await pg.exec(sql);
      const postgres = new PostgresServerStorage(pgliteExecutor(pg));
      await postgres.migrate();
      storage = postgres;
    } else if (backend === 'sqlite') {
      const db = new BunSqliteDatabase();
      for (const sql of legacy) db.exec(sql);
      storage = new SqliteServerStorage(db);
    } else {
      const raw = new Database(':memory:');
      const open = () =>
        new D1ServerStorage(new D1DatabaseDouble(raw), {
          pushApplySerialized: true,
        });
      if (backend === 'd1/same-version open') {
        await prepareD1(open());
        raw.exec('DROP TABLE sync_tombstones');
      }
      for (const sql of legacy) raw.exec(sql);
      const d1 = open();
      if (backend === 'd1/migrate') {
        await d1.migrate();
        expect(
          raw
            .query<{ name: string }, []>(
              "SELECT name FROM pragma_table_info('sync_tombstones') WHERE name IN ('server_version', 'scopes') ORDER BY name",
            )
            .all(),
        ).toEqual([{ name: 'scopes' }, { name: 'server_version' }]);
      }
      if (backend !== 'd1/same-version open') await prepareD1(d1);
      storage = d1;
    }
    await storage.ensureSchema(compileSchema(CONTRACT_SCHEMA));
    const tx = await storage.begin('part');
    expect(await tx.getTombstone('tasks', 'old')).toEqual({ commitSeq: 7 });
    await tx.appendCommit({
      clientId: 'c1',
      clientCommitId: 'delete',
      actorId: 'a1',
      createdAtMs: 1,
      changes: [
        {
          table: 'tasks',
          rowId: 'new',
          op: 'delete',
          deletedVersion: 2,
          scopes: { project_id: 'p1' },
        },
      ],
    });
    await tx.commit();
    const after = await storage.begin('part');
    expect(await after.getTombstone('tasks', 'new')).toMatchObject({
      serverVersion: 2,
      scopes: { project_id: 'p1' },
    });
    await after.rollback();
  });
}

async function prepareD1(storage: D1ServerStorage): Promise<void> {
  while (
    !(await storage.migrateSchema(compileSchema(CONTRACT_SCHEMA))).complete
  ) {}
}

runStorageContract('d1/double', async () => {
  const storage = new D1ServerStorage(new D1DatabaseDouble(), {
    pushApplySerialized: true,
  });
  await prepareD1(storage);
  return storage;
});

test('SQLite authority reads and commands serialize with revocation', async () => {
  const storage = new SqliteServerStorage();
  const columns = CONTRACT_SCHEMA.tables[0]!.columns;
  const row = (id: string, state: number) => ({
    rowId: id,
    serverVersion: 1,
    scopes: { project_id: 'p1' },
    payload: encodeRow(columns, [id, 'p1', new Uint8Array([state])]),
  });
  await storage.ensureSchema(compileSchema(CONTRACT_SCHEMA));
  const seed = await storage.begin('authority');
  await prepareAuthorityTransaction(seed, CONTRACT_SCHEMA.version);
  await seed.upsertRow('tasks', row('membership', 1));
  await seed.commit();

  const revoke = await storage.begin('authority');
  let afterRevocation: Promise<number> | undefined;
  try {
    await revoke.preparePushApply(
      'revoker',
      'revoke-1',
      CONTRACT_SCHEMA.version,
    );
    await revoke.upsertRow('tasks', row('membership', 0));
    let readStarted = false;
    afterRevocation = (async () => {
      const reader = await storage.begin('authority');
      try {
        await prepareAuthorityTransaction(reader, CONTRACT_SCHEMA.version);
        readStarted = true;
        const stored = await reader.getRow('tasks', 'membership');
        if (stored === undefined) throw new Error('missing membership');
        const state = decodeRow(columns, stored.payload)[2];
        if (!(state instanceof Uint8Array)) throw new Error('missing state');
        if (state[0] === 1)
          await reader.upsertRow('tasks', row('denied-command', 1));
        await reader.commit();
        return state[0]!;
      } finally {
        await reader.rollback();
      }
    })();
    await Promise.resolve();
    await Promise.resolve();
    expect(readStarted).toBe(false);
    await revoke.commit();
    expect(await afterRevocation).toBe(0);
    expect(
      await storage.getRow('authority', 'tasks', 'denied-command'),
    ).toBeUndefined();

    const restore = await storage.begin('authority');
    await prepareAuthorityTransaction(restore, CONTRACT_SCHEMA.version);
    await restore.upsertRow('tasks', row('membership', 1));
    await restore.commit();

    const command = await storage.begin('authority');
    let afterCommand: Promise<void> | undefined;
    try {
      await prepareAuthorityTransaction(command, CONTRACT_SCHEMA.version);
      const before = await command.getRow('tasks', 'membership');
      let revoked = false;
      afterCommand = (async () => {
        const writer = await storage.begin('authority');
        try {
          await writer.preparePushApply(
            'revoker',
            'revoke-2',
            CONTRACT_SCHEMA.version,
          );
          await writer.upsertRow('tasks', row('membership', 0));
          await writer.commit();
          revoked = true;
        } finally {
          await writer.rollback();
        }
      })();
      await Promise.resolve();
      await Promise.resolve();
      expect(revoked).toBe(false);
      expect(await command.getRow('tasks', 'membership')).toEqual(before);
      const event = row('authorized-command', 1);
      await command.upsertRow('tasks', event);
      await command.appendCommit({
        clientId: 'domain-command',
        clientCommitId: 'operation-1',
        actorId: 'actor',
        createdAtMs: 1,
        changes: [
          {
            table: 'tasks',
            rowId: event.rowId,
            op: 'upsert',
            rowVersion: 1,
            scopes: event.scopes,
            payload: event.payload,
          },
        ],
      });
      await command.commit();
      await afterCommand;
      expect(revoked).toBe(true);
      expect(
        await storage.getRow('authority', 'tasks', 'authorized-command'),
      ).toBeDefined();
    } finally {
      await command.rollback();
      await afterCommand?.catch(() => {});
    }
  } finally {
    await revoke.rollback();
    await afterRevocation?.catch(() => {});
    storage.db.close();
  }
});

test('SQLite authority preparation serializes with a schema migration', async () => {
  const storage = new SqliteServerStorage();
  await storage.ensureSchema(compileSchema(CONTRACT_SCHEMA));
  const holder = await storage.begin('authority');
  let migration: Promise<void> | undefined;
  try {
    await prepareAuthorityTransaction(holder, CONTRACT_SCHEMA.version);
    let migrated = false;
    migration = storage
      .ensureSchema(compileSchema({ ...CONTRACT_SCHEMA, version: 2 }))
      .then(() => {
        migrated = true;
      });
    await Promise.resolve();
    await Promise.resolve();
    expect(migrated).toBe(false);
    await holder.commit();
    await migration;
    const stale = await storage.begin('authority');
    try {
      await expect(
        prepareAuthorityTransaction(stale, CONTRACT_SCHEMA.version),
      ).rejects.toMatchObject({ code: 'sync.schema_not_ready' });
    } finally {
      await stale.rollback();
    }
  } finally {
    await holder.rollback();
    await migration?.catch(() => {});
    storage.db.close();
  }
});

const LEGACY_CLIENTS_DDL = `CREATE TABLE sync_clients(
  partition TEXT NOT NULL, client_id TEXT NOT NULL, actor_id TEXT NOT NULL,
  cursor INTEGER NOT NULL, subscriptions TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY(partition, client_id)
)`;

test('SQLite migrates legacy client records to wire version 1', async () => {
  const db = new BunSqliteDatabase();
  db.exec(LEGACY_CLIENTS_DDL);
  db.run(
    `INSERT INTO sync_clients(
       partition, client_id, actor_id, cursor, subscriptions, updated_at_ms
     ) VALUES (?,?,?,?,?,?)`,
    ['partition', 'client', 'actor', 7, '[]', 10],
  );
  const storage = new SqliteServerStorage(db);
  expect(await storage.getClientRecord('partition', 'client')).toMatchObject({
    wireVersion: 1,
    cursor: 7,
  });
  storage.db.close();
});

test('D1 migrates legacy client records to wire version 1', async () => {
  const db = new D1DatabaseDouble();
  await db.exec(LEGACY_CLIENTS_DDL);
  await db
    .prepare(
      `INSERT INTO sync_clients(
         partition, client_id, actor_id, cursor, subscriptions, updated_at_ms
       ) VALUES (?,?,?,?,?,?)`,
    )
    .bind('partition', 'client', 'actor', 7, '[]', 10)
    .run();
  const storage = new D1ServerStorage(db, { pushApplySerialized: true });
  await storage.migrate();
  expect(await storage.getClientRecord('partition', 'client')).toMatchObject({
    wireVersion: 1,
    cursor: 7,
  });
});

test('Postgres migrates legacy client records to wire version 1', async () => {
  const db = await PGlite.create();
  await db.exec(LEGACY_CLIENTS_DDL);
  await db.query(
    `INSERT INTO sync_clients(
       partition, client_id, actor_id, cursor, subscriptions, updated_at_ms
     ) VALUES ($1,$2,$3,$4,$5,$6)`,
    ['partition', 'client', 'actor', 7, '[]', 10],
  );
  const storage = new PostgresServerStorage(pgliteExecutor(db));
  await storage.migrate();
  expect(await storage.getClientRecord('partition', 'client')).toMatchObject({
    wireVersion: 1,
    cursor: 7,
  });
  await db.close();
});

for (const backend of ['sqlite', 'postgres', 'd1'] as const) {
  test(`${backend} putClientRecord upserts one row and writes the exact fields`, async () => {
    const pg = backend === 'postgres' ? await PGlite.create() : undefined;
    const sqlite = backend === 'sqlite' ? new BunSqliteDatabase() : undefined;
    const d1 = backend === 'd1' ? new D1DatabaseDouble() : undefined;
    const storage: ServerStorage = pg
      ? new PostgresServerStorage(pgliteExecutor(pg))
      : sqlite
        ? new SqliteServerStorage(sqlite)
        : new D1ServerStorage(d1!, { pushApplySerialized: true });
    try {
      if (storage instanceof D1ServerStorage) await prepareD1(storage);
      await storage.ensureSchema(compileSchema(CONTRACT_SCHEMA));
      const first = {
        clientId: 'client-1',
        actorId: 'actor-1',
        wireVersion: 3,
        cursor: 5,
        updatedAtMs: 1_000,
        subscriptions: [
          {
            id: 'docs',
            table: 'docs',
            scopes: { project_id: ['p1'] },
            schemaVersion: 1,
          },
        ],
      };
      await storage.putClientRecord('part', first);
      // A later round overwrites every non-key field, not only the cursor and
      // liveness timestamp: the actor, wire version, and subscriptions move
      // with it, and the client keeps a single row.
      await storage.putClientRecord('part', {
        ...first,
        actorId: 'actor-9',
        wireVersion: 4,
        cursor: 9,
        updatedAtMs: 2_000,
        subscriptions: [],
      });
      expect(await storage.getClientRecord('part', 'client-1')).toEqual({
        clientId: 'client-1',
        actorId: 'actor-9',
        wireVersion: 4,
        cursor: 9,
        updatedAtMs: 2_000,
        subscriptions: [],
        lastRoundAtMs: 2_000,
      });
      expect(
        (await storage.listClientCursors('part')).sort((a, b) =>
          a.clientId.localeCompare(b.clientId),
        ),
      ).toEqual([{ clientId: 'client-1', cursor: 9, updatedAtMs: 2_000 }]);
      // A distinct client is a separate row, untouched by the update.
      await storage.putClientRecord('part', {
        ...first,
        clientId: 'client-2',
        actorId: 'actor-2',
        updatedAtMs: 3_000,
      });
      expect(
        (await storage.listClientCursors('part'))
          .sort((a, b) => a.clientId.localeCompare(b.clientId))
          .map((entry) => entry.clientId),
      ).toEqual(['client-1', 'client-2']);
      expect((await storage.getClientRecord('part', 'client-2'))?.actorId).toBe(
        'actor-2',
      );
    } finally {
      sqlite?.close();
      await pg?.close();
    }
  });
}

test('D1 push apply fails closed without external serialization', async () => {
  const storage = new D1ServerStorage(new D1DatabaseDouble());
  await prepareD1(storage);
  const tx = await storage.begin('partition');
  await expect(
    tx.preparePushApply('test-client', 'test-commit', 1),
  ).rejects.toThrow('requires externally serialized partition writes');
  await tx.rollback();
  await expect(
    storage.pruneCommitsThrough('partition', {
      logEpoch: 'epoch',
      throughSeq: 0,
    }),
  ).rejects.toThrow('requires externally serialized partition writes');
});

function appliedResult(): StoredPushResult {
  return {
    status: 'applied',
    commitSeq: 1,
    results: [{ opIndex: 0, status: 'applied' }],
  };
}

test('SQLite: a failed COMMIT rolls back and later transactions proceed', async () => {
  const storage = new SqliteServerStorage();
  const realExec = storage.db.exec.bind(storage.db);
  let failNextCommit = true;
  (storage.db as unknown as { exec: (sql: string) => unknown }).exec = (
    sql: string,
  ) => {
    if (failNextCommit && sql === 'COMMIT') {
      failNextCommit = false;
      throw Object.assign(new Error('SQLITE_BUSY: database is locked'), {
        code: 'SQLITE_BUSY',
      });
    }
    return realExec(sql);
  };

  const tx = await storage.begin('partition');
  await tx.putPushResult('c1', 'lost-commit', appliedResult());
  await expect(tx.commit()).rejects.toThrow('SQLITE_BUSY');

  // Regression: before the ROLLBACK-on-failed-COMMIT the connection stayed
  // inside BEGIN IMMEDIATE and every later transaction errored with
  // "cannot start a transaction within a transaction".
  const tx2 = await storage.begin('partition');
  await tx2.putPushResult('c1', 'landed-commit', appliedResult());
  await tx2.commit();
  expect(
    await storage.getPushResult('partition', 'c1', 'lost-commit'),
  ).toBeUndefined();
  expect(
    await storage.getPushResult('partition', 'c1', 'landed-commit'),
  ).toBeDefined();
});

test('pglite executor serializes overlapping transaction scopes', async () => {
  const db = await PGlite.create();
  const exec = pgliteExecutor(db);
  try {
    const order: string[] = [];
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = exec.transaction(async () => {
      order.push('first:start');
      entered();
      await gate;
      order.push('first:end');
    });
    await started;
    const second = exec.transaction(async () => {
      order.push('second:start');
      order.push('second:end');
    });
    await Promise.resolve();
    expect(order).toEqual(['first:start']);
    release();
    await Promise.all([first, second]);
    // Interleaved scopes would collapse into one SQL transaction (a nested
    // BEGIN is a warning-level no-op on Postgres).
    expect(order).toEqual([
      'first:start',
      'first:end',
      'second:start',
      'second:end',
    ]);
  } finally {
    await exec.close?.();
  }
});

test('Postgres partition locking initializes once and survives an initial rollback', async () => {
  const db = await PGlite.create();
  const base = pgliteExecutor(db);
  const statements: string[] = [];
  const storage = new PostgresServerStorage({
    query: (sql, params) => base.query(sql, params),
    transaction: (fn) =>
      base.transaction((client) =>
        fn({
          query: (sql, params) => {
            statements.push(sql);
            return client.query(sql, params);
          },
        }),
      ),
  });
  try {
    await storage.migrate();
    for (const [finish, initializes, expectedSeq] of [
      ['rollback', true, 1],
      ['commit', true, 1],
      ['commit', false, 2],
    ] as const) {
      statements.length = 0;
      const tx = await storage.begin('lock-partition');
      try {
        await tx.preparePushApply('test-client', 'test-commit', 1);
        const initialization = statements.filter((sql) =>
          sql.includes('INSERT INTO sync_partitions'),
        );
        expect(initialization).toHaveLength(initializes ? 1 : 0);
        expect(
          statements.filter((sql) => sql.includes('FOR UPDATE')),
        ).toHaveLength(initialization.length + 1);
        // The admission read (serve gate + idempotency record) follows the
        // lock statement; the candidate savepoint is lazy and lands before
        // the first candidate write instead.
        expect(statements.at(-1)).toContain('sync_push_results');
        const seq = await tx.appendCommit({
          clientId: 'client',
          clientCommitId: crypto.randomUUID(),
          actorId: 'actor',
          createdAtMs: 1,
          changes: [],
        });
        expect(seq).toBe(expectedSeq);
        await tx[finish]();
      } catch (error) {
        await tx.rollback();
        throw error;
      }
    }
    expect(await storage.getMaxCommitSeq('lock-partition')).toBe(2);
  } finally {
    await db.close();
  }
});

test('Postgres authority preparation reads the gate after the lock without push idempotency', async () => {
  const db = await PGlite.create();
  const base = pgliteExecutor(db);
  const statements: string[] = [];
  const storage = new PostgresServerStorage({
    query: (sql, params) => base.query(sql, params),
    transaction: (fn) =>
      base.transaction((client) =>
        fn({
          query: (sql, params) => {
            statements.push(sql);
            return client.query(sql, params);
          },
        }),
      ),
  });
  try {
    await storage.ensureSchema(compileSchema(CONTRACT_SCHEMA));
    statements.length = 0;
    const tx = await storage.begin('authority');
    try {
      await prepareAuthorityTransaction(tx, CONTRACT_SCHEMA.version);
      const lock = statements.findIndex((sql) => sql.includes('FOR UPDATE'));
      const gate = statements.findIndex((sql) =>
        sql.includes('sync_schema_meta'),
      );
      expect(lock).toBeGreaterThanOrEqual(0);
      expect(gate).toBeGreaterThan(lock);
      expect(statements.join('\n')).not.toContain('sync_push_results');
    } finally {
      await tx.rollback();
    }
  } finally {
    await db.close();
  }
});

test('Postgres allocates the sequence and commit metadata in one statement with atomic rollback', async () => {
  const db = await PGlite.create();
  const base = pgliteExecutor(db);
  const statements: string[] = [];
  const storage = new PostgresServerStorage({
    query: (sql, params) => base.query(sql, params),
    transaction: (fn) =>
      base.transaction((client) =>
        fn({
          query: (sql, params) => {
            statements.push(sql);
            return client.query(sql, params);
          },
        }),
      ),
  });
  try {
    await storage.migrate();
    for (const [finish, expectedSeq] of [
      ['rollback', 1],
      ['commit', 1],
      ['rollback', 2],
      ['commit', 2],
    ] as const) {
      const tx = await storage.begin('commit-allocation');
      try {
        statements.length = 0;
        const seq = await tx.appendCommit({
          clientId: 'client-λ',
          clientCommitId: `commit-${expectedSeq}`,
          actorId: "actor's id",
          createdAtMs: 1_750_000_000_123,
          changes: [],
        });
        expect(seq).toBe(expectedSeq);
        expect(statements).toHaveLength(1);
        await tx[finish]();
      } catch (error) {
        await tx.rollback();
        throw error;
      }
      expect(await storage.getMaxCommitSeq('commit-allocation')).toBe(
        finish === 'commit' ? expectedSeq : expectedSeq - 1,
      );
    }
    const records = await base.query(
      'SELECT partition, commit_seq, client_id, client_commit_id, actor_id, created_at_ms FROM sync_commits ORDER BY commit_seq',
    );
    expect(records.rows).toEqual(
      [1, 2].map((seq) => ({
        partition: 'commit-allocation',
        commit_seq: seq,
        client_id: 'client-λ',
        client_commit_id: `commit-${seq}`,
        actor_id: "actor's id",
        created_at_ms: 1_750_000_000_123,
      })),
    );
    await base.query(
      "ALTER TABLE sync_commits ADD CHECK (actor_id <> 'rejected')",
    );
    const rejected = await storage.begin('commit-allocation');
    try {
      await expect(
        rejected.appendCommit({
          clientId: 'client',
          clientCommitId: 'rejected',
          actorId: 'rejected',
          createdAtMs: 1,
          changes: [],
        }),
      ).rejects.toThrow();
    } finally {
      await rejected.rollback();
    }
    expect(await storage.getMaxCommitSeq('commit-allocation')).toBe(2);
    const retry = await storage.begin('commit-allocation');
    try {
      expect(
        await retry.appendCommit({
          clientId: 'client',
          clientCommitId: 'next',
          actorId: 'actor',
          createdAtMs: 2,
          changes: [],
        }),
      ).toBe(3);
      await retry.commit();
    } catch (error) {
      await retry.rollback();
      throw error;
    }
    expect(
      (
        await base.query(
          'SELECT client_commit_id FROM sync_commits ORDER BY commit_seq',
        )
      ).rows,
    ).toEqual([
      { client_commit_id: 'commit-1' },
      { client_commit_id: 'commit-2' },
      { client_commit_id: 'next' },
    ]);
  } finally {
    await db.close();
  }
});

test("Postgres appends a commit's changes and all their scopes in one statement", async () => {
  const db = await PGlite.create();
  const base = pgliteExecutor(db);
  const statements: string[] = [];
  const storage = new PostgresServerStorage({
    query: (sql, params) => base.query(sql, params),
    transaction: (fn) =>
      base.transaction((client) =>
        fn({
          query: (sql, params) => {
            statements.push(sql);
            return client.query(sql, params);
          },
        }),
      ),
  });
  const changes: NewChange[] = [
    { table: 'docs', rowId: 'unscoped', op: 'delete', scopes: {} },
    {
      table: 'docs',
      rowId: 'upsert',
      op: 'upsert',
      rowVersion: 7,
      scopes: { project_id: 'p\n1', org_id: "org's 雪", empty: '' },
      payload: new Uint8Array([0, 1, 128, 255]),
    },
    {
      table: 'docs',
      rowId: 'delete',
      op: 'delete',
      scopes: { project_id: 'p\n1', org_id: "org's 雪" },
    },
  ];
  try {
    await storage.migrate();
    for (const finish of ['rollback', 'commit'] as const) {
      const tx = await storage.begin('change-scopes');
      try {
        statements.length = 0;
        expect(
          await tx.appendCommit({
            clientId: 'client',
            clientCommitId: finish,
            actorId: 'actor',
            createdAtMs: 123,
            changes,
          }),
        ).toBe(1);
        // The allocation, the commit row, and every change share one
        // statement.
        expect(statements).toHaveLength(1);
        await tx[finish]();
      } catch (error) {
        await tx.rollback();
        throw error;
      }
      expect(await storage.getMaxCommitSeq('change-scopes')).toBe(
        finish === 'commit' ? 1 : 0,
      );
      expect(
        (await base.query('SELECT idx FROM sync_changes ORDER BY idx')).rows,
      ).toEqual(
        finish === 'commit' ? [{ idx: 0 }, { idx: 1 }, { idx: 2 }] : [],
      );
      // §5: the two delete changes leave tombstones; the upsert does not.
      expect(
        (
          await base.query(
            'SELECT row_id, commit_seq FROM sync_tombstones ORDER BY row_id',
          )
        ).rows.map((row) => ({
          row_id: row.row_id,
          commit_seq: Number(row.commit_seq),
        })),
      ).toEqual(
        finish === 'commit'
          ? [
              { row_id: 'delete', commit_seq: 1 },
              { row_id: 'unscoped', commit_seq: 1 },
            ]
          : [],
      );
      const entries = await base.query(
        'SELECT tbl, var, value, commit_seq FROM sync_change_scopes ORDER BY var',
      );
      expect(entries.rows).toEqual(
        finish === 'commit'
          ? [
              { tbl: 'docs', var: 'empty', value: '', commit_seq: 1 },
              { tbl: 'docs', var: 'org_id', value: "org's 雪", commit_seq: 1 },
              { tbl: 'docs', var: 'project_id', value: 'p\n1', commit_seq: 1 },
            ]
          : [],
      );
    }
    const window = await storage.readCommitWindow('change-scopes', {
      table: 'docs',
      scopeFilter: { project_id: ['p\n1'], org_id: ["org's 雪"] },
      afterSeq: 0,
      throughSeq: 1,
      limitChanges: 10,
    });
    expect(window).toEqual([
      {
        commitSeq: 1,
        actorId: 'actor',
        createdAtMs: 123,
        changes: changes.slice(1),
      },
    ]);
    await base.query(
      "ALTER TABLE sync_change_scopes ADD CHECK (value <> 'rejected')",
    );
    const tx = await storage.begin('change-scopes');
    try {
      await expect(
        tx.appendCommit({
          clientId: 'client',
          clientCommitId: 'rejected',
          actorId: 'actor',
          createdAtMs: 124,
          changes: [
            changes[1]!,
            {
              table: 'docs',
              rowId: 'bad',
              op: 'delete',
              scopes: { project_id: 'rejected' },
            },
          ],
        }),
      ).rejects.toThrow();
    } finally {
      await tx.rollback();
    }
    expect(await storage.getMaxCommitSeq('change-scopes')).toBe(1);
    expect(
      (await base.query('SELECT DISTINCT commit_seq FROM sync_changes')).rows,
    ).toEqual([{ commit_seq: 1 }]);
    expect(
      (await base.query('SELECT DISTINCT commit_seq FROM sync_change_scopes'))
        .rows,
    ).toEqual([{ commit_seq: 1 }]);
  } finally {
    await db.close();
  }
});

/** A D1 double whose batch() fails commit-time with a constraint error. */
class ConstraintAtBatchDouble extends D1DatabaseDouble {
  failNextBatch = false;

  override async batch(statements: D1PreparedStatement[]): Promise<unknown[]> {
    if (this.failNextBatch) {
      this.failNextBatch = false;
      throw new Error('D1_ERROR: NOT NULL constraint failed: tasks.data');
    }
    return super.batch(statements);
  }
}

test('D1: a batch-commit constraint attributes the opIndex only when it is unambiguous', async () => {
  const db = new ConstraintAtBatchDouble();
  const storage = new D1ServerStorage(db, { pushApplySerialized: true });
  await prepareD1(storage);
  const taskRow = (id: string) => ({
    rowId: id,
    serverVersion: 1,
    scopes: { project: 'p1' },
    payload: encodeRow(
      [
        { name: 'id', type: 'string', nullable: false },
        { name: 'project_id', type: 'string', nullable: false },
        { name: 'data', type: 'bytes', nullable: true },
      ] as const,
      [id, 'p1', null],
    ),
  });

  // Several buffered application ops: the violating one is unknowable from
  // the batch error, so the rejection omits the opIndex.
  const ambiguous = await storage.begin('partition');
  await ambiguous.preparePushApply('c', 'ambiguous', 1);
  await ambiguous.upsertRow('tasks', taskRow('t-0'), { opIndex: 0 });
  await ambiguous.upsertRow('tasks', taskRow('t-2'), { opIndex: 2 });
  db.failNextBatch = true;
  const ambiguousError = await ambiguous.commit().then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(ambiguousError).toBeInstanceOf(StorageConstraintError);
  expect((ambiguousError as StorageConstraintError).opIndex).toBeUndefined();
  await ambiguous.rollback();

  // One buffered application op: the attribution is exact.
  const exact = await storage.begin('partition');
  await exact.preparePushApply('c', 'exact', 1);
  await exact.upsertRow('tasks', taskRow('t-solo'), { opIndex: 3 });
  db.failNextBatch = true;
  const exactError = await exact.commit().then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(exactError).toBeInstanceOf(StorageConstraintError);
  expect((exactError as StorageConstraintError).opIndex).toBe(3);
  await exact.rollback();
});

for (const backend of ['SQLite', 'Postgres', 'D1'] as const) {
  test(`${backend} rolls back pruning at every write boundary and cleans up an interrupted older pass`, async () => {
    let failAt: string | undefined;
    const before = (sql: string) => {
      const matches =
        failAt === 'horizon'
          ? /(?:INSERT INTO sync_partitions\(partition,\s*horizon_seq\)|UPDATE sync_partitions SET horizon_seq)/.test(
              sql,
            )
          : failAt === 'COMMIT'
            ? sql === 'COMMIT'
            : failAt !== undefined && sql.startsWith(`DELETE FROM ${failAt} `);
      if (matches) throw new Error('injected pruning failure');
    };
    const sqlite = backend === 'SQLite' ? new BunSqliteDatabase() : undefined;
    const postgres = backend === 'Postgres' ? await PGlite.create() : undefined;
    const d1 = new D1DatabaseDouble();
    let storage: ServerStorage;
    if (sqlite !== undefined) {
      const query = sqlite.query.bind(sqlite);
      sqlite.query = <Row, Params extends readonly SqliteValue[]>(
        sql: string,
      ): SqliteStatement<Row, Params> => {
        before(sql);
        return query<Row, Params>(sql);
      };
      const exec = sqlite.exec.bind(sqlite);
      sqlite.exec = (sql) => {
        before(sql);
        exec(sql);
      };
      storage = new SqliteServerStorage(sqlite);
    } else if (postgres !== undefined) {
      const base = pgliteExecutor(postgres);
      const executor: PgExecutor = {
        query: (sql, params) => base.query(sql, params),
        transaction: (fn) =>
          base.transaction(async (client) => {
            const result = await fn({
              query: (sql, params) => {
                before(sql);
                return client.query(sql, params);
              },
            });
            before('COMMIT');
            return result;
          }),
      };
      storage = new PostgresServerStorage(executor);
    } else {
      d1.beforeBatchStatement = before;
      const adapter = new D1ServerStorage(d1, { pushApplySerialized: true });
      await prepareD1(adapter);
      storage = adapter;
    }
    try {
      await storage.ensureSchema(compileSchema(CONTRACT_SCHEMA));
      const { logEpoch } = await storage.touchPartition(
        'partition',
        1,
        'epoch',
      );
      for (let i = 1; i <= 3; i += 1) {
        const tx = await storage.begin('partition');
        await tx.appendCommit({
          clientId: 'c',
          clientCommitId: `c${i}`,
          actorId: 'a',
          createdAtMs: 1,
          changes: [
            {
              table: 'tasks',
              rowId: `t${i}`,
              op: 'upsert',
              rowVersion: 1,
              scopes: { project_id: 'p1' },
              payload: new Uint8Array([i]),
            },
          ],
        });
        await tx.commit();
      }
      for (const boundary of [
        'horizon',
        'sync_commits',
        'sync_changes',
        'sync_change_scopes',
        'COMMIT',
      ]) {
        failAt = boundary;
        await expect(
          storage.pruneCommitsThrough('partition', { logEpoch, throughSeq: 2 }),
        ).rejects.toThrow('injected pruning failure');
        failAt = undefined;
        expect(await storage.getHorizonSeq('partition')).toBe(0);
        expect(
          (
            await storage.readCommitWindow('partition', {
              table: 'tasks',
              scopeFilter: { project_id: ['p1'] },
              afterSeq: 0,
              throughSeq: 3,
              limitChanges: 100,
            })
          ).map((commit) => commit.commitSeq),
        ).toEqual([1, 2, 3]);
      }
      // Simulate the old setter succeeding before a historical delete failed.
      await storage.setHorizonSeq('partition', 2);
      expect(
        await storage.pruneCommitsThrough('partition', {
          logEpoch,
          throughSeq: 1,
        }),
      ).toEqual({ previousHorizonSeq: 2, horizonSeq: 2, removedCommits: 2 });
      expect(
        await storage.pruneCommitsThrough('partition', {
          logEpoch,
          throughSeq: 1,
        }),
      ).toEqual({ previousHorizonSeq: 2, horizonSeq: 2, removedCommits: 0 });
    } finally {
      failAt = undefined;
      sqlite?.close();
      await postgres?.close();
    }
  });
}

for (const backend of ['sqlite', 'postgres/pglite', 'd1/double']) {
  test(`${backend} active cursor aggregation handles 100001 records without enumerating clients`, async () => {
    let storage: ServerStorage;
    let close: () => void | Promise<void>;
    let plan: unknown;
    const seed = `INSERT INTO sync_clients(partition,client_id,actor_id,wire_version,cursor,subscriptions,updated_at_ms)
      SELECT 'part', CAST(n AS TEXT), 'actor', 2, CASE WHEN n=100001 THEN -1 ELSE n END, '[]', CASE WHEN n%2=0 THEN 99 ELSE 100 END FROM numbers`;
    const sqliteSeed = `WITH RECURSIVE numbers(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM numbers WHERE n<100001) ${seed}`;
    const aggregate =
      'SELECT MIN(cursor) AS cursor FROM sync_clients WHERE partition=? AND updated_at_ms>=? AND cursor>=0';
    if (backend === 'postgres/pglite') {
      const db = await PGlite.create();
      const pg = new PostgresServerStorage(pgliteExecutor(db));
      await pg.migrate();
      await db.exec(
        `WITH numbers AS (SELECT generate_series(1,100001) AS n) ${seed}`,
      );
      await db.exec('ANALYZE sync_clients');
      plan = (
        await db.query(
          `EXPLAIN (FORMAT JSON) ${aggregate.replace('partition=?', 'partition=$1').replace('>=?', '>=$2')}`,
          ['part', 100],
        )
      ).rows;
      storage = pg;
      close = () => db.close();
    } else if (backend === 'd1/double') {
      const db = new D1DatabaseDouble();
      const d1 = new D1ServerStorage(db, { pushApplySerialized: true });
      await d1.migrate();
      await db.exec(sqliteSeed);
      plan = (
        await db
          .prepare(`EXPLAIN QUERY PLAN ${aggregate}`)
          .bind('part', 100)
          .all()
      ).results;
      storage = d1;
      close = () => undefined;
    } else {
      const sqlite = new SqliteServerStorage();
      sqlite.db.exec(sqliteSeed);
      plan = sqlite.db
        .query(`EXPLAIN QUERY PLAN ${aggregate}`)
        .all('part', 100);
      storage = sqlite;
      close = () => sqlite.db.close();
    }
    try {
      await storage.touchPartition('part', 100, 'epoch');
      const measurements = [];
      for (const mode of ['enumerate', 'aggregate']) {
        const times: number[] = [];
        const heaps: number[] = [];
        let transferredBytes = 0;
        for (let run = 0; run < 3; run += 1) {
          Bun.gc(true);
          const before = process.memoryUsage().heapUsed;
          const start = performance.now();
          const result =
            mode === 'enumerate'
              ? await storage.listClientCursors('part')
              : await storage.getActiveClientCursorFloor('part', 100);
          times.push(performance.now() - start);
          heaps.push(process.memoryUsage().heapUsed - before);
          transferredBytes = JSON.stringify(result).length;
          // §4.6: the bootstrapping client (cursor -1) holds no floor.
          if (typeof result === 'number') expect(result).toBe(1);
          else expect(result).toHaveLength(100001);
        }
        measurements.push({ mode, times, heaps, transferredBytes });
      }
      const cutoffs: number[] = [];
      const aggregateRead = storage.getActiveClientCursorFloor.bind(storage);
      storage.getActiveClientCursorFloor = (partition, cutoff) => {
        cutoffs.push(cutoff);
        return aggregateRead(partition, cutoff);
      };
      storage.listClientCursors = () => {
        throw new Error('client enumeration forbidden');
      };
      const admin = new SyncularAdmin({
        storage,
        clock: () => 110,
        retention: { activeWindowMs: 10 },
      });
      expect((await admin.horizonStatus('part')).activeCursorFloor).toBe(1);
      expect(
        await pruneCommitLog({
          storage,
          partition: 'part',
          nowMs: 110,
          retention: { activeWindowMs: 10 },
        }),
      ).toBe(0);
      expect(cutoffs).toEqual([100, 100]);
      if (process.env.SYNCULAR_RETENTION_BENCH === '1')
        console.log(JSON.stringify({ backend, measurements, plan }));
    } finally {
      await close();
    }
  });
}

test('SQLite schema import preserves SQLITE_FULL through failed rollback and admits the next write', async () => {
  const db = new BunSqliteDatabase();
  const storage = new SqliteServerStorage(db);
  const originalExec = db.exec.bind(db);
  const full = Object.assign(new Error('database or disk is full'), {
    name: 'SQLiteError',
    errno: 13,
    code: 'SQLITE_FULL',
  });
  let injected = false;
  db.exec = (sql) => {
    if (sql === 'COMMIT' && !injected) {
      injected = true;
      originalExec('ROLLBACK');
      throw full;
    }
    originalExec(sql);
  };
  try {
    await expect(
      storage.ensureSchema(compileSchema(CONTRACT_SCHEMA)),
    ).rejects.toBe(full);
    expect(full).toHaveProperty('rollbackError');
    expect(full.errno).toBe(13);
    await storage.ensureSchema(compileSchema(CONTRACT_SCHEMA));
    const tx = await storage.begin('after-capacity-return');
    await tx.commit();
  } finally {
    db.close();
  }
});

test('PGlite cleanup retains a commit failure and releases the transaction queue', async () => {
  const full = Object.assign(new Error('disk full'), { code: '53100' });
  const rollback = new Error('rollback failed');
  let capacityRestored = false;
  const executor = pgliteExecutor({
    async query<Row>() {
      return { rows: [] as Row[] };
    },
    async exec(sql: string) {
      if (!capacityRestored && sql === 'COMMIT') throw full;
      if (!capacityRestored && sql === 'ROLLBACK') throw rollback;
    },
    async close() {},
  });
  await expect(executor.transaction(async () => 'imported')).rejects.toBe(full);
  expect(full).toHaveProperty('rollbackError', rollback);
  capacityRestored = true;
  expect(await executor.transaction(async () => 'imported')).toBe('imported');
});

test('sqlite requests wait behind an open push transaction (§6.4)', async () => {
  // Client A's push pauses inside its transaction on a host validator; client
  // B bootstraps meanwhile. B must neither read A's uncommitted row nor write
  // its client record into A's transaction, which then rolls back.
  let entered!: () => void;
  const validating = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const storage = new SqliteServerStorage();
  const t = makeContext({
    storage,
    validators: {
      tasks: async (op) => {
        if (op.rowId !== 't2') return;
        entered();
        await released;
        throw new Error('validator outage');
      },
    },
  });
  const push = sync(t, [
    pushCommit('a1', [
      upsert('tasks', 't1', taskRow('t1', 'p1')),
      upsert('tasks', 't2', taskRow('t2', 'p1')),
    ]),
  ]);
  await validating;

  // B's storage calls are observed: A stays open until B either finishes or
  // has a call that does not settle while A holds the connection. Without
  // the queue every call settles at once, so B runs to completion inside A.
  let pullFinished!: () => void;
  const pullDone = new Promise<void>((resolve) => {
    pullFinished = resolve;
  });
  let blocked!: () => void;
  const pullBlocked = new Promise<void>((resolve) => {
    blocked = resolve;
  });
  const observed = new Proxy(storage, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const result: unknown = Reflect.apply(value, target, args);
        if (!(result instanceof Promise)) return result;
        let settled = false;
        void result.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        void Promise.resolve()
          .then(() => undefined)
          .then(() => undefined)
          .then(() => {
            if (!settled) blocked();
          });
        return result;
      };
    },
  });
  const pull = sync(
    { ...t, ctx: { ...t.ctx, storage: observed } },
    [pullHeader(), subFrame('s1', 'tasks', { project_id: ['p1'] }, -1)],
    { clientId: 'client-2' },
  ).finally(pullFinished);
  await Promise.race([pullDone, pullBlocked]);
  release();

  expect(pushResults(await push)[0]?.status).not.toBe('applied');
  const bootstrap = section(await pull, 's1');
  const rows = bootstrap.body
    .filter(
      (frame): frame is SegmentInlineFrame => frame.type === 'SEGMENT_INLINE',
    )
    .flatMap((frame) => decodeRowsSegment(frame.payload).blocks.flat());
  expect(rows).toHaveLength(0);
  expect(await storage.getRow('part-1', 'tasks', 't1')).toBeUndefined();
  expect(await storage.getClientRecord('part-1', 'client-2')).toBeDefined();
});

test('postgres begin rejects when the executor cannot open a transaction', async () => {
  const refused = new Error('no connection');
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const storage = new PostgresServerStorage({
      async query<Row>() {
        return { rows: [] as Row[] };
      },
      async transaction() {
        throw refused;
      },
    });
    await expect(storage.begin('part')).rejects.toBe(refused);
    await expect(storage.begin('part')).rejects.toBe(refused);
    expect(unhandled).toEqual([]);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('sqlite lease revocation is read from the revocation record (§7.3.4)', async () => {
  const leases = new SqliteLeaseStore(new BunSqliteDatabase(), {
    leaseId: (() => {
      let next = 0;
      return () => `lease-${++next}`;
    })(),
  });
  const scopes = { project_id: ['p1'] };
  const issued = await leases.issue('part', 'client', 'actor', scopes, 0, 100);
  // The revocation record alone revokes the lease, whatever the lease row
  // says (an interrupted two-statement revoke left exactly this state).
  leases.db.run(
    'INSERT INTO sync_lease_revocations(partition, lease_id) VALUES (?,?)',
    ['part', issued.leaseId],
  );
  expect((await leases.get('part', 'client'))?.revoked).toBe(true);
  const refreshed = await leases.issue(
    'part',
    'client',
    'actor',
    scopes,
    1,
    100,
  );
  expect(refreshed.leaseId).toBe('lease-2');
  expect((await leases.get('part', 'client'))?.revoked).toBe(false);
  await leases.revoke('part', 'lease-2');
  expect(await leases.get('part', 'client')).toMatchObject({
    leaseId: 'lease-2',
    revoked: true,
  });
});

test('pglite pool statements wait behind an open transaction (§6.4)', async () => {
  const executor = pgliteExecutor(await PGlite.create());
  await executor.query('CREATE TABLE probe(id TEXT PRIMARY KEY)');
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let inserted!: () => void;
  const staged = new Promise<void>((resolve) => {
    inserted = resolve;
  });
  const transaction = executor
    .transaction(async (client) => {
      await client.query("INSERT INTO probe(id) VALUES ('uncommitted')");
      inserted();
      await released;
      throw new Error('rolled back');
    })
    .catch(() => undefined);
  await staged;
  // On one connection, a pool statement issued now would read the open
  // transaction's row and its write would roll back with it.
  const read = executor.query<{ id: string }>('SELECT id FROM probe');
  const write = executor.query("INSERT INTO probe(id) VALUES ('other')");
  release();
  await transaction;
  expect((await read).rows).toEqual([]);
  await write;
  expect((await executor.query('SELECT id FROM probe')).rows).toEqual([
    { id: 'other' },
  ]);
});
