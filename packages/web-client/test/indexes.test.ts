/**
 * Local secondary indexes (the CREATE INDEX migration subset). The generated
 * client schema carries `indexes` per table; `ensureLocalSchema` must
 * materialize them as real SQLite indexes, and the §7.4.3 schema-bump reset
 * (drop-and-recreate) must recreate them. The server-side counterpart —
 * the same declared indexes created on the relational per-app row tables —
 * is covered by packages/server/test/relational-rows.test.ts.
 */

import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import {
  type ClientSchema,
  type SqlRow,
  type SqlValue,
  compileClientSchema,
  resetLocalReplica,
  ensureLocalSchema,
} from '@syncular/client';
import { BunClientDatabase } from '@syncular/client/bun';
import { compileLocalProjections } from '@syncular/client/projections';
import {
  echoDigest,
  encodeMessage,
  encodeRowsSegment,
  PROTOCOL_WIRE_VERSION,
  type RowColumn,
} from '@syncular/core';
import { createHash } from 'node:crypto';
import {
  applySqliteSegment,
  upsertLocalRow,
  validateSegmentColumns,
} from '../src/apply';
import { SyncClient } from '../src/client';
import { ClientSyncError } from '../src/errors';
import type { SyncProgress } from '../src/progress';

const SCHEMA: ClientSchema = {
  version: 1,
  tables: [
    {
      name: 'tasks',
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'project_id', type: 'string', nullable: false },
        { name: 'title', type: 'string', nullable: false },
      ],
      primaryKey: 'id',
      scopes: ['project:{project_id}'],
      indexes: [
        { name: 'idx_tasks_project', columns: ['project_id'], unique: false },
        {
          name: 'idx_tasks_project_title',
          columns: ['project_id', 'title'],
          unique: true,
        },
      ],
    },
  ],
};

/** Read the CREATE INDEX SQL sqlite persisted for a given index name. */
function indexSql(db: BunClientDatabase, name: string): string | undefined {
  const rows = db.query(
    `SELECT sql FROM sqlite_master WHERE type='index' AND name='${name}'`,
  );
  return rows[0]?.sql === undefined || rows[0]?.sql === null
    ? undefined
    : String(rows[0].sql);
}

function indexNames(db: BunClientDatabase): string[] {
  return db
    .query(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='tasks' AND sql IS NOT NULL",
    )
    .map((r) => String(r.name))
    .sort();
}

function sqliteImageBytes(
  rows: ReadonlyArray<{
    id: string;
    projectId: string;
    title: string;
    version: number;
  }>,
): Uint8Array {
  const image = new Database(':memory:');
  try {
    image.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        _syncular_version INTEGER NOT NULL
      );
      CREATE TABLE _syncular_segment (
        format INTEGER NOT NULL,
        "table" TEXT NOT NULL,
        "schemaVersion" INTEGER NOT NULL,
        "asOfCommitSeq" INTEGER NOT NULL,
        "scopeDigest" TEXT NOT NULL,
        "rowCount" INTEGER NOT NULL
      );
    `);
    image
      .query('INSERT INTO _syncular_segment VALUES (1, ?, 1, 7, ?, ?)')
      .run('tasks', 'digest', rows.length);
    const insert = image.query('INSERT INTO tasks VALUES (?, ?, ?, ?)');
    for (const row of rows) {
      insert.run(row.id, row.projectId, row.title, row.version);
    }
    return new Uint8Array(image.serialize());
  } finally {
    image.close();
  }
}

describe('CREATE INDEX subset — client local DDL', () => {
  test('ensureLocalSchema materializes the declared indexes', () => {
    const db = new BunClientDatabase();
    ensureLocalSchema(db, compileClientSchema(SCHEMA));
    expect(indexNames(db)).toEqual([
      'idx_tasks_project',
      'idx_tasks_project_title',
    ]);
    // The unique index is created UNIQUE; the plain one is not.
    expect(indexSql(db, 'idx_tasks_project_title')).toMatch(/UNIQUE/);
    expect(indexSql(db, 'idx_tasks_project')).not.toMatch(/UNIQUE/);
    // The compound index spans both columns in declared order.
    expect(indexSql(db, 'idx_tasks_project_title')).toMatch(
      /"project_id".*"title"/,
    );
  });

  test('ensureLocalSchema is idempotent (IF NOT EXISTS)', () => {
    const db = new BunClientDatabase();
    const compiled = compileClientSchema(SCHEMA);
    ensureLocalSchema(db, compiled);
    expect(() => ensureLocalSchema(db, compiled)).not.toThrow();
    expect(indexNames(db)).toEqual([
      'idx_tasks_project',
      'idx_tasks_project_title',
    ]);
  });

  test('the unique index enforces uniqueness', () => {
    const db = new BunClientDatabase();
    ensureLocalSchema(db, compileClientSchema(SCHEMA));
    db.exec(
      `INSERT INTO "tasks" ("id","project_id","title") VALUES ('t1','p1','a')`,
    );
    // Same (project_id, title) with a different id violates the unique index.
    expect(() =>
      db.exec(
        `INSERT INTO "tasks" ("id","project_id","title") VALUES ('t2','p1','a')`,
      ),
    ).toThrow();
    // A different title is fine.
    expect(() =>
      db.exec(
        `INSERT INTO "tasks" ("id","project_id","title") VALUES ('t3','p1','b')`,
      ),
    ).not.toThrow();
  });

  test('a secondary unique collision never replaces the existing synced row', () => {
    const db = new BunClientDatabase();
    const compiled = compileClientSchema(SCHEMA);
    const table = compiled.tables.get('tasks');
    if (table === undefined) throw new Error('compiled tasks table missing');
    ensureLocalSchema(db, compiled);

    upsertLocalRow(db, table, ['t1', 'p1', 'a'], 1);
    upsertLocalRow(db, table, ['t1', 'p1', 'renamed'], 2);
    expect(db.query('SELECT * FROM tasks')).toEqual([
      { id: 't1', project_id: 'p1', title: 'renamed', _sync_version: 2 },
    ]);

    upsertLocalRow(db, table, ['t2', 'p1', 'a'], 1);
    expect(() => upsertLocalRow(db, table, ['t3', 'p1', 'a'], 2)).toThrow();
    expect(
      db.query(
        'SELECT id, project_id, title, _sync_version FROM tasks ORDER BY id',
      ),
    ).toEqual([
      { id: 't1', project_id: 'p1', title: 'renamed', _sync_version: 2 },
      { id: 't2', project_id: 'p1', title: 'a', _sync_version: 1 },
    ]);
  });

  test('image chunks without an overlay decode no row bodies or retained bases', async () => {
    class CountingDatabase extends BunClientDatabase {
      decoded = 0;
      maintenance = 0;
      override query(sql: string, params: readonly SqlValue[] = []): SqlRow[] {
        const rows = super.query(sql, params);
        if (sql.startsWith('SELECT * FROM syncular_image.'))
          this.decoded += rows.length;
        return rows;
      }
      override exec(sql: string, params: readonly SqlValue[] = []): void {
        if (sql.startsWith('UPDATE _syncular_failed_rows SET'))
          this.maintenance += 1;
        super.exec(sql, params);
      }
    }
    const db = new CountingDatabase();
    try {
      const compiled = compileClientSchema(SCHEMA);
      ensureLocalSchema(db, compiled);
      const rows = Array.from({ length: 2050 }, (_, index) => ({
        id: `row-${index}`,
        projectId: 'p1',
        title: `row-${index}`,
        version: 1,
      }));
      expect(
        await applySqliteSegment(
          db,
          compiled,
          compiled.tables.get('tasks')!,
          sqliteImageBytes(rows),
          {
            table: 'tasks',
            rowCount: rows.length,
            asOfCommitSeq: 7,
            scopeDigest: 'digest',
          },
          {
            clearFirst: true,
            effective: { project_id: ['p1'] },
            owners: () => [],
          },
        ),
      ).toBe(rows.length);
      expect(db.decoded).toBe(0);
      expect(db.maintenance).toBe(0);
      expect(db.query('SELECT count(*) AS n FROM tasks')[0]?.n).toBe(
        rows.length,
      );
    } finally {
      db.close();
    }
  });

  test('image transactions double from 1,024 rows and roll back whole on failure', async () => {
    const db = new BunClientDatabase();
    const image = new BunClientDatabase();
    const compiled = compileClientSchema(SCHEMA);
    const table = compiled.tables.get('tasks')!;
    try {
      ensureLocalSchema(db, compiled);
      image.exec(
        'CREATE TABLE tasks(id TEXT PRIMARY KEY, project_id TEXT, title TEXT, _syncular_version INTEGER NOT NULL)',
      );
      // Row 5000 lies in the second statement of the third transaction.
      image.exec(
        "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<7268) INSERT INTO tasks SELECT printf('%05d',x),'p1',CASE WHEN x=5000 THEN NULL ELSE 'title '||x END,1 FROM n",
      );
      image.exec(
        'CREATE TABLE _syncular_segment(format INTEGER, "table" TEXT, "schemaVersion" INTEGER, "asOfCommitSeq" INTEGER, "scopeDigest" TEXT, "rowCount" INTEGER)',
      );
      image.exec(
        "INSERT INTO _syncular_segment VALUES (1,'tasks',1,7,'digest',7268)",
      );
      const count = () =>
        Number(db.query('SELECT count(*) AS n FROM tasks')[0]?.n);
      let committed: number[] = [];
      let progress: number[] = [];
      const apply = () =>
        applySqliteSegment(
          db,
          compiled,
          table,
          image.db.serialize(),
          {
            table: 'tasks',
            rowCount: 7268,
            asOfCommitSeq: 7,
            scopeDigest: 'digest',
          },
          {
            clearFirst: true,
            effective: { project_id: ['p1'] },
            owners: () => [],
            onProgress: (rows) => progress.push(rows),
            transaction: (fn) => {
              const result = db.transaction(fn);
              committed.push(count());
              return result;
            },
            now: () => 0,
          },
        );
      await expect(apply()).rejects.toThrow();
      expect(committed).toEqual([1024, 3072]);
      expect(progress).toEqual([1024, 2048, 3072, 4096]);
      expect(count()).toBe(3072);
      image.exec("UPDATE tasks SET title='title 5000' WHERE id='05000'");
      committed = [];
      progress = [];
      await expect(apply()).resolves.toBe(7268);
      expect(committed).toEqual([1024, 3072, 7168, 7268]);
      expect(progress).toEqual([
        ...Array.from({ length: 7 }, (_, index) => (index + 1) * 1024),
        7268,
      ]);
    } finally {
      image.close();
      db.close();
    }
  });

  test.each([
    // 1,024 rows, then 1,024 × 250 / 128 = 2,000 and 2,000 × 250 / 128 = 3,906.
    [128, 0, 8000, [1024, 3024, 6930, 8000]],
    // 1,024 × 250 / 400 = 640 rows stays at the 1,024-row floor.
    [400, 0, 3000, [1024, 2048, 3000]],
    // A 500 ms COMMIT budgets 500 ms of writing: 1,024 × 500 / 400 = 1,280,
    // then 1,600 and 2,000 rows.
    [400, 500, 8000, [1024, 2304, 3904, 5904, 8000]],
    // A 1 s COMMIT (four slow flushes) leaves the doubling.
    [10, 1000, 8000, [1024, 3072, 7168, 8000]],
    // Doubling stops at 65,536 rows.
    [
      1,
      1000,
      200_000,
      [1024, 3072, 7168, 15_360, 31_744, 64_512, 130_048, 195_584, 200_000],
    ],
  ])(
    'image chunks writing %i ms and committing %i ms size the next one by the rows written per the larger of 250 ms and the commit',
    async (writeMs, commitMs, total, expected) => {
      const db = new BunClientDatabase();
      const image = new BunClientDatabase();
      const compiled = compileClientSchema(SCHEMA);
      try {
        ensureLocalSchema(db, compiled);
        image.exec(
          'CREATE TABLE tasks(id TEXT PRIMARY KEY, project_id TEXT, title TEXT, _syncular_version INTEGER NOT NULL)',
        );
        image.exec(
          `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<${total}) INSERT INTO tasks SELECT printf('%05d',x),'p1','title '||x,1 FROM n`,
        );
        image.exec(
          'CREATE TABLE _syncular_segment(format INTEGER, "table" TEXT, "schemaVersion" INTEGER, "asOfCommitSeq" INTEGER, "scopeDigest" TEXT, "rowCount" INTEGER)',
        );
        image.exec(
          `INSERT INTO _syncular_segment VALUES (1,'tasks',1,7,'digest',${total})`,
        );
        let clock = 0;
        const committed: number[] = [];
        await expect(
          applySqliteSegment(
            db,
            compiled,
            compiled.tables.get('tasks')!,
            image.db.serialize(),
            {
              table: 'tasks',
              rowCount: total,
              asOfCommitSeq: 7,
              scopeDigest: 'digest',
            },
            {
              clearFirst: true,
              effective: { project_id: ['p1'] },
              owners: () => [],
              transaction: (fn) => {
                const result = db.transaction(() => {
                  clock += writeMs;
                  return fn();
                });
                clock += commitMs;
                committed.push(
                  Number(db.query('SELECT count(*) AS n FROM tasks')[0]?.n),
                );
                return result;
              },
              now: () => clock,
            },
          ),
        ).resolves.toBe(total);
        expect(committed).toEqual(expected);
      } finally {
        image.close();
        db.close();
      }
    },
  );

  test('a later range image starts at the chunk size its table reached (§5.3)', async () => {
    const db = new BunClientDatabase();
    const compiled = compileClientSchema(SCHEMA);
    const chunkRows = new Map<string, number>();
    const committed: number[] = [];
    let clock = 0;
    try {
      ensureLocalSchema(db, compiled);
      // 128 ms a chunk: the first range runs 1,024 then 2,000 rows; the
      // second starts at 2,000 instead of 1,024.
      for (const [clearFirst, from, to] of [
        [true, 1, 3000],
        [false, 3001, 8000],
      ] as const) {
        const image = new BunClientDatabase();
        try {
          image.exec(
            'CREATE TABLE tasks(id TEXT PRIMARY KEY, project_id TEXT, title TEXT, _syncular_version INTEGER NOT NULL)',
          );
          image.exec(
            `WITH RECURSIVE n(x) AS (SELECT ${from} UNION ALL SELECT x+1 FROM n WHERE x<${to}) INSERT INTO tasks SELECT printf('%05d',x),'p1','title '||x,1 FROM n`,
          );
          image.exec(
            'CREATE TABLE _syncular_segment(format INTEGER, "table" TEXT, "schemaVersion" INTEGER, "asOfCommitSeq" INTEGER, "scopeDigest" TEXT, "rowCount" INTEGER)',
          );
          const total = to - from + 1;
          image.exec(
            `INSERT INTO _syncular_segment VALUES (1,'tasks',1,7,'digest',${total})`,
          );
          await applySqliteSegment(
            db,
            compiled,
            compiled.tables.get('tasks')!,
            image.db.serialize(),
            {
              table: 'tasks',
              rowCount: total,
              asOfCommitSeq: 7,
              scopeDigest: 'digest',
            },
            {
              clearFirst,
              effective: { project_id: ['p1'] },
              owners: () => [],
              chunkRows,
              transaction: (fn) => {
                const result = db.transaction(() => {
                  clock += 128;
                  return fn();
                });
                committed.push(
                  Number(db.query('SELECT count(*) AS n FROM tasks')[0]?.n),
                );
                return result;
              },
              now: () => clock,
            },
          );
        } finally {
          image.close();
        }
      }
      expect(committed).toEqual([1024, 3000, 5000, 8000]);
    } finally {
      db.close();
    }
  });

  test('image chunks keep their committed prefix and detach after a later failure', async () => {
    const db = new BunClientDatabase();
    const image = new BunClientDatabase();
    const compiled = compileClientSchema(
      {
        ...SCHEMA,
        tables: SCHEMA.tables.map((table) => ({
          ...table,
          localProjections: [
            {
              name: 'tasks_fts',
              generation: '1',
              columns: [
                { name: 'title', declaredType: 'string', source: 'title' },
              ],
              fts: { tokenize: 'unicode61', columns: ['title'] },
            },
          ],
        })),
      },
      compileLocalProjections,
    );
    const table = compiled.tables.get('tasks')!;
    try {
      ensureLocalSchema(db, compiled);
      image.exec(
        'CREATE TABLE tasks(id TEXT PRIMARY KEY, project_id TEXT, title TEXT, _syncular_version INTEGER NOT NULL)',
      );
      image.exec(
        "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<2050) INSERT INTO tasks SELECT printf('%05d',x),'p1',CASE WHEN x=1500 THEN NULL ELSE 'searchable '||x END,1 FROM n",
      );
      image.exec(
        'CREATE TABLE _syncular_segment(format INTEGER, "table" TEXT, "schemaVersion" INTEGER, "asOfCommitSeq" INTEGER, "scopeDigest" TEXT, "rowCount" INTEGER)',
      );
      image.exec(
        "INSERT INTO _syncular_segment VALUES (1,'tasks',1,7,'digest',2050)",
      );
      const descriptor = {
        table: 'tasks',
        rowCount: 2050,
        asOfCommitSeq: 7,
        scopeDigest: 'digest',
      };
      await expect(
        applySqliteSegment(
          db,
          compiled,
          table,
          image.db.serialize(),
          descriptor,
          {
            clearFirst: true,
            effective: { project_id: ['p1'] },
            owners: () => [],
          },
        ),
      ).rejects.toThrow();
      expect(db.query('SELECT count(*) AS n FROM tasks')).toEqual([
        { n: 1024 },
      ]);
      expect(
        db.query(
          "SELECT count(*) AS n FROM tasks_fts WHERE tasks_fts MATCH 'searchable'",
        ),
      ).toEqual([{ n: 1024 }]);
      expect(() => db.query('SELECT * FROM syncular_image.tasks')).toThrow();
      image.exec("UPDATE tasks SET title='searchable 1500' WHERE id='01500'");
      await expect(
        applySqliteSegment(
          db,
          compiled,
          table,
          image.db.serialize(),
          descriptor,
          {
            clearFirst: true,
            effective: { project_id: ['p1'] },
            owners: () => [],
          },
        ),
      ).resolves.toBe(2050);
      expect(
        db.query('SELECT count(*) AS n FROM _syncular_fts_tasks_fts'),
      ).toEqual([{ n: 2050 }]);
    } finally {
      image.close();
      db.close();
    }
  });

  test('image chunk boundaries cannot silently skip malformed NULL primary keys', async () => {
    const db = new BunClientDatabase();
    const image = new BunClientDatabase();
    try {
      const compiled = compileClientSchema(SCHEMA);
      const table = compiled.tables.get('tasks');
      if (!table) throw new Error('missing tasks');
      ensureLocalSchema(db, compiled);
      image.exec(
        'CREATE TABLE tasks(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, _syncular_version INTEGER NOT NULL)',
      );
      image.exec(
        "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1025) INSERT INTO tasks SELECT NULL,'p1','row-'||x,1 FROM n",
      );
      image.exec(
        'CREATE TABLE _syncular_segment(format INTEGER, "table" TEXT, "schemaVersion" INTEGER, "asOfCommitSeq" INTEGER, "scopeDigest" TEXT, "rowCount" INTEGER)',
      );
      image.exec(
        "INSERT INTO _syncular_segment VALUES (1,'tasks',1,7,'digest',1025)",
      );
      await expect(
        applySqliteSegment(
          db,
          compiled,
          table,
          image.db.serialize(),
          {
            table: 'tasks',
            rowCount: 1025,
            asOfCommitSeq: 7,
            scopeDigest: 'digest',
          },
          {
            clearFirst: true,
            effective: { project_id: ['p1'] },
            owners: () => [],
          },
        ),
      ).rejects.toThrow();
    } finally {
      image.close();
      db.close();
    }
  });

  test('segment column mismatches carry the table and column in details', async () => {
    const compiled = compileClientSchema(SCHEMA);
    const table = compiled.tables.get('tasks');
    if (!table) throw new Error('missing tasks');
    const columns: RowColumn[] = table.columns.map(
      ({ name, type, nullable }) => ({ name, type, nullable }),
    );
    const validate = (segmentColumns: RowColumn[]): unknown => {
      try {
        validateSegmentColumns(compiled, table, {
          table: 'tasks',
          schemaVersion: 1,
          columns: segmentColumns,
          blocks: [],
        });
      } catch (error) {
        return error;
      }
      return undefined;
    };
    const renamed = validate(
      columns.map((column, i) =>
        i === 1 ? { ...column, name: 'other' } : column,
      ),
    );
    expect(renamed).toBeInstanceOf(ClientSyncError);
    if (!(renamed instanceof ClientSyncError)) return;
    expect(renamed.code).toBe('sync.schema_mismatch');
    expect(renamed.message).toBe(
      'rows segment columns do not match the generated schema (§5.2)',
    );
    expect(renamed.details).toEqual({ table: 'tasks', column: 1 });
    const short = validate(columns.slice(1));
    expect(short).toBeInstanceOf(ClientSyncError);
    if (!(short instanceof ClientSyncError)) return;
    expect(short.details).toEqual({ table: 'tasks', column: 'count' });

    const db = new BunClientDatabase();
    const image = new BunClientDatabase();
    try {
      ensureLocalSchema(db, compiled);
      image.exec(
        'CREATE TABLE tasks(id TEXT PRIMARY KEY, other TEXT, title TEXT NOT NULL, _syncular_version INTEGER NOT NULL)',
      );
      image.exec(
        'CREATE TABLE _syncular_segment(format INTEGER, "table" TEXT, "schemaVersion" INTEGER, "asOfCommitSeq" INTEGER, "scopeDigest" TEXT, "rowCount" INTEGER)',
      );
      image.exec(
        "INSERT INTO _syncular_segment VALUES (1,'tasks',1,7,'digest',0)",
      );
      const failure = await applySqliteSegment(
        db,
        compiled,
        table,
        image.db.serialize(),
        {
          table: 'tasks',
          rowCount: 0,
          asOfCommitSeq: 7,
          scopeDigest: 'digest',
        },
        {
          clearFirst: true,
          effective: { project_id: ['p1'] },
          owners: () => [],
        },
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(ClientSyncError);
      if (!(failure instanceof ClientSyncError)) return;
      expect(failure.code).toBe('sync.schema_mismatch');
      expect(failure.message).toBe(
        'sqlite segment columns do not match the generated schema (§5.3)',
      );
      expect(failure.details).toEqual({ table: 'tasks' });
    } finally {
      image.close();
      db.close();
    }
  });

  test('sqlite-image primary-key upserts preserve rows on a secondary unique collision', async () => {
    const db = new BunClientDatabase();
    const compiled = compileClientSchema(SCHEMA);
    const table = compiled.tables.get('tasks');
    if (table === undefined) throw new Error('compiled tasks table missing');
    ensureLocalSchema(db, compiled);
    upsertLocalRow(db, table, ['t1', 'p1', 'original'], 1);

    const descriptor = {
      table: 'tasks',
      rowCount: 1,
      asOfCommitSeq: 7,
      scopeDigest: 'digest',
    } as const;
    expect(
      await applySqliteSegment(
        db,
        compiled,
        table,
        sqliteImageBytes([
          {
            id: 't1',
            projectId: 'p1',
            title: 'updated',
            version: 2,
          },
        ]),
        descriptor,
        {
          clearFirst: false,
          effective: { project_id: ['p1'] },
          owners: () => [],
        },
      ),
    ).toBe(1);
    upsertLocalRow(db, table, ['t2', 'p1', 'original'], 1);

    await expect(
      applySqliteSegment(
        db,
        compiled,
        table,
        sqliteImageBytes([
          {
            id: 't3',
            projectId: 'p1',
            title: 'original',
            version: 3,
          },
        ]),
        descriptor,
        {
          clearFirst: false,
          effective: { project_id: ['p1'] },
          owners: () => [],
        },
      ),
    ).rejects.toThrow();
    expect(
      db.query('SELECT id, title, _sync_version FROM tasks ORDER BY id'),
    ).toEqual([
      { id: 't1', title: 'updated', _sync_version: 2 },
      { id: 't2', title: 'original', _sync_version: 1 },
    ]);
  });

  test('the §7.4.3 drop-and-recreate reset restores the indexes', () => {
    const db = new BunClientDatabase();
    const compiled = compileClientSchema(SCHEMA);
    ensureLocalSchema(db, compiled);
    expect(indexNames(db)).toHaveLength(2);
    // The reset path drops every synced table (auto-dropping its indexes) and
    // recreates from the schema — indexes must come back.
    db.transaction(() => {
      resetLocalReplica(db, compiled);
    });
    expect(indexNames(db)).toEqual([
      'idx_tasks_project',
      'idx_tasks_project_title',
    ]);
    expect(indexSql(db, 'idx_tasks_project_title')).toMatch(/UNIQUE/);
  });

  test('declared indexes reconcile in place and leave app indexes alone', () => {
    const db = new BunClientDatabase();
    const withIndexes = (
      indexes: NonNullable<ClientSchema['tables'][number]['indexes']>,
    ) =>
      compileClientSchema({
        version: 1,
        tables: [{ ...SCHEMA.tables[0]!, indexes }],
      });
    const record = () =>
      db.query("SELECT value FROM _syncular_meta WHERE key='localIndexes'");
    ensureLocalSchema(db, compileClientSchema(SCHEMA));
    db.exec("INSERT INTO tasks(id,project_id,title) VALUES ('t1','p1','a')");
    db.exec('CREATE INDEX app_tasks_title ON tasks(title)');
    expect(record()).toEqual([
      {
        value: JSON.stringify({
          tasks: ['idx_tasks_project', 'idx_tasks_project_title'],
        }),
      },
    ]);
    // Drop the plain index, turn the unique one into a plain index over
    // other columns, and add a new one.
    ensureLocalSchema(
      db,
      withIndexes([
        {
          name: 'idx_tasks_project_title',
          columns: ['title', 'project_id'],
          unique: false,
        },
        { name: 'idx_tasks_title', columns: ['title'], unique: true },
      ]),
    );
    expect(indexNames(db)).toEqual([
      'app_tasks_title',
      'idx_tasks_project_title',
      'idx_tasks_title',
    ]);
    expect(indexSql(db, 'idx_tasks_project_title')).not.toMatch(/UNIQUE/);
    expect(indexSql(db, 'idx_tasks_project_title')).toMatch(
      /"title".*"project_id"/,
    );
    expect(indexSql(db, 'idx_tasks_title')).toMatch(/UNIQUE/);
    expect(record()).toEqual([
      {
        value: JSON.stringify({
          tasks: ['idx_tasks_project_title', 'idx_tasks_title'],
        }),
      },
    ]);
    expect(db.query('SELECT id FROM tasks')).toEqual([{ id: 't1' }]);
    // An index the schema stops declaring that Syncular never recorded stays.
    db.exec("DELETE FROM _syncular_meta WHERE key='localIndexes'");
    ensureLocalSchema(
      db,
      compileClientSchema({
        ...SCHEMA,
        tables: [{ ...SCHEMA.tables[0]!, indexes: [] }],
      }),
    );
    expect(indexNames(db)).toEqual([
      'app_tasks_title',
      'idx_tasks_project_title',
      'idx_tasks_title',
    ]);
    expect(record()).toEqual([{ value: '{}' }]);
  });

  test('a missing localIndexes record backfills the declared indexes that exist', () => {
    const db = new BunClientDatabase();
    const compiled = compileClientSchema(SCHEMA);
    ensureLocalSchema(db, compiled);
    db.exec('CREATE INDEX app_tasks_title ON tasks(title)');
    db.exec("DELETE FROM _syncular_meta WHERE key='localIndexes'");
    ensureLocalSchema(db, compiled);
    expect(
      db.query("SELECT value FROM _syncular_meta WHERE key='localIndexes'"),
    ).toEqual([
      {
        value: JSON.stringify({
          tasks: ['idx_tasks_project', 'idx_tasks_project_title'],
        }),
      },
    ]);
    // The backfilled names are now Syncular's to drop; the app index is not.
    ensureLocalSchema(
      db,
      compileClientSchema({
        ...SCHEMA,
        tables: [{ ...SCHEMA.tables[0]!, indexes: [] }],
      }),
    );
    expect(indexNames(db)).toEqual(['app_tasks_title']);
  });

  test('an index-only schema change keeps rows and units', async () => {
    const database = new BunClientDatabase();
    const schemaAt = (
      version: number,
      indexes: NonNullable<ClientSchema['tables'][number]['indexes']>,
    ): ClientSchema => ({
      version,
      tables: [{ ...SCHEMA.tables[0]!, generation: 'g1', indexes }],
    });
    const open = async (schema: ClientSchema) => {
      const client = new SyncClient({
        schema,
        database,
        transport: async () => new Uint8Array(),
      });
      await client.start();
      return client;
    };
    const first = await open(schemaAt(1, SCHEMA.tables[0]!.indexes!));
    const unit = first.subscribe({ project_id: 'p1' });
    database.exec(
      "INSERT INTO tasks(id,project_id,title,_sync_version) VALUES ('t1','p1','a',3)",
    );
    await first.close();
    const second = await open(
      schemaAt(2, [
        { name: 'idx_tasks_title', columns: ['title'], unique: false },
      ]),
    );
    try {
      expect(database.query('SELECT id,_sync_version FROM tasks')).toEqual([
        { id: 't1', _sync_version: 3 },
      ]);
      expect(database.query('SELECT id FROM _syncular_units')).toEqual([
        { id: unit },
      ]);
      expect(indexNames(database)).toEqual(['idx_tasks_title']);
    } finally {
      await second.close();
      database.close();
    }
  });

  test('an ineligible primary-key type fails at compile', () => {
    // §2.4: a `rowId` is a string, so a primary key type whose string form
    // differs per renderer, or cannot be reproduced by local storage
    // comparison, is a schema error rather than a silent lookup miss.
    for (const type of ['float', 'bytes', 'crdt', 'blob_ref'] as const) {
      const bad: ClientSchema = {
        version: 1,
        tables: [
          {
            name: 'tasks',
            columns: [{ name: 'id', type, nullable: false }],
            primaryKey: 'id',
            scopes: ['project:{id}'],
          },
        ],
      };
      expect(() => compileClientSchema(bad)).toThrow(
        /primary key "id" has an ineligible type/,
      );
    }
  });

  test('a scope column that is not a string or integer fails at compile', () => {
    // §3.1: a scope value is an authorization key, so its column type must
    // render identically in every implementation. An unknown column fails
    // the same check.
    for (const type of [
      'float',
      'boolean',
      'json',
      'bytes',
      'blob_ref',
      'crdt',
    ] as const) {
      const bad: ClientSchema = {
        version: 1,
        tables: [
          {
            name: 'tasks',
            columns: [
              { name: 'id', type: 'string', nullable: false },
              { name: 'bucket', type, nullable: false },
            ],
            primaryKey: 'id',
            scopes: ['bucket:{bucket}'],
          },
        ],
      };
      expect(() => compileClientSchema(bad)).toThrow(
        /scope column "bucket" must be string or integer/,
      );
    }
    expect(() =>
      compileClientSchema({
        version: 1,
        tables: [
          {
            name: 'tasks',
            columns: [{ name: 'id', type: 'string', nullable: false }],
            primaryKey: 'id',
            scopes: ['bucket:{nope}'],
          },
        ],
      }),
    ).toThrow(/scope column "nope" must be string or integer/);
  });

  test('an index naming an unknown column fails at compile', () => {
    const bad: ClientSchema = {
      version: 1,
      tables: [
        {
          name: 'tasks',
          columns: [{ name: 'id', type: 'string', nullable: false }],
          primaryKey: 'id',
          scopes: ['project:{id}'],
          indexes: [{ name: 'idx_bad', columns: ['nope'], unique: false }],
        },
      ],
    };
    expect(() => compileClientSchema(bad)).toThrow(
      /index "idx_bad" names unknown column "nope"/,
    );
  });
});

test('image and rows payloads report their import cost; the next payload starts without it', async () => {
  const digest = createHash('sha256')
    .update(JSON.stringify({ project_id: ['p1'] }))
    .digest('hex');
  const image = new Database(':memory:');
  image.exec(
    'CREATE TABLE tasks(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, _syncular_version INTEGER NOT NULL); CREATE TABLE _syncular_segment(format INTEGER, "table" TEXT, "schemaVersion" INTEGER, "asOfCommitSeq" INTEGER, "scopeDigest" TEXT, "rowCount" INTEGER)',
  );
  image.exec(
    "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<3000) INSERT INTO tasks SELECT printf('%05d',x),'p1','title '||x,1 FROM n",
  );
  image
    .query("INSERT INTO _syncular_segment VALUES (1,'tasks',1,1,?,3000)")
    .run(digest);
  const bytes = new Uint8Array(image.serialize());
  image.close();
  const segmentId = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const notes = encodeRowsSegment({
    table: 'notes',
    schemaVersion: 1,
    columns: [
      { name: 'id', type: 'string', nullable: false },
      { name: 'project_id', type: 'string', nullable: false },
    ],
    blocks: [[{ serverVersion: 1, values: ['n1', 'p1'] }]],
  });
  const database = new BunClientDatabase();
  let unit = '';
  const client = new SyncClient({
    database,
    schema: {
      version: 1,
      tables: [
        SCHEMA.tables[0]!,
        {
          name: 'notes',
          columns: [
            { name: 'id', type: 'string', nullable: false },
            { name: 'project_id', type: 'string', nullable: false },
          ],
          primaryKey: 'id',
          scopes: ['project:{project_id}'],
        },
      ],
    },
    segments: async () => bytes,
    transport: async () =>
      encodeMessage({
        wireVersion: PROTOCOL_WIRE_VERSION,
        msgKind: 'response',
        frames: [
          { type: 'RESP_HEADER', logEpoch: 'test', resetRequired: false },
          {
            type: 'SUB_START',
            id: unit,
            status: 'active',
            reasonCode: '',
            bootstrap: true,
            fenced: [],
          },
          {
            type: 'SEGMENT_REF',
            segmentId,
            mediaType: 'sqlite',
            table: 'tasks',
            byteLength: bytes.byteLength,
            rowCount: 3000,
            asOfCommitSeq: 1,
            scopeDigest: digest,
          },
          { type: 'SEGMENT_INLINE', payload: notes },
          { type: 'SUB_END', nextCursor: 1 },
          { type: 'LIVE_START', status: 'active', reasonCode: '' },
          {
            type: 'LIVE_END',
            throughSeq: 1,
            echoDigest: echoDigest([
              { id: unit, status: 'active', fenced: [] },
            ]),
          },
        ],
      }),
  });
  try {
    await client.start();
    database.exec(
      "INSERT OR REPLACE INTO _syncular_meta(key,value) VALUES ('logEpoch','test')",
    );
    await client.setWindow({ variable: 'project_id' }, ['p1']);
    unit = client.units()[0]!.id;
    const seen: SyncProgress[] = [];
    const off = client.onProgress((progress) => seen.push(progress));
    await client.sync();
    off();
    const tasks = seen.filter(
      (progress) => progress.table === 'tasks' && progress.phase === 'import',
    );
    // The cost appears once the first transaction committed; the download
    // time once the body arrived.
    expect(tasks[0]?.importWriteMs).toBeUndefined();
    expect(tasks[0]?.downloadMs).toEqual(expect.any(Number));
    expect(
      seen.find((progress) => progress.phase === 'download')?.downloadMs,
    ).toBeUndefined();
    expect(tasks.at(-1)).toMatchObject({
      rowsProcessed: 3000,
      importWriteMs: expect.any(Number),
      importCommitMs: expect.any(Number),
      downloadMs: expect.any(Number),
    });
    const notes = seen.filter((progress) => progress.table === 'notes');
    expect(notes[0]?.importWriteMs).toBeUndefined();
    expect(notes[0]?.importCommitMs).toBeUndefined();
    // An inline segment downloads nothing.
    expect(notes.every((progress) => progress.downloadMs === undefined)).toBe(
      true,
    );
    expect(notes.at(-1)).toMatchObject({
      rowsProcessed: 1,
      importWriteMs: expect.any(Number),
      importCommitMs: expect.any(Number),
    });
  } finally {
    await client.close();
    database.close();
  }
});
