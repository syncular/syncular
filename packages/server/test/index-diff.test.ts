/**
 * Secondary-index handling across schema bumps: a bump rebuilds only changed
 * or new Syncular-owned indexes, and `serverIndexes` create non-partition-led
 * and partial indexes that never reach a client.
 */
import { describe, expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import type { RowColumn } from '@syncular/core';
import {
  compileSchema,
  D1ServerStorage,
  indexSignature,
  PostgresServerStorage,
  physicalServerIndexName,
  type ServerSchema,
  SqliteServerStorage,
} from '@syncular/server';
import { pgliteExecutor } from '@syncular/server/pglite';
import { BunSqliteDatabase } from '@syncular/server/sqlite';
import { D1DatabaseDouble } from './d1-double';

const COLUMNS: readonly RowColumn[] = [
  { name: 'id', type: 'string', nullable: false },
  { name: 'owner_id', type: 'string', nullable: false },
  { name: 'title', type: 'string', nullable: false },
  { name: 'status', type: 'string', nullable: true },
];

function schema(
  version: number,
  indexes: NonNullable<ServerSchema['tables'][number]['indexes']>,
  serverIndexes?: ServerSchema['tables'][number]['serverIndexes'],
): ServerSchema {
  return {
    version,
    tables: [
      {
        name: 'assertions',
        columns: COLUMNS,
        primaryKey: 'id',
        scopes: ['owner:{owner_id}'],
        indexes,
        ...(serverIndexes === undefined ? {} : { serverIndexes }),
      },
    ],
  };
}

const BY_TITLE = { name: 'by_title', columns: ['title'] };
const BY_OWNER = { name: 'by_owner', columns: ['owner_id', 'title'] };

type Backend = 'sqlite' | 'postgres' | 'd1';

interface Harness {
  /** Every statement text the database saw. */
  readonly log: string[];
  ensure(schema: ServerSchema): Promise<void>;
  /** A new storage instance on the same database, as after a process restart. */
  reopen(): void;
  /** Syncular-owned index names of `assertions`, sorted. */
  owned(): Promise<string[]>;
  /** `[definition]` of one index: key columns and whether it is partial. */
  definition(name: string): Promise<{ columns: string[]; partial: boolean }>;
}

async function harness(backend: Backend): Promise<Harness> {
  const log: string[] = [];
  if (backend === 'postgres') {
    const pg = await PGlite.create();
    const recording = {
      query: <Row>(query: string, params?: unknown[]) => {
        log.push(query);
        return pg.query<Row>(query, params);
      },
      exec: (query: string) => {
        log.push(query);
        return pg.exec(query);
      },
      close: () => pg.close(),
    };
    const open = () => new PostgresServerStorage(pgliteExecutor(recording));
    let storage = open();
    return {
      log,
      ensure: (next) => storage.ensureSchema(compileSchema(next)),
      reopen: () => {
        storage = open();
      },
      owned: async () =>
        (
          await pg.query<{ indexname: string }>(
            "SELECT indexname FROM pg_indexes WHERE tablename='assertions' AND indexname LIKE 'sync_ix_%' ORDER BY indexname",
          )
        ).rows.map((row) => row.indexname),
      definition: async (name) => {
        const row = (
          await pg.query<{ indexdef: string }>(
            'SELECT indexdef FROM pg_indexes WHERE indexname=$1',
            [name],
          )
        ).rows[0];
        const text = row?.indexdef ?? '';
        return {
          columns: (/\(([^)]*)\)/.exec(text)?.[1] ?? '')
            .split(',')
            .map((column) => column.trim()),
          partial: text.includes(' WHERE '),
        };
      },
    };
  }
  const native = new BunSqliteDatabase();
  const rows = <Row>(sql: string, ...params: string[]): Row[] =>
    native.query<Row, string[]>(sql).all(...params);
  const sqliteOwned = async (): Promise<string[]> =>
    rows<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='assertions' AND name LIKE 'sync_ix_%' ORDER BY name",
    ).map((row) => row.name);
  const sqliteDefinition = async (
    name: string,
  ): Promise<{ columns: string[]; partial: boolean }> => ({
    columns: rows<{ name: string }>(`PRAGMA index_info("${name}")`).map(
      (column) => column.name,
    ),
    partial:
      rows<{ name: string; partial: number }>(
        'PRAGMA index_list("assertions")',
      ).find((index) => index.name === name)?.partial === 1,
  });
  if (backend === 'd1') {
    const d1 = new D1DatabaseDouble(native.native);
    const open = () =>
      new D1ServerStorage({
        prepare: (sql) => {
          log.push(sql);
          return d1.prepare(sql);
        },
        batch: (statements) => d1.batch(statements),
        exec: (sql) => d1.exec(sql),
      });
    let storage = open();
    return {
      log,
      ensure: async (next) => {
        while (!(await storage.migrateSchema(compileSchema(next))).complete) {}
      },
      reopen: () => {
        storage = open();
      },
      owned: sqliteOwned,
      definition: sqliteDefinition,
    };
  }
  const recording = Object.assign(Object.create(native) as BunSqliteDatabase, {
    exec: (sql: string) => {
      log.push(sql);
      native.exec(sql);
    },
  });
  const open = () => new SqliteServerStorage(recording);
  let storage = open();
  return {
    log,
    ensure: (next) => storage.ensureSchema(compileSchema(next)),
    reopen: () => {
      storage = open();
    },
    owned: sqliteOwned,
    definition: sqliteDefinition,
  };
}

const dropped = (log: readonly string[]): string[] =>
  log.filter((sql) => sql.startsWith('DROP INDEX'));

describe('schema bump index diff', () => {
  for (const backend of ['sqlite', 'postgres', 'd1'] as const) {
    test(`${backend}: a bump with unchanged indexes drops none`, async () => {
      const db = await harness(backend);
      await db.ensure(schema(1, [BY_TITLE, BY_OWNER]));
      expect(await db.owned()).toEqual([
        'sync_ix_by_owner',
        'sync_ix_by_title',
      ]);
      db.log.length = 0;
      await db.ensure(schema(2, [BY_TITLE, BY_OWNER]));
      expect(dropped(db.log)).toEqual([]);
      expect(await db.owned()).toEqual([
        'sync_ix_by_owner',
        'sync_ix_by_title',
      ]);
    });

    test(`${backend}: a bump rebuilds only the index whose columns changed`, async () => {
      const db = await harness(backend);
      await db.ensure(schema(1, [BY_TITLE, BY_OWNER]));
      db.log.length = 0;
      await db.ensure(
        schema(2, [BY_TITLE, { name: 'by_owner', columns: ['owner_id'] }]),
      );
      expect(dropped(db.log)).toEqual([
        'DROP INDEX IF EXISTS "sync_ix_by_owner"',
      ]);
      expect(await db.definition('sync_ix_by_owner')).toEqual({
        columns: ['_sync_partition', 'owner_id'],
        partial: false,
      });
    });

    test(`${backend}: a bump drops an index that left the schema and keeps the rest`, async () => {
      const db = await harness(backend);
      await db.ensure(schema(1, [BY_TITLE, BY_OWNER]));
      db.log.length = 0;
      await db.ensure(schema(2, [BY_TITLE]));
      expect(dropped(db.log)).toEqual([
        'DROP INDEX IF EXISTS "sync_ix_by_owner"',
      ]);
      expect(await db.owned()).toEqual(['sync_ix_by_title']);
    });

    test(`${backend}: server indexes carry their columns as written and a partial predicate`, async () => {
      const db = await harness(backend);
      const lookup = { name: 'lookup', columns: ['owner_id', 'id'] };
      const pending = {
        name: 'pending',
        columns: ['_sync_partition', 'owner_id'],
        where: "status = 'pending'",
      };
      await db.ensure(schema(1, [BY_TITLE], [lookup, pending]));
      expect(await db.definition(physicalServerIndexName(lookup))).toEqual({
        columns: ['owner_id', 'id'],
        partial: false,
      });
      expect(await db.definition(physicalServerIndexName(pending))).toEqual({
        columns: ['_sync_partition', 'owner_id'],
        partial: true,
      });

      // Unchanged server indexes survive a bump; a changed predicate is a
      // different index, so the old one drops and the new one is created.
      db.log.length = 0;
      await db.ensure(schema(2, [BY_TITLE], [lookup, pending]));
      expect(dropped(db.log)).toEqual([]);
      const reworked = { ...pending, where: "status = 'queued'" };
      await db.ensure(schema(3, [BY_TITLE], [lookup, reworked]));
      expect(dropped(db.log)).toEqual([
        `DROP INDEX IF EXISTS "${physicalServerIndexName(pending)}"`,
      ]);
      expect(await db.owned()).toEqual(
        [
          'sync_ix_by_title',
          physicalServerIndexName(lookup),
          physicalServerIndexName(reworked),
        ].sort(),
      );
    });
  }

  for (const backend of ['sqlite', 'postgres', 'd1'] as const) {
    test(`${backend}: opening at the same version reconciles server indexes without a bump`, async () => {
      const db = await harness(backend);
      const lookup = { name: 'lookup', columns: ['owner_id', 'id'] };
      const pending = {
        name: 'pending',
        columns: ['_sync_partition', 'owner_id'],
        where: "status = 'pending'",
      };
      await db.ensure(schema(1, [BY_TITLE]));
      expect(await db.owned()).toEqual(['sync_ix_by_title']);

      // Declaring server indexes at the same version creates them on open.
      db.reopen();
      await db.ensure(schema(1, [BY_TITLE], [lookup, pending]));
      expect(await db.owned()).toEqual(
        [
          'sync_ix_by_title',
          physicalServerIndexName(lookup),
          physicalServerIndexName(pending),
        ].sort(),
      );
      expect(await db.definition(physicalServerIndexName(pending))).toEqual({
        columns: ['_sync_partition', 'owner_id'],
        partial: true,
      });

      // An unchanged declaration issues no DDL.
      db.reopen();
      db.log.length = 0;
      await db.ensure(schema(1, [BY_TITLE], [lookup, pending]));
      expect(
        db.log.filter((sql) =>
          /^\s*(CREATE (UNIQUE )?INDEX|DROP INDEX)/i.test(sql),
        ),
      ).toEqual([]);

      // A changed predicate drops the old index and creates the new one; a
      // removed server index drops; the declared index stays.
      const reworked = { ...pending, where: "status = 'queued'" };
      db.reopen();
      await db.ensure(schema(1, [BY_TITLE], [reworked]));
      expect(await db.owned()).toEqual(
        ['sync_ix_by_title', physicalServerIndexName(reworked)].sort(),
      );
    });
  }

  test('a server index leaves a plain SQLite lookup without a partition on an index', async () => {
    const native = new BunSqliteDatabase();
    const storage = new SqliteServerStorage(native);
    await storage.ensureSchema(
      compileSchema(
        schema(1, [], [{ name: 'lookup', columns: ['owner_id', 'id'] }]),
      ),
    );
    const plan = native
      .query<{ detail: string }, []>(
        "EXPLAIN QUERY PLAN SELECT title FROM assertions WHERE owner_id='o' AND id='i'",
      )
      .all()
      .map((row) => row.detail)
      .join(' ');
    expect(plan).toContain('sync_ix_lookup_');
  });

  test('server index names and columns are validated at compile', () => {
    expect(() =>
      compileSchema(
        schema(1, [BY_TITLE], [{ name: 'by_title', columns: ['id'] }]),
      ),
    ).toThrow(/duplicate index "by_title"/);
    expect(() =>
      compileSchema(schema(1, [], [{ name: 'x', columns: ['missing'] }])),
    ).toThrow(/names unknown column "missing"/);
    expect(() =>
      compileSchema(
        schema(1, [], [{ name: 'x', columns: ['id'], where: ' ' }]),
      ),
    ).toThrow(/empty where predicate/);
  });

  test('indexSignature distinguishes kind, partiality, and column order', () => {
    expect(indexSignature(['a', 'b'], false, false)).not.toBe(
      indexSignature(['b', 'a'], false, false),
    );
    expect(indexSignature(['a'], true, false)).not.toBe(
      indexSignature(['a'], false, false),
    );
    expect(indexSignature(['a'], false, true)).not.toBe(
      indexSignature(['a'], false, false),
    );
  });
});
