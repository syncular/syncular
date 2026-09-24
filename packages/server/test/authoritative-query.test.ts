import { join } from 'node:path';
import { generate, scanTableRefs } from '../../typegen/src';
import { describe, expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import {
  decodeMessage,
  encodeMessage,
  encodeRow,
  encodeSparseRow,
  PROTOCOL_WIRE_VERSION,
  type PushOperation,
  type PushResultFrame,
  type RowColumn,
} from '@syncular/core';
import {
  bindAuthoritativePartition,
  type CommitValidator,
  compileSchema,
  D1ServerStorage,
  handleSyncRequest,
  MemorySegmentStore,
  registerRemoteCommand,
  registerRemoteQuery,
  PostgresServerStorage,
  postgresPlaceholders,
  prepareAuthoritativeQuery,
  type ServerSchema,
  type ServerStorage,
  SqliteServerStorage,
  ValidationRejection,
  type ValidatorRegistry,
} from '@syncular/server';
import { pgliteExecutor } from '@syncular/server/pglite';
import { BunSqliteDatabase } from '@syncular/server/sqlite';
import {
  docsInProjectQuery,
  projectDocCountQuery,
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

  test('a generated camelCase alias keeps its key on Postgres and SQLite', async () => {
    // `projectDocCount` is generated (camel naming) as
    // `project_id AS "projectId", count(*) AS "docCount"`. Postgres folds an
    // unquoted alias to lower case, so an unquoted emission returns
    // `projectid`/`doccount` there while SQLite returns the camel keys.
    const columns: readonly RowColumn[] = [
      { name: 'id', type: 'string', nullable: false },
      { name: 'project_id', type: 'string', nullable: false },
    ];
    const schema: ServerSchema = {
      version: 1,
      tables: [
        {
          name: 'docs',
          columns,
          primaryKey: 'id',
          scopes: ['project:{project_id}'],
        },
      ],
    };
    for (const backend of ['SQLite', 'Postgres'] as const) {
      const db = backend === 'Postgres' ? await PGlite.create() : undefined;
      const storage =
        backend === 'SQLite'
          ? new SqliteServerStorage()
          : new PostgresServerStorage(pgliteExecutor(db as PGlite));
      await storage.ensureSchema(compileSchema(schema));
      const tx = await storage.begin('part-1');
      await tx.upsertRow('docs', {
        rowId: 'doc-1',
        serverVersion: 1,
        scopes: { project_id: 'p1' },
        payload: encodeRow(columns, ['doc-1', 'p1']),
      });
      await tx.commit();

      const plan = projectDocCountQuery.relationPlans[0];
      if (plan === undefined) throw new Error('missing generated plan');
      const result = await storage.queryAuthoritative?.('part-1', {
        plan,
        params: [],
        tables: projectDocCountQuery.tables,
      });
      expect({ backend, keys: Object.keys(result?.rows[0] ?? {}) }).toEqual({
        backend,
        keys: ['projectId', 'docCount'],
      });
      expect(result?.rows).toEqual([{ projectId: 'p1', docCount: 1 }]);

      if (storage instanceof SqliteServerStorage) storage.db.close();
      else await db?.close();
    }
  });
});

describe('RFC 0007 gate on the registered-query path', () => {
  const SCHEMA_V2 = compileSchema({ ...SCHEMA, version: 2 });
  const NOW = 1_750_000_000_000;

  async function registeredQuery(storage: ServerStorage) {
    await storage.ensureSchema(compileSchema(SCHEMA));
    await seed(storage, 'part-1', 'one');
    return registerRemoteQuery(
      {
        id: 'rfc0007-gate',
        hasParams: false,
        sql: 'SELECT id, title FROM tasks ORDER BY id',
        tables: ['tasks'],
        relationPlans: [
          relationPlan('SELECT id, title FROM tasks ORDER BY id'),
        ],
        resultColumns: [
          { name: 'id', type: 'string', nullable: false },
          { name: 'title', type: 'string', nullable: false },
        ],
        bind: () => [],
        dependencies: () => [{ table: 'tasks' }],
        coverage: () => [],
      },
      {
        maxRows: 10,
        auth: { access: 'privileged', authorize: () => true },
      },
    );
  }

  function context(
    storage: ServerStorage,
    checkpoints?: readonly {
      partition: string;
      name: string;
      schemaVersion: number;
    }[],
  ) {
    return {
      schema: SCHEMA,
      storage,
      segments: new MemorySegmentStore(),
      partition: 'part-1',
      actorId: 'reader',
      resolveScopes: () => ({}),
      ...(checkpoints !== undefined ? { checkpoints } : {}),
    };
  }

  for (const backend of ['SQLite', 'Postgres'] as const) {
    test(`${backend}: a migration past the running build refuses the query inside the pinned snapshot`, async () => {
      const db = backend === 'Postgres' ? await PGlite.create() : undefined;
      const shared = backend === 'SQLite' ? new BunSqliteDatabase() : undefined;
      const storage =
        backend === 'SQLite'
          ? new SqliteServerStorage(shared as BunSqliteDatabase)
          : new PostgresServerStorage(pgliteExecutor(db as PGlite));
      const operation = await registeredQuery(storage);
      // A second process migrates the shared database past the running build.
      const other =
        backend === 'SQLite'
          ? new SqliteServerStorage(shared as BunSqliteDatabase)
          : new PostgresServerStorage(pgliteExecutor(db as PGlite));
      await other.ensureSchema(SCHEMA_V2);
      await expect(
        operation.run(context(storage) as never, 'reader', undefined as never),
      ).rejects.toMatchObject({ code: 'sync.schema_not_ready' });
      if (shared !== undefined) shared.close();
      else await db?.close();
    });

    test(`${backend}: a pending checkpoint is refused unless the process declares it`, async () => {
      const db = backend === 'Postgres' ? await PGlite.create() : undefined;
      const storage =
        backend === 'SQLite'
          ? new SqliteServerStorage()
          : new PostgresServerStorage(pgliteExecutor(db as PGlite));
      const operation = await registeredQuery(storage);
      await storage.declareCheckpoint(
        'part-1',
        'tasks-projection',
        SCHEMA.version,
        NOW,
      );
      await expect(
        operation.run(context(storage) as never, 'reader', undefined as never),
      ).rejects.toMatchObject({ code: 'sync.schema_not_ready' });
      // The declaring process is allowed to read while it backfills.
      await operation.run(
        context(storage, [
          { partition: 'part-1', name: 'tasks-projection', schemaVersion: 1 },
        ]) as never,
        'reader',
        undefined as never,
      );
      if (backend === 'SQLite') (storage as SqliteServerStorage).db.close();
      else await db?.close();
    });
  }
});

describe('transaction-bound registered queries in push hooks (§6.7, §6.8)', () => {
  // The fixture's `docs` rows act as grants: a body `editor:<actorId>` lets
  // that actor write tasks in the doc's project. Every hook reads them with
  // the generated `docsInProject` descriptor, unchanged.
  const IR_SCHEMA: ServerSchema = {
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
  };
  const table = (name: string) => {
    const found = IR.tables.find((candidate) => candidate.name === name);
    if (found === undefined) throw new Error('missing fixture table');
    return found.columns;
  };
  const DOC_COLUMNS = table('docs');
  const IR_TASK_COLUMNS = table('tasks');
  const plan = docsInProjectQuery.relationPlans[0];
  if (plan === undefined) throw new Error('missing generated plan');
  const grants = (projectId: string) => ({
    plan,
    params: docsInProjectQuery.bind({ orgId: 'o1', projectId }),
    tables: docsInProjectQuery.tables,
  });
  const grant = (id: string, body: string): PushOperation => ({
    table: 'docs',
    rowId: id,
    op: 'upsert',
    payload: encodeSparseRow(DOC_COLUMNS, 0, [
      id,
      'o1',
      'p1',
      body,
      null,
      null,
      null,
      null,
    ]),
  });
  const task = (id: string): PushOperation => ({
    table: 'tasks',
    rowId: id,
    op: 'upsert',
    payload: encodeSparseRow(IR_TASK_COLUMNS, 0, [
      id,
      'p1',
      'title',
      false,
      null,
      null,
      null,
      null,
      null,
    ]),
  });

  async function open(backend: 'SQLite' | 'Postgres' | 'D1') {
    const db = backend === 'Postgres' ? await PGlite.create() : undefined;
    const storage =
      backend === 'SQLite'
        ? new SqliteServerStorage()
        : backend === 'D1'
          ? new D1ServerStorage(new D1DatabaseDouble(), {
              pushApplySerialized: true,
            })
          : new PostgresServerStorage(pgliteExecutor(db as PGlite));
    const compiled = compileSchema(IR_SCHEMA);
    // The fixture needs more DDL than one default D1 migration budget.
    if (storage instanceof D1ServerStorage) {
      await storage.migrateSchema(compiled, { maxStatements: 1000 });
    }
    await storage.ensureSchema(compiled);
    for (const partition of ['part-1', 'part-2']) {
      await storage.touchPartition(partition, 1, 'epoch');
    }
    const seen: string[][] = [];
    const failures: unknown[] = [];
    const validators: ValidatorRegistry = {
      tasks: async (_op, ctx) => {
        let bodies: string[];
        try {
          const { rows } = await ctx.queryAuthoritative(grants('p1'));
          bodies = rows.map((row) => String(row.body));
        } catch (error) {
          failures.push(error);
          throw error;
        }
        seen.push(bodies);
        if (!bodies.includes(`editor:${ctx.actorId}`)) {
          throw new ValidationRejection('app.not_editor', 'not an editor');
        }
      },
    };
    const context = (partition: string, actorId: string) => ({
      schema: IR_SCHEMA,
      storage,
      segments: new MemorySegmentStore(),
      partition,
      actorId,
      resolveScopes: () => ({
        project_id: ['p1'],
        projectId: ['p1'],
        org_id: ['o1'],
      }),
    });
    const push = async (
      partition: string,
      actorId: string,
      clientCommitId: string,
      operations: PushOperation[],
      commitValidator?: CommitValidator,
    ): Promise<PushResultFrame> => {
      const message = decodeMessage(
        await handleSyncRequest(
          encodeMessage({
            wireVersion: PROTOCOL_WIRE_VERSION,
            msgKind: 'request',
            frames: [
              {
                type: 'REQ_HEADER',
                clientId: `client-${actorId}`,
                schemaVersion: IR.schemaVersion,
                logEpoch: 'epoch',
              },
              { type: 'PUSH_COMMIT', clientCommitId, operations },
            ],
          }),
          {
            ...context(partition, actorId),
            validators,
            ...(commitValidator === undefined ? {} : { commitValidator }),
          },
        ),
      );
      if (message.msgKind !== 'response') throw new Error('expected response');
      const result = message.frames.find(
        (frame): frame is PushResultFrame => frame.type === 'PUSH_RESULT',
      );
      if (result === undefined) throw new Error('expected a push result');
      return result;
    };
    const close = async () => {
      if (storage instanceof SqliteServerStorage) storage.db.close();
      else await db?.close();
    };
    return { storage, context, push, seen, failures, close };
  }

  for (const backend of ['SQLite', 'Postgres', 'D1'] as const) {
    test(`${backend}: a row validator runs the pre-push authority read on the push transaction`, async () => {
      const { storage, push, seen, close } = await open(backend);
      try {
        await push('part-1', 'admin', 'grant-a1', [grant('g-a1', 'editor:a1')]);
        const before = await storage.queryAuthoritative?.(
          'part-1',
          grants('p1'),
        );
        expect(before?.rows).toEqual([{ id: 'g-a1', body: 'editor:a1' }]);

        expect(
          await push('part-1', 'a1', 'accepted', [task('t1')]),
        ).toMatchObject({ status: 'applied' });
        expect(seen).toEqual([['editor:a1']]);
      } finally {
        await close();
      }
    });

    test(`${backend}: the authority read cannot see another partition's grant`, async () => {
      const { push, seen, close } = await open(backend);
      try {
        await push('part-2', 'admin', 'grant-a2', [grant('g-a2', 'editor:a2')]);
        expect(
          await push('part-1', 'a2', 'cross-partition', [task('t1')]),
        ).toMatchObject({
          status: 'rejected',
          results: [{ status: 'error', code: 'app.not_editor' }],
        });
        expect(seen).toEqual([[]]);
      } finally {
        await close();
      }
    });

    test(`${backend}: a committed revocation rejects the next write`, async () => {
      const { push, seen, close } = await open(backend);
      try {
        await push('part-1', 'admin', 'grant-a1', [grant('g-a1', 'editor:a1')]);
        await push('part-1', 'admin', 'revoke-a1', [grant('g-a1', 'revoked')]);
        expect(
          await push('part-1', 'a1', 'revoked', [task('t1')]),
        ).toMatchObject({
          status: 'rejected',
          results: [{ status: 'error', code: 'app.not_editor' }],
        });
        expect(seen).toEqual([['revoked']]);
      } finally {
        await close();
      }
    });
  }

  for (const backend of ['SQLite', 'Postgres'] as const) {
    test(`${backend}: a revocation staged earlier in the same commit is visible`, async () => {
      const { push, seen, close } = await open(backend);
      try {
        await push('part-1', 'admin', 'grant-a1', [grant('g-a1', 'editor:a1')]);
        expect(
          await push('part-1', 'a1', 'self-revoke', [
            grant('g-a1', 'revoked'),
            task('t1'),
          ]),
        ).toMatchObject({
          status: 'rejected',
          results: [{ opIndex: 1, code: 'app.not_editor' }],
        });
        expect(seen).toEqual([['revoked']]);
      } finally {
        await close();
      }
    });

    test(`${backend}: the whole-commit reader sees a grant staged by a sibling`, async () => {
      const { push, close } = await open(backend);
      const observed: string[][] = [];
      try {
        expect(
          await push(
            'part-1',
            'admin',
            'staged-grant',
            [grant('g-a3', 'editor:a3')],
            async ({ read }) => {
              const { rows } = await read.queryAuthoritative(grants('p1'));
              observed.push(rows.map((row) => String(row.body)));
            },
          ),
        ).toMatchObject({ status: 'applied' });
        expect(observed).toEqual([['editor:a3']]);
      } finally {
        await close();
      }
    });

    test(`${backend}: a concurrent revocation never lets a write through on stale authority`, async () => {
      const { push, close } = await open(backend);
      try {
        await push('part-1', 'admin', 'grant-a1', [grant('g-a1', 'editor:a1')]);
        const [revoke, write] = await Promise.all([
          push('part-1', 'admin', 'revoke-a1', [grant('g-a1', 'revoked')]),
          push('part-1', 'a1', 'racing', [task('t1')]),
        ]);
        expect(revoke).toMatchObject({ status: 'applied' });
        if (write.status === 'applied') {
          expect(write.commitSeq ?? 0).toBeLessThan(revoke.commitSeq ?? 0);
        } else {
          expect(write).toMatchObject({
            status: 'rejected',
            results: [{ code: 'app.not_editor' }],
          });
        }
      } finally {
        await close();
      }
    });
  }

  for (const backend of ['SQLite', 'Postgres', 'D1'] as const) {
    test(`${backend}: a remote command reads authority on its push transaction`, async () => {
      const { context, push, close } = await open(backend);
      const command = registerRemoteCommand<{ readonly taskId: string }>(
        { id: 'create-task' },
        {
          authorize: () => true,
          run: async (commandContext, input) => {
            const { rows } = await commandContext.queryAuthoritative(
              grants('p1'),
            );
            if (
              !rows.some(
                (row) => row.body === `editor:${commandContext.actorId}`,
              )
            ) {
              throw new ValidationRejection('app.not_editor', 'not an editor');
            }
            return [
              {
                table: 'tasks',
                op: 'upsert',
                values: {
                  id: input.taskId,
                  project_id: 'p1',
                  title: 'title',
                  done: false,
                  reviewed: null,
                  priority: null,
                  meta: null,
                  estimate: null,
                  estimated_at: null,
                },
              },
            ];
          },
        },
      );
      try {
        await push('part-1', 'admin', 'grant-a1', [grant('g-a1', 'editor:a1')]);
        await push('part-2', 'admin', 'grant-a2', [grant('g-a2', 'editor:a2')]);
        expect(
          await command.run(context('part-1', 'a1'), 'client-a1', 'r1', {
            taskId: 't1',
          }),
        ).toMatchObject({ kind: 'command', status: 'applied' });
        await expect(
          command.run(context('part-1', 'a2'), 'client-a2', 'r2', {
            taskId: 't2',
          }),
        ).rejects.toMatchObject({ code: 'app.not_editor' });
      } finally {
        await close();
      }
    });
  }

  test('D1: a read over a table the commit has written fails with a stable code', async () => {
    const { push, failures, close } = await open('D1');
    try {
      await push('part-1', 'admin', 'grant-a1', [grant('g-a1', 'editor:a1')]);
      expect(
        await push('part-1', 'a1', 'self-revoke', [
          grant('g-a1', 'revoked'),
          task('t1'),
        ]),
      ).toMatchObject({
        status: 'rejected',
        results: [{ opIndex: 1, code: 'sync.constraint_violation' }],
      });
      expect(failures).toEqual([
        expect.objectContaining({
          code: 'sync.storage.query_over_staged_writes',
        }),
      ]);
    } finally {
      await close();
    }
  });

  test('a storage transaction without the capability fails with a stable code', async () => {
    const { storage, push, failures, close } = await open('SQLite');
    const begin = storage.begin.bind(storage);
    storage.begin = async (partition) => {
      const tx = await begin(partition);
      return new Proxy(tx, {
        get: (target, property) => {
          if (property === 'queryAuthoritative') return undefined;
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    };
    try {
      expect(
        await push('part-1', 'a1', 'unsupported', [task('t1')]),
      ).toMatchObject({
        status: 'rejected',
        results: [{ code: 'sync.constraint_violation' }],
      });
      expect(failures).toEqual([
        expect.objectContaining({
          code: 'sync.storage.transaction_query_unsupported',
        }),
      ]);
    } finally {
      await close();
    }
  });
});
