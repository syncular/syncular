import { join } from 'node:path';
import { generate, scanTableRefs } from '../../typegen/src';
import { describe, expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { encodeRow, type RowColumn } from '@syncular/core';
import {
  bindAuthoritativePartition,
  compileSchema,
  D1ServerStorage,
  MemorySegmentStore,
  registerRemoteQuery,
  PostgresServerStorage,
  postgresPlaceholders,
  prepareAuthoritativeQuery,
  type ServerSchema,
  type ServerStorage,
  SqliteServerStorage,
} from '@syncular/server';
import { pgliteExecutor } from '@syncular/server/pglite';
import {
  searchTasksQuery,
  taskTitlesQuery,
} from '../../typegen/test/fixtures/basic/syncular.queries';
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

const IR = generate(
  join(import.meta.dir, '../../typegen/test/fixtures/basic'),
).ir;

function relationPlan(sql: string) {
  return {
    sql,
    relations: scanTableRefs(sql, IR).map((ref) => ({
      table: ref.table,
      start: ref.start,
      end: ref.end,
      ...(ref.explicitAlias === undefined ? {} : { alias: ref.explicitAlias }),
    })),
  };
}

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
  test('rejects stale and inconsistent metadata during registration', () => {
    const options = {
      maxRows: 10,
      auth: { access: 'privileged', authorize: () => true },
    } as const;
    const legacy = { ...taskTitlesQuery };
    Reflect.deleteProperty(legacy, 'relationPlans');
    expect(() => registerRemoteQuery(legacy, options)).toThrow(
      'regenerate queries',
    );
    for (const plan of [
      { sql: 'SELECT id FROM tasks', relations: [] },
      { sql: taskTitlesQuery.sql, relations: [] },
      {
        sql: taskTitlesQuery.sql,
        relations: [{ table: 'tasks', start: 0, end: 5 }],
      },
      {
        sql: taskTitlesQuery.sql,
        relations: [{ table: 'tasks', start: -1, end: 27 }],
      },
    ]) {
      expect(() =>
        registerRemoteQuery(
          { ...taskTitlesQuery, relationPlans: [plan] },
          options,
        ),
      ).toThrow();
    }
  });

  test('selects a matching generated plan for every sort variant', () => {
    const schema = compileSchema({
      version: IR.schemaVersion,
      tables: IR.tables.map((table) => ({
        name: table.name,
        columns: table.columns,
        primaryKey: table.primaryKey,
        scopes: table.scopes.map((scope) => ({
          pattern: scope.pattern,
          column: scope.column,
        })),
      })),
    });
    for (const sortBy of [
      'priorityAsc',
      'priorityDesc',
      'estimatedAtAsc',
      'estimatedAtDesc',
      'titleAsc',
      'titleDesc',
    ] as const) {
      const params = { projectId: 'p1', sortBy };
      const sql = searchTasksQuery.sqlFor?.(params);
      const plan = searchTasksQuery.relationPlans.find(
        (plan) => plan.sql === sql,
      );
      if (plan === undefined) throw new Error('missing generated plan');
      const prepared = bindAuthoritativePartition(
        prepareAuthoritativeQuery(
          plan,
          searchTasksQuery.bind(params),
          searchTasksQuery.tables,
          schema.tables,
        ),
        'part-1',
      );
      expect(prepared.params).toEqual([
        'part-1',
        ...searchTasksQuery.bind(params),
      ]);
    }
  });

  test('rejects a selected SQL variant with no plan before invoking storage', async () => {
    const storage = new SqliteServerStorage();
    let calls = 0;
    storage.queryAuthoritative = async () => {
      calls += 1;
      return { rows: [], maxCommitSeq: 0 };
    };
    const operation = registerRemoteQuery(
      { ...taskTitlesQuery, sqlFor: () => 'SELECT title FROM tasks' },
      {
        maxRows: 10,
        auth: { access: 'privileged', authorize: () => true },
      },
    );
    await expect(
      operation.run(
        {
          schema: SCHEMA,
          storage,
          segments: new MemorySegmentStore(),
          partition: 'part-1',
          actorId: 'reader',
          resolveScopes: () => ({}),
        },
        'reader-client',
        undefined,
      ),
    ).rejects.toMatchObject({ code: 'operation.invalid_request' });
    expect(calls).toBe(0);
    storage.db.close();
  });

  test('keeps literals and expands numbered binds deterministically', () => {
    const schema = compileSchema(SCHEMA);
    const prepared = bindAuthoritativePartition(
      prepareAuthoritativeQuery(
        relationPlan(
          "SELECT '?; FROM tasks' AS marker, id FROM tasks /* ? FROM tasks */ WHERE project_id=?1 OR project_id=?1 -- ?\n",
        ),
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
        plan: relationPlan(
          'SELECT id, title FROM tasks WHERE project_id=? ORDER BY id',
        ),
        params: ['p1'],
        tables: ['tasks'],
      });

      expect(result).toEqual({
        rows: [{ id: 'task-1', title: 'one' }],
        maxCommitSeq: 1,
      });
      for (const sql of [
        "SELECT a.title FROM tasks a JOIN (WITH tasks AS (SELECT 'one' AS title) SELECT title FROM tasks) AS scoped_name ON scoped_name.title=a.title",
        'SELECT b.title FROM tasks a JOIN "tasks" b ON a.id=b.id',
        'SELECT b.title FROM "tasks" a JOIN tasks AS b ON a.id=b.id',
        'WITH visible AS (SELECT title FROM "tasks") SELECT title FROM visible',
        'SELECT title FROM (SELECT title FROM "tasks") AS nested',
        'SELECT b.title FROM (tasks AS a JOIN "tasks" AS b ON a.id=b.id)',
      ]) {
        const plan = relationPlan(sql);
        expect(
          await storage.queryAuthoritative?.('part-1', {
            plan,
            params: [],
            tables: ['tasks'],
          }),
        ).toEqual({ rows: [{ title: 'one' }], maxCommitSeq: 1 });
        const operation = registerRemoteQuery(
          {
            id: 'partition-isolation',
            hasParams: false,
            sql,
            tables: ['tasks'],
            relationPlans: [plan],
            resultColumns: [{ name: 'title', type: 'string', nullable: false }],
            bind: () => [],
            dependencies: () => [{ table: 'tasks' }],
            coverage: () => [],
          },
          {
            maxRows: 10,
            auth: { access: 'privileged', authorize: () => true },
          },
        );
        expect(
          await operation.run(
            {
              schema: SCHEMA,
              storage,
              segments: new MemorySegmentStore(),
              partition: 'part-1',
              actorId: 'reader',
              resolveScopes: () => ({}),
            },
            'reader-client',
            undefined,
          ),
        ).toMatchObject({
          kind: 'query',
          rows: [{ title: 'one' }],
          maxCommitSeq: 1,
        });
      }
      if (storage instanceof SqliteServerStorage) storage.db.close();
      else await db?.close();
    });
  }
});
