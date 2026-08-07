import { describe, expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { encodeRow, type RowColumn } from '@syncular/core';
import {
  bindAuthoritativePartition,
  compileSchema,
  D1ServerStorage,
  PostgresServerStorage,
  postgresPlaceholders,
  prepareAuthoritativeQuery,
  type ServerSchema,
  type ServerStorage,
  SqliteServerStorage,
} from '@syncular/server';
import { pgliteExecutor } from '@syncular/server/pglite';
import { D1DatabaseDouble } from './d1-double';

const COLUMNS: readonly RowColumn[] = [
  { name: 'id', type: 'string', nullable: false },
  { name: 'project_id', type: 'string', nullable: false },
  { name: 'title', type: 'string', nullable: false },
];
const SCHEMA: ServerSchema = {
  version: 1,
  tables: [
    {
      name: 'tasks',
      columns: COLUMNS,
      primaryKey: 'id',
      scopes: ['project:{project_id}'],
    },
  ],
};

async function seed(storage: ServerStorage, partition: string, title: string) {
  const tx = await storage.begin(partition);
  await tx.upsertRow('tasks', {
    rowId: 'task-1',
    serverVersion: 1,
    scopes: { project_id: 'p1' },
    payload: encodeRow(COLUMNS, ['task-1', 'p1', title]),
  });
  await tx.appendCommit({
    clientId: 'seed',
    clientCommitId: `seed-${partition}`,
    actorId: 'seed',
    createdAtMs: 1,
    changes: [],
  });
  await tx.commit();
}

describe('authoritative query partition rewriting', () => {
  test('keeps literals and expands numbered binds deterministically', () => {
    const schema = compileSchema(SCHEMA);
    const prepared = bindAuthoritativePartition(
      prepareAuthoritativeQuery(
        "SELECT '?; FROM tasks' AS marker, id FROM tasks /* ? FROM tasks */ WHERE project_id=?1 OR project_id=?1 -- ?\n",
        ['p1'],
        ['tasks'],
        schema.tables,
      ),
      'part-1',
    );

    expect(prepared.sql).toContain(
      'FROM (SELECT "id", "project_id", "title" FROM "tasks" WHERE "_sync_partition"=?) AS "tasks"',
    );
    expect(prepared.sql).toContain("SELECT '?; FROM tasks' AS marker");
    expect(prepared.params).toEqual(['part-1', 'p1', 'p1']);
    expect(
      postgresPlaceholders(
        'SELECT \'?\' AS marker, "?" AS quoted, ? AS value /* ? */ -- ?\n',
      ),
    ).toBe('SELECT \'?\' AS marker, "?" AS quoted, $1 AS value /* ? */ -- ?\n');
  });

  for (const backend of ['SQLite', 'Postgres', 'D1'] as const) {
    test(`${backend} returns one partition and its snapshot cursor`, async () => {
      const db = backend === 'Postgres' ? await PGlite.create() : undefined;
      const storage =
        backend === 'SQLite'
          ? new SqliteServerStorage()
          : backend === 'D1'
            ? new D1ServerStorage(new D1DatabaseDouble(), {
                pushApplySerialized: true,
              })
            : new PostgresServerStorage(pgliteExecutor(db as PGlite));
      await storage.ensureSchema(compileSchema(SCHEMA));
      await seed(storage, 'part-1', 'one');
      await seed(storage, 'part-2', 'two');

      const result = await storage.queryAuthoritative?.('part-1', {
        sql: 'SELECT id, title FROM tasks WHERE project_id=? ORDER BY id',
        params: ['p1'],
        tables: ['tasks'],
      });

      expect(result).toEqual({
        rows: [{ id: 'task-1', title: 'one' }],
        maxCommitSeq: 1,
      });
      if (storage instanceof SqliteServerStorage) storage.db.close();
      else await db?.close();
    });
  }
});
