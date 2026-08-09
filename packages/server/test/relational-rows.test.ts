/**
 * Relational server storage.
 *
 * What the generic blob store could never offer — and what these tests pin:
 *   1. the server database holds REAL app tables (`SELECT title FROM tasks`
 *      works, a join across two app tables works);
 *   2. the same app PK in two partitions coexists (partition is in the PK);
 *   3. `json` columns are queryable JSONB on Postgres;
 *   4. the serve path is byte-verbatim (`_sync_payload` round-trips), with
 *      the row-codec round-trip invariant asserted per column type;
 *   5. schema version bumps apply the migration subset (ADD COLUMN /
 *      CREATE/DROP INDEX / DROP TABLE) and the version marker gates re-runs;
 *   6. reserved identifiers are rejected at schema compile.
 */
import { describe, expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import {
  decodeRow,
  encodeRow,
  type RowColumn,
  type RowValue,
} from '@syncular/core';
import {
  commitWindowPageSql,
  compileSchema,
  createTableDdl,
  D1ServerStorage,
  PostgresServerStorage,
  physicalIndexName,
  postgresScopeValueParam,
  scanRowPageSql,
  type ServerSchema,
  SqliteServerStorage,
  type StoredRow,
} from '@syncular/server';
import { pgliteExecutor } from '@syncular/server/pglite';
import type { D1Database, D1PreparedStatement } from '../src/d1-storage';
import type { PgExecutor, PgQueryable } from '../src/pg-executor';
import type {
  SqliteDatabase,
  SqliteRunResult,
  SqliteStatement,
  SqliteValue,
} from '../src/sqlite-driver';
import { D1DatabaseDouble } from './d1-double';

const PARTITION = 'part-1';

const TASK_COLUMNS: readonly RowColumn[] = [
  { name: 'id', type: 'string', nullable: false },
  { name: 'project_id', type: 'string', nullable: false },
  { name: 'title', type: 'string', nullable: false },
  { name: 'completed', type: 'boolean', nullable: false },
  { name: 'priority', type: 'integer', nullable: true },
  { name: 'score', type: 'float', nullable: true },
  { name: 'meta', type: 'json', nullable: true },
  { name: 'thumb', type: 'bytes', nullable: true },
];

const PROJECT_COLUMNS: readonly RowColumn[] = [
  { name: 'id', type: 'string', nullable: false },
  { name: 'project_id', type: 'string', nullable: false },
  { name: 'name', type: 'string', nullable: false },
];

const SCHEMA: ServerSchema = {
  version: 1,
  tables: [
    {
      name: 'tasks',
      columns: TASK_COLUMNS,
      primaryKey: 'id',
      scopes: ['project:{project_id}'],
      indexes: [
        { name: 'tasks_by_title', columns: ['title'] },
        {
          name: 'tasks_by_project_title',
          columns: ['project_id', 'title'],
          unique: true,
        },
      ],
    },
    {
      name: 'projects',
      columns: PROJECT_COLUMNS,
      primaryKey: 'id',
      scopes: ['project:{project_id}'],
    },
  ],
};

const INDEX_REPLACEMENT_SCHEMA: ServerSchema = {
  version: 2,
  tables: [
    {
      ...SCHEMA.tables[0]!,
      indexes: [
        {
          name: 'tasks_by_title',
          columns: ['project_id', 'title'],
          unique: true,
        },
      ],
    },
    SCHEMA.tables[1]!,
  ],
};

function nullableAppendSchema(): ServerSchema {
  return {
    version: 2,
    tables: [
      {
        name: 'tasks',
        columns: [
          ...TASK_COLUMNS,
          { name: 'assignee', type: 'string', nullable: true },
        ],
        primaryKey: 'id',
        scopes: ['project:{project_id}'],
        indexes: [
          { name: 'tasks_by_title', columns: ['title'] },
          { name: 'tasks_by_assignee', columns: ['assignee'] },
        ],
      },
      ...SCHEMA.tables.slice(1),
    ],
  };
}

function secondNullableAppendSchema(): ServerSchema {
  const v2 = nullableAppendSchema();
  return {
    version: 3,
    tables: [
      {
        ...v2.tables[0]!,
        columns: [
          ...v2.tables[0]!.columns,
          { name: 'reviewer', type: 'string', nullable: true },
        ],
      },
      ...v2.tables.slice(1),
    ],
  };
}

function taskRow(
  rowId: string,
  project: string,
  title: string,
  values?: Partial<{
    completed: boolean;
    priority: number | null;
    score: number | null;
    meta: string | null;
    thumb: Uint8Array | null;
  }>,
): StoredRow {
  return {
    rowId,
    serverVersion: 1,
    scopes: { project_id: project },
    payload: encodeRow(TASK_COLUMNS, [
      rowId,
      project,
      title,
      values?.completed ?? false,
      values?.priority ?? null,
      values?.score ?? null,
      values?.meta ?? null,
      values?.thumb ?? null,
    ]),
  };
}

function projectRow(rowId: string, name: string): StoredRow {
  return {
    rowId,
    serverVersion: 1,
    scopes: { project_id: rowId },
    payload: encodeRow(PROJECT_COLUMNS, [rowId, rowId, name]),
  };
}

async function sqliteStorage(): Promise<SqliteServerStorage> {
  const storage = new SqliteServerStorage();
  await storage.ensureSchema(compileSchema(SCHEMA));
  return storage;
}

async function upsert(
  storage: SqliteServerStorage | PostgresServerStorage | D1ServerStorage,
  partition: string,
  table: string,
  row: StoredRow,
): Promise<void> {
  const tx = await storage.begin(partition);
  await tx.upsertRow(table, row);
  await tx.commit();
}

// --- 4. the row-codec round-trip invariant (per column type) ---------------

describe('row-codec round-trip invariant (encode∘decode = id)', () => {
  const cases: [string, readonly RowColumn[], RowValue[]][] = [
    ['string', [{ name: 'c', type: 'string', nullable: false }], ['héllo']],
    ['integer', [{ name: 'c', type: 'integer', nullable: false }], [42]],
    [
      'large integer',
      [{ name: 'c', type: 'integer', nullable: false }],
      [Number.MAX_SAFE_INTEGER],
    ],
    ['float', [{ name: 'c', type: 'float', nullable: false }], [Math.PI]],
    ['boolean', [{ name: 'c', type: 'boolean', nullable: false }], [true]],
    [
      'json',
      [{ name: 'c', type: 'json', nullable: false }],
      ['{"b":1,"a":[null,2]}'],
    ],
    [
      'bytes',
      [{ name: 'c', type: 'bytes', nullable: false }],
      [new Uint8Array([0, 255, 128])],
    ],
    ['null', [{ name: 'c', type: 'string', nullable: true }], [null]],
  ];
  for (const [name, columns, values] of cases) {
    test(name, () => {
      const payload = encodeRow(columns, values);
      const decoded = decodeRow(columns, payload);
      expect(encodeRow(columns, decoded)).toEqual(payload);
    });
  }
});

// --- 1./2. real relational structure on SQLite ------------------------------

describe('relational tables (sqlite)', () => {
  test('SELECT app columns with WHERE works on the server database', async () => {
    const storage = await sqliteStorage();
    await upsert(
      storage,
      PARTITION,
      'tasks',
      taskRow('t1', 'p1', 'write docs'),
    );
    await upsert(
      storage,
      PARTITION,
      'tasks',
      taskRow('t2', 'p1', 'review pr', { completed: true, priority: 2 }),
    );
    await upsert(storage, PARTITION, 'tasks', taskRow('t3', 'p2', 'other'));

    const rows = storage.db
      .query<
        { title: string; completed: number; priority: number | null },
        [string]
      >(
        'SELECT title, completed, priority FROM tasks WHERE project_id = ? ORDER BY id',
      )
      .all('p1');
    expect(rows).toEqual([
      { title: 'write docs', completed: 0, priority: null },
      { title: 'review pr', completed: 1, priority: 2 },
    ]);
  });

  test('a join across two app tables works', async () => {
    const storage = await sqliteStorage();
    await upsert(storage, PARTITION, 'projects', projectRow('p1', 'Syncular'));
    await upsert(storage, PARTITION, 'tasks', taskRow('t1', 'p1', 'ship it'));

    const rows = storage.db
      .query<{ title: string; project: string }, []>(
        `SELECT t.title AS title, p.name AS project
         FROM tasks t JOIN projects p ON p.id = t.project_id
          AND p._sync_partition = t._sync_partition`,
      )
      .all();
    expect(rows).toEqual([{ title: 'ship it', project: 'Syncular' }]);
  });

  test('the same app PK coexists in two partitions', async () => {
    const storage = await sqliteStorage();
    await upsert(storage, 'part-a', 'tasks', taskRow('t1', 'p1', 'in a'));
    await upsert(storage, 'part-b', 'tasks', taskRow('t1', 'p1', 'in b'));

    const a = await storage.getRow('part-a', 'tasks', 't1');
    const b = await storage.getRow('part-b', 'tasks', 't1');
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(decodeRow(TASK_COLUMNS, a!.payload)[2]).toBe('in a');
    expect(decodeRow(TASK_COLUMNS, b!.payload)[2]).toBe('in b');
  });

  test('the payload round-trips byte-verbatim through the store', async () => {
    const storage = await sqliteStorage();
    const row = taskRow('t1', 'p1', 'exact', {
      priority: 7,
      score: 0.5,
      meta: '{"tags":["a","b"]}',
      thumb: new Uint8Array([9, 9, 9]),
    });
    await upsert(storage, PARTITION, 'tasks', row);
    const stored = await storage.getRow(PARTITION, 'tasks', 't1');
    expect(stored?.payload).toEqual(row.payload);
  });

  test('user-declared indexes are created server-side under the ownership prefix', async () => {
    const storage = await sqliteStorage();
    const indexes = storage.db
      .query<{ name: string }, [string]>(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=?",
      )
      .all('tasks');
    expect(indexes.map((i) => i.name)).toContain('sync_ix_tasks_by_title');
  });

  test('a secondary unique collision never replaces the existing server row', async () => {
    const storage = await sqliteStorage();
    await upsert(storage, PARTITION, 'tasks', taskRow('t1', 'p1', 'original'));
    await upsert(storage, PARTITION, 'tasks', taskRow('t1', 'p1', 'updated'));
    await upsert(storage, PARTITION, 'tasks', taskRow('t2', 'p1', 'original'));

    await expect(
      upsert(storage, PARTITION, 'tasks', taskRow('t3', 'p1', 'original')),
    ).rejects.toThrow();
    const rows = storage.db
      .query<{ id: string; title: string }, []>(
        'SELECT id, title FROM tasks ORDER BY id',
      )
      .all();
    expect(rows).toEqual([
      { id: 't1', title: 'updated' },
      { id: 't2', title: 'original' },
    ]);
  });
});

describe('relational tables (D1)', () => {
  test('a secondary unique collision never replaces the existing server row', async () => {
    const db = new D1DatabaseDouble();
    const storage = new D1ServerStorage(db);
    await storage.ensureSchema(compileSchema(SCHEMA));
    await upsert(storage, PARTITION, 'tasks', taskRow('t1', 'p1', 'original'));
    await upsert(storage, PARTITION, 'tasks', taskRow('t1', 'p1', 'updated'));
    await upsert(storage, PARTITION, 'tasks', taskRow('t2', 'p1', 'original'));

    await expect(
      upsert(storage, PARTITION, 'tasks', taskRow('t3', 'p1', 'original')),
    ).rejects.toThrow();
    const { results } = await db
      .prepare('SELECT id, title FROM tasks ORDER BY id')
      .all<{ id: string; title: string }>();
    expect(results).toEqual([
      { id: 't1', title: 'updated' },
      { id: 't2', title: 'original' },
    ]);
  });
});

// --- 3. Postgres: JSONB + the same relational assertions --------------------

describe('relational tables (postgres/pglite)', () => {
  test('json columns are queryable JSONB; app SELECT and join work', async () => {
    const db = await PGlite.create();
    const storage = new PostgresServerStorage(pgliteExecutor(db));
    await storage.ensureSchema(compileSchema(SCHEMA));
    await upsert(storage, PARTITION, 'projects', projectRow('p1', 'Syncular'));
    await upsert(
      storage,
      PARTITION,
      'tasks',
      taskRow('t1', 'p1', 'tagged', { meta: '{"tags":["urgent"]}' }),
    );

    const byTag = await db.query<{ title: string }>(
      `SELECT title FROM tasks WHERE meta->'tags' ? 'urgent'`,
    );
    expect(byTag.rows).toEqual([{ title: 'tagged' }]);

    const joined = await db.query<{ title: string; project: string }>(
      `SELECT t.title AS title, p.name AS project
       FROM tasks t JOIN projects p ON p.id = t.project_id
        AND p._sync_partition = t._sync_partition`,
    );
    expect(joined.rows).toEqual([{ title: 'tagged', project: 'Syncular' }]);

    // Byte-verbatim serve path on Postgres too.
    const row = taskRow('t2', 'p1', 'exact bytes', {
      thumb: new Uint8Array([1, 2, 3]),
    });
    await upsert(storage, PARTITION, 'tasks', row);
    const stored = await storage.getRow(PARTITION, 'tasks', 't2');
    expect(stored?.payload).toEqual(row.payload);
  });
});

// --- 5. server-side schema migration ---------------------------------------

describe('server-side schema migration (the subset)', () => {
  test('a version bump adds columns and indexes; the marker gates re-runs', async () => {
    const storage = new SqliteServerStorage();
    await storage.ensureSchema(compileSchema(SCHEMA));
    await upsert(storage, PARTITION, 'tasks', taskRow('t1', 'p1', 'v1 row'));

    const v2 = nullableAppendSchema();
    await storage.ensureSchema(compileSchema(v2));

    const columns = storage.db
      .query<{ name: string }, []>('PRAGMA table_info("tasks")')
      .all()
      .map((c) => c.name);
    expect(columns).toContain('assignee');
    const indexes = storage.db
      .query<{ name: string }, [string]>(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=?",
      )
      .all('tasks')
      .map((i) => i.name);
    expect(indexes).toContain('sync_ix_tasks_by_assignee');
    expect(indexes).not.toContain('sync_ix_tasks_by_project_title');
    const marker = storage.db
      .query<{ schema_version: number }, []>(
        'SELECT schema_version FROM sync_schema_meta WHERE id=1',
      )
      .get();
    expect(marker?.schema_version).toBe(2);
    // The v1 row survives the migration (ADD COLUMN backfills NULL).
    const survived = storage.db
      .query<{ title: string; assignee: string | null }, []>(
        'SELECT title, assignee FROM tasks',
      )
      .all();
    expect(survived).toEqual([{ title: 'v1 row', assignee: null }]);
    // The payload was MIGRATED: the codec is strict, so the stored bytes
    // must decode under the v2 column list (with a trailing NULL) — the
    // write path and bootstrap serve both depend on this.
    const v2Columns = v2.tables[0]?.columns ?? [];
    const stored = await storage.getRow(PARTITION, 'tasks', 't1');
    const decoded = decodeRow(v2Columns, stored!.payload);
    expect(decoded[2]).toBe('v1 row');
    expect(decoded[v2Columns.length - 1]).toBeNull();
  });

  test('Postgres preserves existing rows across a nullable column append', async () => {
    const db = await PGlite.create();
    const storage = new PostgresServerStorage(pgliteExecutor(db));
    await storage.ensureSchema(compileSchema(SCHEMA));
    await upsert(storage, PARTITION, 'tasks', taskRow('t1', 'p1', 'v1 row'));

    const v2 = nullableAppendSchema();
    await storage.ensureSchema(compileSchema(v2));
    const stored = await storage.getRow(PARTITION, 'tasks', 't1');
    expect(decodeRow(v2.tables[0]!.columns, stored!.payload).at(-1)).toBeNull();
    const projected = await db.query<{ assignee: string | null }>(
      "SELECT assignee FROM tasks WHERE id='t1'",
    );
    expect(projected.rows).toEqual([{ assignee: null }]);
  });

  test('D1 preserves existing rows across a nullable column append', async () => {
    const db = new D1DatabaseDouble();
    const storage = new D1ServerStorage(db);
    await storage.ensureSchema(compileSchema(SCHEMA));
    await upsert(storage, PARTITION, 'tasks', taskRow('t1', 'p1', 'v1 row'));

    const v2 = nullableAppendSchema();
    await storage.ensureSchema(compileSchema(v2));
    const stored = await storage.getRow(PARTITION, 'tasks', 't1');
    expect(decodeRow(v2.tables[0]!.columns, stored!.payload).at(-1)).toBeNull();
    const projected = await db
      .prepare("SELECT assignee FROM tasks WHERE id='t1'")
      .first<{ assignee: string | null }>();
    expect(projected).toEqual({ assignee: null });
  });

  test('a competing D1 layout cannot rewrite rows beneath another migration target', async () => {
    const db = new D1DatabaseDouble();
    const v1 = new D1ServerStorage(db);
    await v1.ensureSchema(compileSchema(SCHEMA));
    await upsert(v1, PARTITION, 'tasks', taskRow('t1', 'p1', 'v1 row'));

    let announce!: () => void;
    const announced = new Promise<void>((resolve) => {
      announce = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sqlByStatement = new WeakMap<D1PreparedStatement, string>();
    let rewriteGated = false;
    const gated: D1Database = {
      prepare(query: string): D1PreparedStatement {
        const statement = db.prepare(query);
        sqlByStatement.set(statement, query);
        return statement;
      },
      async batch(statements: D1PreparedStatement[]): Promise<unknown[]> {
        if (
          !rewriteGated &&
          statements.some((statement) =>
            sqlByStatement.get(statement)?.startsWith('UPDATE "tasks" SET'),
          )
        ) {
          rewriteGated = true;
          announce();
          await released;
        }
        return db.batch(statements);
      },
      exec(query: string): Promise<unknown> {
        return db.exec(query);
      },
    };

    const v2Migration = new D1ServerStorage(gated).ensureSchema(
      compileSchema(nullableAppendSchema()),
    );
    await announced;
    const v3Outcome = await new D1ServerStorage(db)
      .ensureSchema(compileSchema(secondNullableAppendSchema()))
      .then(
        () => undefined,
        (error: Error) => error,
      );
    release();
    const v2Outcome = await v2Migration.then(
      () => undefined,
      (error: Error) => error,
    );

    expect(v3Outcome).toBeInstanceOf(Error);
    expect(v3Outcome?.message).toContain('migration is already in progress');
    expect(v2Outcome).toBeUndefined();

    const v3 = secondNullableAppendSchema();
    const current = new D1ServerStorage(db);
    await current.ensureSchema(compileSchema(v3));
    const stored = await current.getRow(PARTITION, 'tasks', 't1');
    expect(decodeRow(v3.tables[0]!.columns, stored!.payload).slice(-2)).toEqual(
      [null, null],
    );
  });

  test('an active D1 migration fences old-instance reads and in-flight writes', async () => {
    const db = new D1DatabaseDouble();
    const old = new D1ServerStorage(db);
    const v1 = compileSchema(SCHEMA);
    await old.ensureSchema(v1);
    await upsert(old, PARTITION, 'tasks', taskRow('m1', 'p1', 'existing'));
    const inFlight = await old.begin(PARTITION);
    await inFlight.upsertRow(
      'tasks',
      taskRow('z-later', 'p1', 'old-layout write'),
    );

    let announce!: () => void;
    const announced = new Promise<void>((resolve) => {
      announce = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sqlByStatement = new WeakMap<D1PreparedStatement, string>();
    let rewriteGated = false;
    const gated: D1Database = {
      prepare(query: string): D1PreparedStatement {
        const statement = db.prepare(query);
        sqlByStatement.set(statement, query);
        return statement;
      },
      async batch(statements: D1PreparedStatement[]): Promise<unknown[]> {
        if (
          !rewriteGated &&
          statements.some((statement) =>
            sqlByStatement.get(statement)?.startsWith('UPDATE "tasks" SET'),
          )
        ) {
          rewriteGated = true;
          announce();
          await released;
        }
        return db.batch(statements);
      },
      exec(query: string): Promise<unknown> {
        return db.exec(query);
      },
    };

    const migration = new D1ServerStorage(gated).ensureSchema(
      compileSchema(nullableAppendSchema()),
    );
    await announced;
    const ensureOutcome = await old.ensureSchema(v1).then(
      () => undefined,
      (error: Error) => error,
    );
    const readOutcome = await old.getRow(PARTITION, 'tasks', 'm1').then(
      () => undefined,
      (error: Error) => error,
    );
    const scanOutcome = await old
      .scanRows(PARTITION, {
        table: 'tasks',
        scopeFilter: { project_id: ['p1'] },
        afterRowId: null,
        limit: 10,
      })
      .then(
        () => undefined,
        (error: Error) => error,
      );
    const late = await old.begin(PARTITION);
    const uniqueReadOutcome = await late
      .upsertRow('tasks', taskRow('z-second', 'p1', 'late unique read'))
      .then(
        () => undefined,
        (error: Error) => error,
      );
    const commitOutcome = await inFlight.commit().then(
      () => undefined,
      (error: Error) => error,
    );
    release();
    await migration;
    await inFlight.rollback();
    await late.rollback();

    for (const outcome of [
      ensureOutcome,
      readOutcome,
      scanOutcome,
      uniqueReadOutcome,
      commitOutcome,
    ]) {
      expect(outcome).toBeInstanceOf(Error);
      expect(outcome?.message).toContain('migration is already in progress');
    }
    const current = new D1ServerStorage(db);
    const v2 = nullableAppendSchema();
    await current.ensureSchema(compileSchema(v2));
    expect(await current.getRow(PARTITION, 'tasks', 'z-later')).toBeUndefined();
  });

  test('a stale D1 claimant accepts an equal target published first', async () => {
    const db = new D1DatabaseDouble();
    await new D1ServerStorage(db).ensureSchema(compileSchema(SCHEMA));
    const sqlByStatement = new WeakMap<D1PreparedStatement, string>();
    let announce!: () => void;
    const announced = new Promise<void>((resolve) => {
      announce = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let claimGated = false;
    const gated: D1Database = {
      prepare(query: string): D1PreparedStatement {
        const statement = db.prepare(query);
        sqlByStatement.set(statement, query);
        return statement;
      },
      async batch(statements: D1PreparedStatement[]): Promise<unknown[]> {
        if (
          !claimGated &&
          statements.some((statement) =>
            sqlByStatement
              .get(statement)
              ?.includes('INSERT OR IGNORE INTO sync_schema_migration'),
          )
        ) {
          claimGated = true;
          announce();
          await released;
        }
        return db.batch(statements);
      },
      exec(query: string): Promise<unknown> {
        return db.exec(query);
      },
    };
    const v2 = compileSchema(nullableAppendSchema());

    const stale = new D1ServerStorage(gated).ensureSchema(v2);
    await announced;
    await new D1ServerStorage(db).ensureSchema(v2);
    release();

    await expect(stale).resolves.toBeUndefined();
  });

  test('concurrent D1 callers can complete the same migration target', async () => {
    const db = new D1DatabaseDouble();
    const v1 = new D1ServerStorage(db);
    await v1.ensureSchema(compileSchema(SCHEMA));
    await upsert(v1, PARTITION, 'tasks', taskRow('t1', 'p1', 'v1 row'));

    let announce!: () => void;
    const announced = new Promise<void>((resolve) => {
      announce = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ddlGated = false;
    const gated: D1Database = {
      prepare(query: string): D1PreparedStatement {
        return db.prepare(query);
      },
      batch(statements: D1PreparedStatement[]): Promise<unknown[]> {
        return db.batch(statements);
      },
      async exec(query: string): Promise<unknown> {
        if (
          !ddlGated &&
          query.startsWith('ALTER TABLE "tasks" ADD COLUMN "assignee" TEXT')
        ) {
          ddlGated = true;
          announce();
          await released;
        }
        return db.exec(query);
      },
    };
    const v2 = compileSchema(nullableAppendSchema());

    const first = new D1ServerStorage(gated).ensureSchema(v2);
    await announced;
    await new D1ServerStorage(db).ensureSchema(v2);
    release();
    await first;

    const current = new D1ServerStorage(db);
    await current.ensureSchema(v2);
    const stored = await current.getRow(PARTITION, 'tasks', 't1');
    expect(
      decodeRow(v2.tables.get('tasks')!.columns, stored!.payload).at(-1),
    ).toBeNull();
  });

  test('D1 resumes after a committed rewrite page without rewriting it twice', async () => {
    const db = new D1DatabaseDouble();
    const v1 = new D1ServerStorage(db);
    await v1.ensureSchema(compileSchema(SCHEMA));
    await upsert(v1, PARTITION, 'tasks', taskRow('t1', 'p1', 'v1 row'));

    const sqlByStatement = new WeakMap<D1PreparedStatement, string>();
    let interrupted = false;
    let interruptNextPrepare = false;
    const crashAfterRewrite: D1Database = {
      prepare(query: string): D1PreparedStatement {
        if (interruptNextPrepare) {
          interruptNextPrepare = false;
          throw new Error('simulated process interruption after D1 commit');
        }
        const statement = db.prepare(query);
        sqlByStatement.set(statement, query);
        return statement;
      },
      async batch(statements: D1PreparedStatement[]): Promise<unknown[]> {
        const result = await db.batch(statements);
        if (
          !interrupted &&
          statements.some((statement) =>
            sqlByStatement.get(statement)?.startsWith('UPDATE "tasks" SET'),
          )
        ) {
          interrupted = true;
          interruptNextPrepare = true;
        }
        return result;
      },
      exec(query: string): Promise<unknown> {
        return db.exec(query);
      },
    };
    const v2 = nullableAppendSchema();

    await expect(
      new D1ServerStorage(crashAfterRewrite).ensureSchema(compileSchema(v2)),
    ).rejects.toThrow('simulated process interruption');
    await new D1ServerStorage(db).ensureSchema(compileSchema(v2));

    const current = new D1ServerStorage(db);
    await current.ensureSchema(compileSchema(v2));
    const stored = await current.getRow(PARTITION, 'tasks', 't1');
    expect(decodeRow(v2.tables[0]!.columns, stored!.payload).at(-1)).toBeNull();
    const migration = await db
      .prepare('SELECT id FROM sync_schema_migration WHERE id=1')
      .first<{ id: number }>();
    expect(migration).toBeNull();
  });

  test('a version bump replaces declared indexes on SQLite', async () => {
    const storage = new SqliteServerStorage();
    await storage.ensureSchema(compileSchema(SCHEMA));
    await storage.ensureSchema(compileSchema(INDEX_REPLACEMENT_SCHEMA));

    const indexes = storage.db
      .query<{ name: string; unique: number; origin: string }, []>(
        'PRAGMA index_list("tasks")',
      )
      .all()
      .filter((index) => index.origin === 'c');
    expect(indexes).toEqual([
      expect.objectContaining({ name: 'sync_ix_tasks_by_title', unique: 1 }),
    ]);
    const columns = storage.db
      .query<{ name: string }, []>(
        'PRAGMA index_info("sync_ix_tasks_by_title")',
      )
      .all()
      .map((column) => column.name);
    expect(columns).toEqual(['_sync_partition', 'project_id', 'title']);
  });

  test('same-version startup upgrades legacy declared indexes on SQLite', async () => {
    const storage = new SqliteServerStorage();
    await storage.ensureSchema(compileSchema(SCHEMA));
    storage.db.run('DROP INDEX sync_ix_tasks_by_project_title');
    storage.db.run(
      'CREATE UNIQUE INDEX sync_ix_tasks_by_project_title ON tasks (project_id, title)',
    );
    storage.db.run('CREATE INDEX ops_tasks_tuning ON tasks (title)');

    const restarted = new SqliteServerStorage(storage.db);
    await restarted.ensureSchema(compileSchema(SCHEMA));

    const columns = restarted.db
      .query<{ name: string }, []>(
        'PRAGMA index_info("sync_ix_tasks_by_project_title")',
      )
      .all()
      .map((column) => column.name);
    expect(columns).toEqual(['_sync_partition', 'project_id', 'title']);
    const indexes = restarted.db
      .query<{ name: string; unique: number }, []>('PRAGMA index_list("tasks")')
      .all();
    expect(indexes).toContainEqual(
      expect.objectContaining({
        name: 'sync_ix_tasks_by_project_title',
        unique: 1,
      }),
    );
    expect(indexes).toContainEqual(
      expect.objectContaining({ name: 'ops_tasks_tuning' }),
    );
  });

  test('an older SQLite repair cannot cross a newer schema bump', async () => {
    const storage = new SqliteServerStorage();
    await storage.ensureSchema(compileSchema(SCHEMA));
    storage.db.run('DROP INDEX sync_ix_tasks_by_project_title');
    storage.db.run(
      'CREATE UNIQUE INDEX sync_ix_tasks_by_project_title ON tasks (project_id, title)',
    );

    let newer: Promise<void> | undefined;
    let intercepted = false;
    const gatedDb: SqliteDatabase = {
      exec(sql: string): void {
        if (sql === 'BEGIN IMMEDIATE' && !intercepted) {
          intercepted = true;
          newer = new SqliteServerStorage(storage.db).ensureSchema(
            compileSchema(INDEX_REPLACEMENT_SCHEMA),
          );
        }
        storage.db.exec(sql);
      },
      run(sql: string, bindings?: readonly SqliteValue[]): SqliteRunResult {
        return storage.db.run(sql, bindings);
      },
      query<
        Row = Record<string, SqliteValue>,
        Params extends readonly SqliteValue[] = SqliteValue[],
      >(sql: string): SqliteStatement<Row, Params> {
        return storage.db.query<Row, Params>(sql);
      },
      close(): void {
        storage.db.close();
      },
    };

    const older = new SqliteServerStorage(gatedDb).ensureSchema(
      compileSchema(SCHEMA),
    );
    await newer;
    await expect(older).rejects.toThrow(/newer than the configured schema/);

    const marker = storage.db
      .query<{ schema_version: number }, []>(
        'SELECT schema_version FROM sync_schema_meta WHERE id=1',
      )
      .get();
    expect(marker?.schema_version).toBe(2);
    const names = storage.db
      .query<{ name: string; origin: string }, []>('PRAGMA index_list("tasks")')
      .all()
      .filter((index) => index.origin === 'c')
      .map((index) => index.name);
    expect(names).toEqual(['sync_ix_tasks_by_title']);
  });

  test('a version bump replaces declared indexes on Postgres', async () => {
    const db = await PGlite.create();
    const storage = new PostgresServerStorage(pgliteExecutor(db));
    await storage.ensureSchema(compileSchema(SCHEMA));
    await storage.ensureSchema(compileSchema(INDEX_REPLACEMENT_SCHEMA));

    const indexes = await db.query<{ indexname: string; indexdef: string }>(
      "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname=current_schema() AND tablename='tasks' AND indexname <> 'tasks_pkey' ORDER BY indexname",
    );
    expect(indexes.rows).toHaveLength(1);
    expect(indexes.rows[0]?.indexname).toBe('sync_ix_tasks_by_title');
    expect(indexes.rows[0]?.indexdef).toContain(
      'UNIQUE INDEX sync_ix_tasks_by_title',
    );
    expect(indexes.rows[0]?.indexdef).toContain(
      '(_sync_partition, project_id, title)',
    );
  });

  test('same-version startup upgrades legacy declared indexes on Postgres', async () => {
    const db = await PGlite.create();
    await new PostgresServerStorage(pgliteExecutor(db)).ensureSchema(
      compileSchema(SCHEMA),
    );
    await db.query('DROP INDEX sync_ix_tasks_by_project_title');
    await db.query(
      'CREATE UNIQUE INDEX sync_ix_tasks_by_project_title ON tasks (project_id, title)',
    );

    await new PostgresServerStorage(pgliteExecutor(db)).ensureSchema(
      compileSchema(SCHEMA),
    );

    const index = await db.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE schemaname=current_schema() AND indexname='sync_ix_tasks_by_project_title'",
    );
    expect(index.rows[0]?.indexdef).toContain(
      '(_sync_partition, project_id, title)',
    );
    expect(index.rows[0]?.indexdef).toContain(
      'UNIQUE INDEX sync_ix_tasks_by_project_title',
    );
    await db.close();
  });

  test('an older Postgres repair cannot cross a newer schema bump', async () => {
    const db = await PGlite.create();
    const base = pgliteExecutor(db);
    await new PostgresServerStorage(base).ensureSchema(compileSchema(SCHEMA));
    await db.query('DROP INDEX sync_ix_tasks_by_project_title');
    await db.query(
      'CREATE UNIQUE INDEX sync_ix_tasks_by_project_title ON tasks (project_id, title)',
    );

    let announce!: () => void;
    const announced = new Promise<void>((resolve) => {
      announce = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gated: PgExecutor = {
      query<Row>(text: string, params?: readonly unknown[]) {
        return base.query<Row>(text, params);
      },
      async transaction<T>(fn: (client: PgQueryable) => Promise<T>) {
        announce();
        await released;
        return base.transaction(fn);
      },
    };

    const older = new PostgresServerStorage(gated).ensureSchema(
      compileSchema(SCHEMA),
    );
    await announced;
    await new PostgresServerStorage(base).ensureSchema(
      compileSchema(INDEX_REPLACEMENT_SCHEMA),
    );
    release();

    await expect(older).rejects.toThrow(/newer than the configured schema/);
    const marker = await db.query<{ schema_version: number }>(
      'SELECT schema_version FROM sync_schema_meta WHERE id=1',
    );
    expect(marker.rows[0]?.schema_version).toBe(2);
    const indexes = await db.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE schemaname=current_schema() AND tablename='tasks' AND indexname <> 'tasks_pkey' ORDER BY indexname",
    );
    expect(indexes.rows.map((index) => index.indexname)).toEqual([
      'sync_ix_tasks_by_title',
    ]);
    await db.close();
  });

  test('a declared UNIQUE index is unique per partition', async () => {
    // One physical table holds every partition, so an index over the declared
    // columns alone would let one tenant reserve a value for every other.
    const db = await PGlite.create();
    const storage = new PostgresServerStorage(pgliteExecutor(db));
    await storage.ensureSchema(compileSchema(INDEX_REPLACEMENT_SCHEMA));

    await upsert(
      storage,
      'tenant-a',
      'tasks',
      taskRow('t1', 'p1', 'same-title'),
    );
    await upsert(
      storage,
      'tenant-b',
      'tasks',
      taskRow('t2', 'p1', 'same-title'),
    );

    expect((await storage.getRow('tenant-a', 'tasks', 't1'))?.rowId).toBe('t1');
    expect((await storage.getRow('tenant-b', 'tasks', 't2'))?.rowId).toBe('t2');
    await db.close();
  });

  test('a version bump replaces declared indexes on D1', async () => {
    const db = new D1DatabaseDouble();
    const storage = new D1ServerStorage(db);
    await storage.ensureSchema(compileSchema(SCHEMA));
    await storage.ensureSchema(compileSchema(INDEX_REPLACEMENT_SCHEMA));

    const indexes = await db
      .prepare('PRAGMA index_list("tasks")')
      .all<{ name: string; unique: number; origin: string }>();
    expect(indexes.results.filter((index) => index.origin === 'c')).toEqual([
      expect.objectContaining({ name: 'sync_ix_tasks_by_title', unique: 1 }),
    ]);
    const columns = await db
      .prepare('PRAGMA index_info("sync_ix_tasks_by_title")')
      .all<{ name: string }>();
    expect(columns.results.map((column) => column.name)).toEqual([
      '_sync_partition',
      'project_id',
      'title',
    ]);
  });

  test('same-version startup upgrades legacy declared indexes on D1', async () => {
    const db = new D1DatabaseDouble();
    await new D1ServerStorage(db).ensureSchema(compileSchema(SCHEMA));
    await db.exec('DROP INDEX sync_ix_tasks_by_project_title');
    await db.exec(
      'CREATE UNIQUE INDEX sync_ix_tasks_by_project_title ON tasks (project_id, title)',
    );

    await new D1ServerStorage(db).ensureSchema(compileSchema(SCHEMA));

    const columns = await db
      .prepare('PRAGMA index_info("sync_ix_tasks_by_project_title")')
      .all<{ name: string }>();
    expect(columns.results.map((column) => column.name)).toEqual([
      '_sync_partition',
      'project_id',
      'title',
    ]);
    const indexes = await db
      .prepare('PRAGMA index_list("tasks")')
      .all<{ name: string; unique: number }>();
    expect(indexes.results).toContainEqual(
      expect.objectContaining({
        name: 'sync_ix_tasks_by_project_title',
        unique: 1,
      }),
    );
  });

  test('an older D1 repair cannot cross a newer schema bump', async () => {
    const db = new D1DatabaseDouble();
    await new D1ServerStorage(db).ensureSchema(compileSchema(SCHEMA));
    await db.exec('DROP INDEX sync_ix_tasks_by_project_title');
    await db.exec(
      'CREATE UNIQUE INDEX sync_ix_tasks_by_project_title ON tasks (project_id, title)',
    );

    let announce!: () => void;
    const announced = new Promise<void>((resolve) => {
      announce = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let gatedBatch = false;
    const gated: D1Database = {
      prepare(query: string): D1PreparedStatement {
        return db.prepare(query);
      },
      async batch(statements: D1PreparedStatement[]): Promise<unknown[]> {
        if (!gatedBatch) {
          gatedBatch = true;
          announce();
          await released;
        }
        return db.batch(statements);
      },
      exec(query: string): Promise<unknown> {
        return db.exec(query);
      },
    };

    const older = new D1ServerStorage(gated).ensureSchema(
      compileSchema(SCHEMA),
    );
    await announced;
    await new D1ServerStorage(db).ensureSchema(
      compileSchema(INDEX_REPLACEMENT_SCHEMA),
    );
    release();

    await expect(older).rejects.toThrow(/newer than the configured schema/);
    const marker = await db
      .prepare('SELECT schema_version FROM sync_schema_meta WHERE id=1')
      .first<{ schema_version: number }>();
    expect(marker?.schema_version).toBe(2);
    const indexes = await db
      .prepare('PRAGMA index_list("tasks")')
      .all<{ name: string; origin: string }>();
    expect(
      indexes.results
        .filter((index) => index.origin === 'c')
        .map((index) => index.name),
    ).toEqual(['sync_ix_tasks_by_title']);
  });

  test('a version bump preserves operator-added tuning indexes and migrates bare declared names', async () => {
    const storage = new SqliteServerStorage();
    await storage.ensureSchema(compileSchema(SCHEMA));
    // An operator tuning index plus a projection index still carrying its
    // bare declared name (a database created before the ownership prefix).
    storage.db.run(
      'CREATE INDEX ops_tasks_tuning ON tasks (title, project_id)',
    );
    storage.db.run('DROP INDEX sync_ix_tasks_by_title');
    storage.db.run('CREATE INDEX tasks_by_title ON tasks (title)');

    await storage.ensureSchema(compileSchema(INDEX_REPLACEMENT_SCHEMA));

    const names = storage.db
      .query<{ name: string; origin: string }, []>('PRAGMA index_list("tasks")')
      .all()
      .filter((index) => index.origin === 'c')
      .map((index) => index.name);
    expect(names).toContain('ops_tasks_tuning');
    expect(names).toContain('sync_ix_tasks_by_title');
    expect(names).not.toContain('tasks_by_title');
    expect(names).not.toContain('sync_ix_tasks_by_project_title');
  });

  test('a version bump on Postgres leaves constraint-owned and operator indexes intact', async () => {
    const db = await PGlite.create();
    const storage = new PostgresServerStorage(pgliteExecutor(db));
    await storage.ensureSchema(compileSchema(SCHEMA));
    // A UNIQUE constraint owns its backing index; DROP INDEX on it would
    // abort the whole migration transaction.
    await db.query(
      'ALTER TABLE tasks ADD CONSTRAINT tasks_ops_unique UNIQUE (_sync_partition, id)',
    );
    await db.query('CREATE INDEX ops_tasks_tuning ON tasks (title)');

    await storage.ensureSchema(compileSchema(INDEX_REPLACEMENT_SCHEMA));

    const indexes = await db.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE schemaname=current_schema() AND tablename='tasks'",
    );
    const names = indexes.rows.map((row) => row.indexname);
    expect(names).toContain('tasks_ops_unique');
    expect(names).toContain('ops_tasks_tuning');
    expect(names).toContain('sync_ix_tasks_by_title');
    expect(names).not.toContain('sync_ix_tasks_by_project_title');
  });

  test('an index name moving between tables in one bump applies cleanly', async () => {
    const v1: ServerSchema = {
      version: 1,
      tables: [
        {
          name: 'tasks',
          columns: TASK_COLUMNS,
          primaryKey: 'id',
          scopes: ['project:{project_id}'],
        },
        {
          name: 'projects',
          columns: PROJECT_COLUMNS,
          primaryKey: 'id',
          scopes: ['project:{project_id}'],
          indexes: [{ name: 'by_owner_title', columns: ['name'] }],
        },
      ],
    };
    const v2: ServerSchema = {
      version: 2,
      tables: [
        {
          name: 'tasks',
          columns: TASK_COLUMNS,
          primaryKey: 'id',
          scopes: ['project:{project_id}'],
          indexes: [{ name: 'by_owner_title', columns: ['title'] }],
        },
        {
          name: 'projects',
          columns: PROJECT_COLUMNS,
          primaryKey: 'id',
          scopes: ['project:{project_id}'],
        },
      ],
    };
    const storage = new SqliteServerStorage();
    await storage.ensureSchema(compileSchema(v1));
    await storage.ensureSchema(compileSchema(v2));

    const indexTables = storage.db
      .query<{ name: string; tbl_name: string }, []>(
        "SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND name='sync_ix_by_owner_title'",
      )
      .all();
    expect(indexTables).toEqual([
      { name: 'sync_ix_by_owner_title', tbl_name: 'tasks' },
    ]);
  });

  test('a version bump retires current rows and scope indexes for a removed table', async () => {
    const storage = new SqliteServerStorage();
    await storage.ensureSchema(compileSchema(SCHEMA));
    await upsert(storage, PARTITION, 'tasks', taskRow('t1', 'p1', 'retired'));
    await upsert(storage, PARTITION, 'projects', projectRow('p1', 'kept'));

    const v2: ServerSchema = {
      version: 2,
      tables: [SCHEMA.tables[1]!],
    };
    await storage.ensureSchema(compileSchema(v2));

    const retired = storage.db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'",
      )
      .get();
    expect(retired).toBeNull();
    const staleScopes = storage.db
      .query<{ n: number }, [string]>(
        'SELECT count(*) AS n FROM sync_row_scopes WHERE tbl=?',
      )
      .get('tasks');
    expect(staleScopes?.n).toBe(0);
    expect(await storage.getRow(PARTITION, 'projects', 'p1')).toBeDefined();
  });

  test('postgres retires the relational current-row table atomically', async () => {
    const db = await PGlite.create();
    const storage = new PostgresServerStorage(pgliteExecutor(db));
    await storage.ensureSchema(compileSchema(SCHEMA));
    await upsert(storage, PARTITION, 'tasks', taskRow('t1', 'p1', 'retired'));
    await storage.ensureSchema(
      compileSchema({ version: 2, tables: [SCHEMA.tables[1]!] }),
    );

    const table = await db.query<{ name: string | null }>(
      "SELECT to_regclass('tasks')::text AS name",
    );
    expect(table.rows[0]?.name).toBeNull();
    const scopes = await db.query<{ n: number | string }>(
      "SELECT count(*) AS n FROM sync_row_scopes WHERE tbl='tasks'",
    );
    expect(Number(scopes.rows[0]?.n)).toBe(0);
  });

  test('D1 retires the relational current-row table idempotently', async () => {
    const db = new D1DatabaseDouble();
    const storage = new D1ServerStorage(db);
    await storage.ensureSchema(compileSchema(SCHEMA));
    const tx = await storage.begin(PARTITION);
    await tx.upsertRow('tasks', taskRow('t1', 'p1', 'retired'));
    await tx.commit();
    await storage.ensureSchema(
      compileSchema({ version: 2, tables: [SCHEMA.tables[1]!] }),
    );

    const table = await db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'",
      )
      .first<{ name: string }>();
    expect(table).toBeNull();
    const scopes = await db
      .prepare('SELECT count(*) AS n FROM sync_row_scopes WHERE tbl=?')
      .bind('tasks')
      .first<{ n: number }>();
    expect(scopes?.n).toBe(0);
  });

  test('an older server refuses a newer database', async () => {
    const storage = new SqliteServerStorage();
    await storage.ensureSchema(
      compileSchema({ ...SCHEMA, version: 5 } as ServerSchema),
    );
    const older = new SqliteServerStorage(storage.db);
    await expect(older.ensureSchema(compileSchema(SCHEMA))).rejects.toThrow(
      /newer than the configured schema/,
    );
  });

  test('a version bump outside the migration subset fails loud', async () => {
    const storage = new SqliteServerStorage();
    await storage.ensureSchema(compileSchema(SCHEMA));
    // Retype a column — not append-only.
    const retyped: ServerSchema = {
      version: 2,
      tables: [
        {
          name: 'tasks',
          columns: TASK_COLUMNS.map((c) =>
            c.name === 'priority' ? { ...c, type: 'string' as const } : c,
          ),
          primaryKey: 'id',
          scopes: ['project:{project_id}'],
        },
        ...SCHEMA.tables.slice(1),
      ],
    };
    await expect(storage.ensureSchema(compileSchema(retyped))).rejects.toThrow(
      /only appending nullable columns/,
    );
    // Append a NON-nullable column — nothing to backfill.
    const nonNullable: ServerSchema = {
      version: 2,
      tables: [
        {
          name: 'tasks',
          columns: [
            ...TASK_COLUMNS,
            { name: 'required_new', type: 'string', nullable: false },
          ],
          primaryKey: 'id',
          scopes: ['project:{project_id}'],
        },
        ...SCHEMA.tables.slice(1),
      ],
    };
    const fresh = new SqliteServerStorage();
    await fresh.ensureSchema(compileSchema(SCHEMA));
    await expect(
      fresh.ensureSchema(compileSchema(nonNullable)),
    ).rejects.toThrow(/must be nullable/);
  });
});

// --- optional materialization -------------------------------------------------

describe('optional materialization', () => {
  const bareSchema = (
    materialize: boolean | undefined,
    version = 1,
  ): ServerSchema => ({
    version,
    tables: [
      {
        name: 'tasks',
        columns: TASK_COLUMNS,
        primaryKey: 'id',
        scopes: ['project:{project_id}'],
        indexes: [{ name: 'tasks_by_title', columns: ['title'] }],
        ...(materialize !== undefined ? { materialize } : {}),
      },
    ],
  });

  test('materialize: false stores only the meta columns; sync still round-trips', async () => {
    const storage = new SqliteServerStorage();
    await storage.ensureSchema(compileSchema(bareSchema(false)));
    const columns = storage.db
      .query<{ name: string }, []>('PRAGMA table_info("tasks")')
      .all()
      .map((c) => c.name);
    expect(columns).toEqual([
      '_sync_partition',
      '_sync_row_id',
      '_sync_server_version',
      '_sync_scopes',
      '_sync_payload',
    ]);
    // User indexes are skipped (their columns do not exist).
    const indexes = storage.db
      .query<{ name: string }, [string]>(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=?",
      )
      .all('tasks')
      .map((i) => i.name);
    expect(indexes).not.toContain('sync_ix_tasks_by_title');
    // The sync path is unaffected: byte-verbatim round-trip, scope scan.
    const row = taskRow('t1', 'p1', 'no projection', {
      thumb: new Uint8Array([7]),
    });
    await upsert(storage, PARTITION, 'tasks', row);
    const stored = await storage.getRow(PARTITION, 'tasks', 't1');
    expect(stored?.payload).toEqual(row.payload);
    const scan = await storage.scanRows(PARTITION, {
      table: 'tasks',
      scopeFilter: { project_id: ['p1'] },
      afterRowId: null,
      limit: 10,
    });
    expect(scan.map((r) => r.rowId)).toEqual(['t1']);
  });

  test('fully-encrypted tables default to materialize: false; explicit true wins', () => {
    const encrypted: ServerSchema = {
      version: 1,
      tables: [
        {
          name: 'notes',
          columns: [
            { name: 'id', type: 'string', nullable: false },
            { name: 'space_id', type: 'string', nullable: false },
            {
              name: 'body',
              type: 'bytes',
              nullable: true,
              encrypted: true,
              declaredType: 'string',
            },
            {
              name: 'attrs',
              type: 'bytes',
              nullable: true,
              encrypted: true,
              declaredType: 'json',
            },
          ],
          primaryKey: 'id',
          scopes: ['space:{space_id}'],
        },
      ],
    };
    expect(compileSchema(encrypted).tables.get('notes')?.materialize).toBe(
      false,
    );
    const forced: ServerSchema = {
      ...encrypted,
      tables: [{ ...encrypted.tables[0]!, materialize: true }],
    };
    expect(compileSchema(forced).tables.get('notes')?.materialize).toBe(true);
    // A mixed table (any plaintext non-PK/non-scope column) defaults ON.
    expect(compileSchema(SCHEMA).tables.get('tasks')?.materialize).toBe(true);
  });

  test('flipping materialization ON backfills the projection from payloads', async () => {
    const storage = new SqliteServerStorage();
    await storage.ensureSchema(compileSchema(bareSchema(false)));
    await upsert(
      storage,
      PARTITION,
      'tasks',
      taskRow('t1', 'p1', 'was opaque', { completed: true, priority: 9 }),
    );
    await upsert(storage, 'part-b', 'tasks', taskRow('t2', 'pX', 'other part'));

    // v2 flips materialization on (any change requires a version bump).
    await storage.ensureSchema(compileSchema(bareSchema(true, 2)));

    const rows = storage.db
      .query<
        { title: string; completed: number; priority: number | null },
        [string]
      >(
        'SELECT title, completed, priority FROM tasks WHERE project_id = ? ORDER BY id',
      )
      .all('p1');
    expect(rows).toEqual([{ title: 'was opaque', completed: 1, priority: 9 }]);
    // Backfill covered every partition.
    const other = storage.db
      .query<{ title: string }, [string]>(
        'SELECT title FROM tasks WHERE _sync_partition = ?',
      )
      .all('part-b');
    expect(other).toEqual([{ title: 'other part' }]);
    // User indexes materialize with the projection.
    const indexes = storage.db
      .query<{ name: string }, [string]>(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=?",
      )
      .all('tasks')
      .map((i) => i.name);
    expect(indexes).toContain('sync_ix_tasks_by_title');
  });

  test('postgres: bump migrates payloads and backfills a flipped-on projection', async () => {
    const db = await PGlite.create();
    const storage = new PostgresServerStorage(pgliteExecutor(db));
    await storage.ensureSchema(compileSchema(bareSchema(false)));
    await upsert(
      storage,
      PARTITION,
      'tasks',
      taskRow('t1', 'p1', 'pg opaque', { priority: 3 }),
    );

    // v2: materialize on AND a new column — exercises backfill + payload
    // migration together on the postgres rewrite path.
    const v2: ServerSchema = {
      version: 2,
      tables: [
        {
          name: 'tasks',
          columns: [
            ...TASK_COLUMNS,
            { name: 'assignee', type: 'string', nullable: true },
          ],
          primaryKey: 'id',
          scopes: ['project:{project_id}'],
          materialize: true,
        },
      ],
    };
    await storage.ensureSchema(compileSchema(v2));

    const rows = await db.query<{ title: string; priority: string | number }>(
      `SELECT title, priority FROM tasks WHERE project_id = 'p1'`,
    );
    expect(
      rows.rows.map((r) => ({ ...r, priority: Number(r.priority) })),
    ).toEqual([{ title: 'pg opaque', priority: 3 }]);
    const stored = await storage.getRow(PARTITION, 'tasks', 't1');
    const decoded = decodeRow(v2.tables[0]!.columns, stored!.payload);
    expect(decoded[2]).toBe('pg opaque');
    expect(decoded[decoded.length - 1]).toBeNull();
  });

  test('a too-wide D1 table is fine when not materialized', async () => {
    const wide: ServerSchema = {
      version: 1,
      tables: [
        {
          name: 'wide',
          columns: [
            { name: 'id', type: 'string', nullable: false },
            ...Array.from({ length: 120 }, (_, i) => ({
              name: `c${i}`,
              type: 'string' as const,
              nullable: true,
            })),
          ],
          primaryKey: 'id',
          scopes: ['row:{id}'],
          materialize: false,
        },
      ],
    };
    const storage = new D1ServerStorage(new D1DatabaseDouble());
    await storage.ensureSchema(compileSchema(wide));
    const tx = await storage.begin(PARTITION);
    await tx.upsertRow('wide', {
      rowId: 'r1',
      serverVersion: 1,
      scopes: { id: 'r1' },
      payload: encodeRow(wide.tables[0]!.columns, [
        'r1',
        ...Array.from({ length: 120 }, () => null),
      ]),
    });
    await tx.commit();
    const stored = await storage.getRow(PARTITION, 'wide', 'r1');
    expect(stored?.serverVersion).toBe(1);
  });
});

// --- 6. identifier rules at schema compile ----------------------------------

describe('invalid identifiers and indexes are rejected at schema compile', () => {
  const table = (overrides: Record<string, unknown>) =>
    compileSchema({
      version: 1,
      tables: [
        {
          name: 'ok',
          columns: [{ name: 'id', type: 'string', nullable: false }],
          primaryKey: 'id',
          scopes: ['ok:{id}'],
          ...overrides,
        } as never,
      ],
    });

  test('sync_-prefixed table name', () => {
    expect(() => table({ name: 'sync_changes' })).toThrow(/reserved prefix/);
  });

  test('_sync-prefixed column name', () => {
    expect(() =>
      table({
        columns: [
          { name: 'id', type: 'string', nullable: false },
          { name: '_sync_payload', type: 'string', nullable: true },
        ],
      }),
    ).toThrow(/reserved prefix/);
  });

  test('identifier over 63 bytes', () => {
    expect(() => table({ name: 'x'.repeat(64) })).toThrow(/63 bytes/);
  });

  test('identifier limit is UTF-8-byte exact for user indexes', () => {
    expect(() =>
      table({ indexes: [{ name: 'i'.repeat(63), columns: ['id'] }] }),
    ).not.toThrow();
    expect(() =>
      table({ indexes: [{ name: 'ü'.repeat(32), columns: ['id'] }] }),
    ).toThrow(
      'exceeds 63 bytes (Postgres identifier limit; actual UTF-8 length: 64 bytes)',
    );
  });

  test('index naming an unknown column', () => {
    expect(() =>
      table({ indexes: [{ name: 'bad_idx', columns: ['missing'] }] }),
    ).toThrow(/unknown column/);
  });

  test('index naming no columns', () => {
    expect(() =>
      table({ indexes: [{ name: 'empty_idx', columns: [] }] }),
    ).toThrow('table ok: index "empty_idx" must name at least one column');
  });
});

// --- DDL goldens -------------------------------------------------------------

describe('IR→DDL', () => {
  test('physical index names carry the ownership prefix within the identifier limit', () => {
    expect(physicalIndexName('tasks_by_title')).toBe('sync_ix_tasks_by_title');
    const long = 'i'.repeat(63);
    const physical = physicalIndexName(long);
    expect(physical.startsWith('sync_ix_')).toBe(true);
    expect(new TextEncoder().encode(physical).length).toBeLessThanOrEqual(63);
    // Deterministic: the same declared name always maps to one physical name.
    expect(physicalIndexName(long)).toBe(physical);
  });

  test('sqlite and postgres affinities', () => {
    const compiled = compileSchema(SCHEMA).tables.get('tasks');
    if (compiled === undefined) throw new Error('missing table');
    const sqlite = createTableDdl(compiled, 'sqlite');
    expect(sqlite).toContain('"completed" INTEGER NOT NULL');
    expect(sqlite).toContain('"meta" TEXT');
    expect(sqlite).toContain('"thumb" BLOB');
    expect(sqlite).toContain('PRIMARY KEY ("_sync_partition", "_sync_row_id")');
    const postgres = createTableDdl(compiled, 'postgres');
    expect(postgres).toContain('"completed" BOOLEAN NOT NULL');
    expect(postgres).toContain('"meta" JSONB');
    expect(postgres).toContain('"thumb" BYTEA');
    expect(postgres).toContain('"priority" BIGINT');
    expect(postgres).toContain('"score" DOUBLE PRECISION');
    expect(postgres).toContain('"_sync_payload" BYTEA NOT NULL');
  });
});

// --- the scope-value bind of the two page queries ----------------------------

describe('scope-value binds', () => {
  function tasks() {
    const compiled = compileSchema(SCHEMA).tables.get('tasks');
    if (compiled === undefined) throw new Error('missing table');
    return compiled;
  }

  test('postgres binds one value as a scalar and unnests more', () => {
    const one = scanRowPageSql(tasks(), 1, 'postgres');
    const many = scanRowPageSql(tasks(), 3, 'postgres');

    expect(one).toContain('value=$4');
    expect(one).not.toContain('unnest');

    // The array is expanded into one bounded index range per value rather
    // than put on `value` as an array qual, which is what keeps the scan off
    // the ordering column. These fragments pin the exact SQL contract used
    // by both commit-window and row-page scans.
    expect(many).toContain('unnest($4::text[]) AS v(value)');
    expect(many).toContain('CROSS JOIN LATERAL');
    expect(many).toContain('value=v.value');
    expect(many).not.toContain('value=ANY');

    // The placeholder numbers do not move with the value count, which is
    // what takes the 65,535 bind-parameter ceiling off the query.
    expect(one).toContain('row_id>$5');
    expect(many).toContain('row_id>$5');

    // Each lateral arm is bounded by the page limit, so the sort above it
    // sees `values * limit` rows instead of the whole scope extent.
    expect(many.split('LIMIT $6')).toHaveLength(3);

    expect(commitWindowPageSql(1, 'postgres')).toContain('value=$4');
    expect(commitWindowPageSql(1, 'postgres')).not.toContain('unnest');

    const windowMany = commitWindowPageSql(9, 'postgres');
    expect(windowMany).toContain('unnest($4::text[]) AS v(value)');
    expect(windowMany).toContain('value=v.value');
    expect(windowMany).not.toContain('value=ANY');
    expect(windowMany).toContain('commit_seq>$5');
    expect(windowMany.split('LIMIT $7')).toHaveLength(3);

    expect(postgresScopeValueParam(['l1'])).toEqual(['l1']);
    expect(postgresScopeValueParam(['l1', 'l2'])).toEqual([['l1', 'l2']]);
  });

  test('sqlite keeps one placeholder per scope value', () => {
    // SQLite has no array type and D1 shares this builder. The ceiling there
    // is a separate, lower one that this shape does not address.
    expect(scanRowPageSql(tasks(), 3, 'sqlite')).toContain('value IN (?,?,?)');
    expect(commitWindowPageSql(3, 'sqlite')).toContain('value IN (?,?,?)');
  });

  test('scope values survive the array bind verbatim', async () => {
    // A comma, a brace, a double quote, a backslash and a NULL-looking word
    // are what an array literal has to escape.
    const awkward = ['a,b', '{c}', 'd"e', 'f\\g', 'NULL'];
    const db = await PGlite.create();
    const storage = new PostgresServerStorage(pgliteExecutor(db));
    await storage.ensureSchema(compileSchema(SCHEMA));
    for (const [index, project] of awkward.entries()) {
      await upsert(
        storage,
        PARTITION,
        'tasks',
        taskRow(`t${index}`, project, 'title'),
      );
    }

    const rows = await storage.scanRows(PARTITION, {
      table: 'tasks',
      scopeFilter: { project_id: awkward },
      afterRowId: null,
      limit: 10,
    });

    expect(rows.map((row) => row.scopes.project_id).sort()).toEqual(
      [...awkward].sort(),
    );
    await db.close();
  });
});

// --- D1 bind-parameter cap ---------------------------------------------------

describe('D1 bind-parameter cap', () => {
  test('a table too wide for one D1 upsert fails fast at ensureSchema', async () => {
    const wide: ServerSchema = {
      version: 1,
      tables: [
        {
          name: 'wide',
          columns: [
            { name: 'id', type: 'string', nullable: false },
            ...Array.from({ length: 96 }, (_, i) => ({
              name: `c${i}`,
              type: 'string' as const,
              nullable: true,
            })),
          ],
          primaryKey: 'id',
          scopes: ['row:{id}'],
        },
      ],
    };
    const storage = new D1ServerStorage(new D1DatabaseDouble());
    await expect(storage.ensureSchema(compileSchema(wide))).rejects.toThrow(
      /caps statements at 100/,
    );
  });
});
