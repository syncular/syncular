/**
 * Relational server storage (DESIGN-relational-server-storage.md).
 *
 * What the generic blob store could never offer — and what these tests pin:
 *   1. the server database holds REAL app tables (`SELECT title FROM tasks`
 *      works, a join across two app tables works);
 *   2. the same app PK in two partitions coexists (partition is in the PK);
 *   3. `json` columns are queryable JSONB on Postgres;
 *   4. the serve path is byte-verbatim (`_sync_payload` round-trips), with
 *      the row-codec round-trip invariant asserted per column type;
 *   5. schema version bumps apply the migration subset (ADD COLUMN /
 *      CREATE INDEX) and the version marker gates re-runs;
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
  compileSchema,
  createTableDdl,
  D1ServerStorage,
  PostgresServerStorage,
  type ServerSchema,
  SqliteServerStorage,
  type StoredRow,
} from '@syncular/server';
import { pgliteExecutor } from '@syncular/server/pglite';
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
      indexes: [{ name: 'tasks_by_title', columns: ['title'] }],
    },
    {
      name: 'projects',
      columns: PROJECT_COLUMNS,
      primaryKey: 'id',
      scopes: ['project:{project_id}'],
    },
  ],
};

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
  storage: SqliteServerStorage | PostgresServerStorage,
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
    ['float', [{ name: 'c', type: 'float', nullable: false }], [3.14159]],
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

  test('user-declared indexes are created server-side', async () => {
    const storage = await sqliteStorage();
    const indexes = storage.db
      .query<{ name: string }, [string]>(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=?",
      )
      .all('tasks');
    expect(indexes.map((i) => i.name)).toContain('tasks_by_title');
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
          indexes: [
            { name: 'tasks_by_title', columns: ['title'] },
            { name: 'tasks_by_assignee', columns: ['assignee'] },
          ],
        },
        ...SCHEMA.tables.slice(1),
      ],
    };
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
    expect(indexes).toContain('tasks_by_assignee');
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
});

// --- 6. identifier rules at schema compile ----------------------------------

describe('reserved identifiers are rejected at schema compile', () => {
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

  test('index naming an unknown column', () => {
    expect(() =>
      table({ indexes: [{ name: 'bad_idx', columns: ['missing'] }] }),
    ).toThrow(/unknown column/);
  });
});

// --- DDL goldens -------------------------------------------------------------

describe('IR→DDL', () => {
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

// --- D1 bind-parameter cap ---------------------------------------------------

describe('D1 bind-parameter cap (DESIGN "D1 bind-parameter limit")', () => {
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
