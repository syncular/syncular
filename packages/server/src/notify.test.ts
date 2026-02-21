import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createBunSqliteDb } from '../../dialect-bun-sqlite/src';
import { createSqliteServerDialect } from '../../server-dialect-sqlite/src';
import { createServerHandler, createServerHandlerCollection } from './handlers';
import { ensureSyncSchema } from './migrate';
import { EXTERNAL_CLIENT_ID, notifyExternalDataChange } from './notify';
import { pull } from './pull';
import type { SyncCoreDb } from './schema';

interface TasksTable {
  id: string;
  user_id: string;
  title: string;
  server_version: number;
}

interface CodesTable {
  id: string;
  catalog_id: string;
  code: string;
  label: string;
  server_version: number;
}

interface TestDb extends SyncCoreDb {
  tasks: TasksTable;
  codes: CodesTable;
}

interface ClientDb {
  tasks: TasksTable;
  codes: CodesTable;
}

const dialect = createSqliteServerDialect();

async function setupDb() {
  const db = createBunSqliteDb<TestDb>({ path: ':memory:' });
  await ensureSyncSchema(db, dialect);

  await db.schema
    .createTable('tasks')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('user_id', 'text', (col) => col.notNull())
    .addColumn('title', 'text', (col) => col.notNull())
    .addColumn('server_version', 'integer', (col) => col.notNull().defaultTo(0))
    .execute();

  await db.schema
    .createTable('codes')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('catalog_id', 'text', (col) => col.notNull())
    .addColumn('code', 'text', (col) => col.notNull())
    .addColumn('label', 'text', (col) => col.notNull())
    .addColumn('server_version', 'integer', (col) => col.notNull().defaultTo(0))
    .execute();

  return db;
}

describe('notifyExternalDataChange', () => {
  let db: ReturnType<typeof createBunSqliteDb<TestDb>>;

  beforeEach(async () => {
    db = await setupDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('creates a synthetic commit with __external__ client_id', async () => {
    const result = await notifyExternalDataChange({
      db,
      dialect,
      tables: ['codes'],
    });

    expect(result.commitSeq).toBeGreaterThan(0);
    expect(result.tables).toEqual(['codes']);

    const commit = await db
      .selectFrom('sync_commits')
      .selectAll()
      .where('commit_seq', '=', result.commitSeq)
      .executeTakeFirstOrThrow();

    expect(commit.client_id).toBe(EXTERNAL_CLIENT_ID);
    expect(commit.actor_id).toBe(EXTERNAL_CLIENT_ID);
    expect(commit.change_count).toBe(0);

    const affectedTables = dialect.dbToArray(commit.affected_tables);
    expect(affectedTables).toEqual(['codes']);
  });

  it('inserts sync_table_commits entries for each table', async () => {
    const result = await notifyExternalDataChange({
      db,
      dialect,
      tables: ['codes', 'tasks'],
    });

    const tableCommits = await db
      .selectFrom('sync_table_commits')
      .selectAll()
      .where('commit_seq', '=', result.commitSeq)
      .execute();

    const tables = tableCommits.map((r) => r.table).sort();
    expect(tables).toEqual(['codes', 'tasks']);
  });

  it('deletes cached snapshot chunks for affected tables', async () => {
    // Insert fake snapshot chunks
    await db
      .insertInto('sync_snapshot_chunks')
      .values({
        chunk_id: 'chunk-1',
        partition_id: 'default',
        scope_key: 'test-key',
        scope: 'codes',
        as_of_commit_seq: 1,
        row_cursor: '',
        row_limit: 1000,
        encoding: 'json-row-frame-v1',
        compression: 'gzip',
        sha256: 'abc',
        byte_length: 100,
        blob_hash: '',
        body: new Uint8Array([1, 2, 3]),
        expires_at: new Date(Date.now() + 86400000).toISOString(),
      })
      .execute();

    await db
      .insertInto('sync_snapshot_chunks')
      .values({
        chunk_id: 'chunk-2',
        partition_id: 'default',
        scope_key: 'test-key',
        scope: 'tasks',
        as_of_commit_seq: 1,
        row_cursor: '',
        row_limit: 1000,
        encoding: 'json-row-frame-v1',
        compression: 'gzip',
        sha256: 'def',
        byte_length: 200,
        blob_hash: '',
        body: new Uint8Array([4, 5, 6]),
        expires_at: new Date(Date.now() + 86400000).toISOString(),
      })
      .execute();

    const result = await notifyExternalDataChange({
      db,
      dialect,
      tables: ['codes'],
    });

    expect(result.deletedChunks).toBe(1);

    // 'codes' chunk should be deleted, 'tasks' chunk should remain
    const remaining = await db
      .selectFrom('sync_snapshot_chunks')
      .selectAll()
      .execute();
    expect(remaining.length).toBe(1);
    expect(remaining[0]!.scope).toBe('tasks');
  });

  it('throws on empty tables array', async () => {
    await expect(
      notifyExternalDataChange({ db, dialect, tables: [] })
    ).rejects.toThrow('tables must not be empty');
  });

  it('uses custom partitionId and actorId', async () => {
    const result = await notifyExternalDataChange({
      db,
      dialect,
      tables: ['codes'],
      partitionId: 'tenant-42',
      actorId: 'pipeline-bot',
    });

    const commit = await db
      .selectFrom('sync_commits')
      .selectAll()
      .where('commit_seq', '=', result.commitSeq)
      .executeTakeFirstOrThrow();

    expect(commit.partition_id).toBe('tenant-42');
    expect(commit.actor_id).toBe('pipeline-bot');
    expect(commit.client_id).toBe(EXTERNAL_CLIENT_ID);
  });
});

describe('pull re-bootstrap after external data change', () => {
  let db: ReturnType<typeof createBunSqliteDb<TestDb>>;

  beforeEach(async () => {
    db = await setupDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('forces re-bootstrap for affected tables after notifyExternalDataChange', async () => {
    // Seed some data
    await db
      .insertInto('codes')
      .values({
        id: 'c1',
        catalog_id: 'icd',
        code: 'A00',
        label: 'Cholera',
        server_version: 1,
      })
      .execute();

    const codesHandler = createServerHandler<TestDb, ClientDb, 'codes'>({
      table: 'codes',
      scopes: ['catalog:{catalog_id}'],
      resolveScopes: async () => ({ catalog_id: '*' }),
    });

    const handlers = createServerHandlerCollection<TestDb>([codesHandler]);

    // 1. Initial bootstrap pull
    const firstPull = await pull({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'client-1',
        limitCommits: 10,
        limitSnapshotRows: 100,
        maxSnapshotPages: 10,
        subscriptions: [
          {
            id: 'sub-codes',
            table: 'codes',
            scopes: { catalog_id: 'icd' },
            cursor: -1,
          },
        ],
      },
    });

    const firstSub = firstPull.response.subscriptions[0]!;
    expect(firstSub.bootstrap).toBe(true);
    const cursorAfterBootstrap = firstSub.nextCursor;
    expect(cursorAfterBootstrap).toBeGreaterThanOrEqual(0);

    // 2. Incremental pull (should get no changes)
    const incrementalPull = await pull({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'client-1',
        limitCommits: 10,
        limitSnapshotRows: 100,
        maxSnapshotPages: 10,
        subscriptions: [
          {
            id: 'sub-codes',
            table: 'codes',
            scopes: { catalog_id: 'icd' },
            cursor: cursorAfterBootstrap,
          },
        ],
      },
    });

    const incSub = incrementalPull.response.subscriptions[0]!;
    expect(incSub.bootstrap).toBe(false);
    expect(incSub.commits?.length ?? 0).toBe(0);

    // 3. Notify external data change for 'codes'
    const notifyResult = await notifyExternalDataChange({
      db,
      dialect,
      tables: ['codes'],
    });
    expect(notifyResult.commitSeq).toBeGreaterThan(cursorAfterBootstrap);

    // 4. Pull again with same cursor - should trigger re-bootstrap
    const rebootstrapPull = await pull({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'client-1',
        limitCommits: 10,
        limitSnapshotRows: 100,
        maxSnapshotPages: 10,
        subscriptions: [
          {
            id: 'sub-codes',
            table: 'codes',
            scopes: { catalog_id: 'icd' },
            cursor: cursorAfterBootstrap,
          },
        ],
      },
    });

    const rebootSub = rebootstrapPull.response.subscriptions[0]!;
    expect(rebootSub.bootstrap).toBe(true);
    expect(rebootSub.snapshots?.length).toBeGreaterThan(0);
  });

  it('does not force re-bootstrap for unaffected tables', async () => {
    await db
      .insertInto('tasks')
      .values({
        id: 't1',
        user_id: 'u1',
        title: 'My Task',
        server_version: 1,
      })
      .execute();

    const tasksHandler = createServerHandler<TestDb, ClientDb, 'tasks'>({
      table: 'tasks',
      scopes: ['user:{user_id}'],
      resolveScopes: async (ctx) => ({ user_id: [ctx.actorId] }),
    });

    const codesHandler = createServerHandler<TestDb, ClientDb, 'codes'>({
      table: 'codes',
      scopes: ['catalog:{catalog_id}'],
      resolveScopes: async () => ({ catalog_id: '*' }),
    });

    const handlers = createServerHandlerCollection<TestDb>([
      tasksHandler,
      codesHandler,
    ]);

    // 1. Bootstrap pull for tasks
    const firstPull = await pull({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'client-1',
        limitCommits: 10,
        limitSnapshotRows: 100,
        maxSnapshotPages: 10,
        subscriptions: [
          {
            id: 'sub-tasks',
            table: 'tasks',
            scopes: { user_id: 'u1' },
            cursor: -1,
          },
        ],
      },
    });

    const cursorAfterBootstrap =
      firstPull.response.subscriptions[0]!.nextCursor;

    // 2. Notify external data change for 'codes' only (not tasks)
    await notifyExternalDataChange({
      db,
      dialect,
      tables: ['codes'],
    });

    // 3. Pull tasks again - should NOT trigger re-bootstrap
    const pullAfterNotify = await pull({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'client-1',
        limitCommits: 10,
        limitSnapshotRows: 100,
        maxSnapshotPages: 10,
        subscriptions: [
          {
            id: 'sub-tasks',
            table: 'tasks',
            scopes: { user_id: 'u1' },
            cursor: cursorAfterBootstrap,
          },
        ],
      },
    });

    const tasksSub = pullAfterNotify.response.subscriptions[0]!;
    expect(tasksSub.bootstrap).toBe(false);
  });

  it('forces re-bootstrap only for the affected table in a multi-subscription pull', async () => {
    await db
      .insertInto('tasks')
      .values({
        id: 't1',
        user_id: 'u1',
        title: 'My Task',
        server_version: 1,
      })
      .execute();

    await db
      .insertInto('codes')
      .values({
        id: 'c1',
        catalog_id: 'icd',
        code: 'A00',
        label: 'Cholera',
        server_version: 1,
      })
      .execute();

    const tasksHandler = createServerHandler<TestDb, ClientDb, 'tasks'>({
      table: 'tasks',
      scopes: ['user:{user_id}'],
      resolveScopes: async (ctx) => ({ user_id: [ctx.actorId] }),
    });

    const codesHandler = createServerHandler<TestDb, ClientDb, 'codes'>({
      table: 'codes',
      scopes: ['catalog:{catalog_id}'],
      resolveScopes: async () => ({ catalog_id: '*' }),
    });

    const handlers = createServerHandlerCollection<TestDb>([
      tasksHandler,
      codesHandler,
    ]);

    // 1. Bootstrap both subscriptions
    const firstPull = await pull({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'client-1',
        limitCommits: 10,
        limitSnapshotRows: 100,
        maxSnapshotPages: 10,
        subscriptions: [
          {
            id: 'sub-tasks',
            table: 'tasks',
            scopes: { user_id: 'u1' },
            cursor: -1,
          },
          {
            id: 'sub-codes',
            table: 'codes',
            scopes: { catalog_id: 'icd' },
            cursor: -1,
          },
        ],
      },
    });

    const tasksCursor = firstPull.response.subscriptions[0]!.nextCursor;
    const codesCursor = firstPull.response.subscriptions[1]!.nextCursor;

    // 2. Notify external data change for 'codes' only
    await notifyExternalDataChange({ db, dialect, tables: ['codes'] });

    // 3. Pull both subscriptions
    const pullAfter = await pull({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'client-1',
        limitCommits: 10,
        limitSnapshotRows: 100,
        maxSnapshotPages: 10,
        subscriptions: [
          {
            id: 'sub-tasks',
            table: 'tasks',
            scopes: { user_id: 'u1' },
            cursor: tasksCursor,
          },
          {
            id: 'sub-codes',
            table: 'codes',
            scopes: { catalog_id: 'icd' },
            cursor: codesCursor,
          },
        ],
      },
    });

    const tasksSub = pullAfter.response.subscriptions.find(
      (s) => s.id === 'sub-tasks'
    )!;
    const codesSub = pullAfter.response.subscriptions.find(
      (s) => s.id === 'sub-codes'
    )!;

    expect(tasksSub.bootstrap).toBe(false);
    expect(codesSub.bootstrap).toBe(true);
  });
});
