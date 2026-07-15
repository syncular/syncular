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
  compileClientSchema,
  dropAndRecreateSyncedTables,
  ensureLocalSchema,
} from '@syncular/client';
import { BunClientDatabase } from '@syncular/client/bun';
import { applySqliteSegment, upsertLocalRow } from '../src/apply';

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

  test('sqlite-image primary-key upserts preserve rows on a secondary unique collision', () => {
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
      applySqliteSegment(
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
        { clearFirst: false, effective: { project_id: ['p1'] } },
      ),
    ).toBe(1);
    upsertLocalRow(db, table, ['t2', 'p1', 'original'], 1);

    expect(() =>
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
        { clearFirst: false, effective: { project_id: ['p1'] } },
      ),
    ).toThrow();
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
      dropAndRecreateSyncedTables(db, compiled);
    });
    expect(indexNames(db)).toEqual([
      'idx_tasks_project',
      'idx_tasks_project_title',
    ]);
    expect(indexSql(db, 'idx_tasks_project_title')).toMatch(/UNIQUE/);
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
