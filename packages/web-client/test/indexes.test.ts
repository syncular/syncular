/**
 * Local secondary indexes (the CREATE INDEX migration subset). The generated
 * client schema carries `indexes` per table; `ensureLocalSchema` must
 * materialize them as real SQLite indexes, and the §7.4.3 schema-bump reset
 * (drop-and-recreate) must recreate them. The server-side counterpart —
 * the same declared indexes created on the relational per-app row tables —
 * is covered by packages/server/test/relational-rows.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import {
  type ClientSchema,
  compileClientSchema,
  dropAndRecreateSyncedTables,
  ensureLocalSchema,
} from '@syncular/client';
import { BunClientDatabase } from '@syncular/client/bun';

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
