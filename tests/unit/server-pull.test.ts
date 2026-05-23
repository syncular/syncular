import { beforeEach, describe, expect, it } from 'bun:test';
import { gunzipSync } from 'node:zlib';
import {
  createDatabase,
  decodeBinarySnapshotTable,
  encodeBinarySnapshotTable,
  SYNC_SNAPSHOT_CHUNK_ENCODING_BINARY_TABLE_V1,
  sha256Hex,
} from '@syncular/core';
import { createBunSqliteDialect } from '@syncular/dialect-bun-sqlite';
import {
  createServerHandler,
  createServerHandlerCollection,
  ensureSyncSchema,
  pull,
  pushCommit,
  readSnapshotChunk,
  type ServerTableHandler,
  type SyncCoreDb,
  type SyncSnapshot,
} from '@syncular/server';
import { createSqliteServerDialect } from '@syncular/server-dialect-sqlite';
import type { Kysely } from 'kysely';

interface TasksTable {
  id: string;
  user_id: string;
  title: string;
  server_version: number;
}

interface ServerDb extends SyncCoreDb {
  tasks: TasksTable;
}

interface ClientDb {
  tasks: TasksTable;
}

function decodeSnapshotChunkRowsGzip(
  bytes: Uint8Array | ReadableStream<Uint8Array>,
  encoding: string
): unknown[] {
  if (!(bytes instanceof Uint8Array)) throw new Error('Expected Uint8Array');
  const decoded = gunzipSync(bytes);
  if (encoding === SYNC_SNAPSHOT_CHUNK_ENCODING_BINARY_TABLE_V1) {
    return decodeBinarySnapshotTable(decoded).rows;
  }
  throw new Error(`Unexpected snapshot encoding: ${encoding}`);
}

function snapshotBodyBytes(
  bytes: Uint8Array | ReadableStream<Uint8Array>
): Uint8Array {
  if (!(bytes instanceof Uint8Array)) {
    throw new Error('Expected Uint8Array snapshot body in this test');
  }
  return bytes;
}

async function readSnapshotRows(
  db: Kysely<ServerDb>,
  snapshot: SyncSnapshot
): Promise<unknown[]> {
  if (snapshot.rows.length > 0) {
    return snapshot.rows;
  }

  const chunkRef = snapshot.chunks?.[0];
  if (!chunkRef) {
    throw new Error('Expected inline rows or a snapshot chunk');
  }

  const chunk = await readSnapshotChunk(db, chunkRef.id);
  if (!chunk) {
    throw new Error('Expected stored snapshot chunk');
  }

  return decodeSnapshotChunkRowsGzip(chunk.body, chunkRef.encoding);
}

describe('pull', () => {
  let db: Kysely<ServerDb>;
  const dialect = createSqliteServerDialect();

  const makeHandlers = (
    overrides?: Partial<
      Parameters<typeof createServerHandler<ServerDb, ClientDb, 'tasks'>>[0]
    >
  ) => {
    const tasksHandler = createServerHandler<ServerDb, ClientDb, 'tasks'>({
      table: 'tasks',
      scopes: ['user:{user_id}'],
      resolveScopes: async (ctx) => ({ user_id: [ctx.actorId] }),
      ...overrides,
    });
    return createServerHandlerCollection<ServerDb>([tasksHandler]);
  };

  const pushTask = async (
    handlers: ReturnType<typeof makeHandlers>,
    taskId: string,
    title: string,
    userId = 'u1',
    clientId = 'c1'
  ) => {
    return pushCommit({
      db,
      dialect,
      handlers,
      auth: { actorId: userId },
      request: {
        clientId,
        clientCommitId: `commit-${taskId}-${Date.now()}-${Math.random()}`,
        schemaVersion: 1,
        operations: [
          {
            table: 'tasks',
            row_id: taskId,
            op: 'upsert',
            payload: { title, user_id: userId },
            base_version: null,
          },
        ],
      },
    });
  };

  beforeEach(async () => {
    db = createDatabase<ServerDb>({
      dialect: createBunSqliteDialect({ path: ':memory:' }),
      family: 'sqlite',
    });
    await ensureSyncSchema(db, dialect);

    await db.schema
      .createTable('tasks')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('user_id', 'text', (col) => col.notNull())
      .addColumn('title', 'text', (col) => col.notNull())
      .addColumn('server_version', 'integer', (col) =>
        col.notNull().defaultTo(0)
      )
      .execute();
  });

  // -----------------------------------------------------------
  // Empty pull
  // -----------------------------------------------------------

  it('returns empty subscriptions when none are requested', async () => {
    const handlers = makeHandlers();
    const res = await pull({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'c1',
        schemaVersion: 1,
        limitCommits: 10,
        subscriptions: [],
      },
    });

    expect(res.response.ok).toBe(true);
    expect(res.response.subscriptions).toEqual([]);
  });

  // -----------------------------------------------------------
  // Bootstrap on cursor -1
  // -----------------------------------------------------------

  it('triggers bootstrap when cursor is -1 and returns snapshot data', async () => {
    const handlers = makeHandlers();

    // Push some data first
    await pushTask(handlers, 'task-1', 'First Task');
    await pushTask(handlers, 'task-2', 'Second Task');

    const res = await pull({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'c1',
        schemaVersion: 1,
        limitCommits: 10,
        subscriptions: [
          {
            id: 's1',
            table: 'tasks',
            scopes: { user_id: 'u1' },
            cursor: -1,
            crdtStateVectors: [],
          },
        ],
      },
    });

    expect(res.response.ok).toBe(true);
    const sub = res.response.subscriptions[0]!;
    expect(sub.status).toBe('active');
    expect(sub.bootstrap).toBe(true);
    expect(sub.snapshots).toBeDefined();
    expect(sub.snapshots!.length).toBeGreaterThan(0);

    // Read the snapshot chunk and verify it has data
    const snapshot = sub.snapshots![0]!;
    expect(snapshot.table).toBe('tasks');
    const rows = await readSnapshotRows(db, snapshot);
    expect(rows.length).toBe(2);
  });

  it('passes the requested client schema version into snapshot handlers', async () => {
    let seenSchemaVersion = 0;
    const handlers = makeHandlers({
      snapshot: async (ctx) => {
        seenSchemaVersion = ctx.schemaVersion;
        return { rows: [], nextCursor: null };
      },
    });

    await pull({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'schema-reader',
        schemaVersion: 6,
        limitCommits: 10,
        subscriptions: [
          {
            id: 's1',
            table: 'tasks',
            scopes: { user_id: 'u1' },
            cursor: -1,
            crdtStateVectors: [],
          },
        ],
      },
    });

    expect(seenSchemaVersion).toBe(6);
  });

  it('projects incremental pull changes through the table handler schema hook', async () => {
    const baseHandlers = makeHandlers();
    const baseHandler = baseHandlers.byTable.get('tasks');
    if (!baseHandler) throw new Error('Expected tasks handler');
    let seenSchemaVersion = 0;
    const projectedHandler: ServerTableHandler<ServerDb> = {
      ...baseHandler,
      projectChangeForVersion(change, schemaVersion) {
        seenSchemaVersion = schemaVersion;
        if (
          schemaVersion === 6 &&
          change.row_json &&
          typeof change.row_json === 'object' &&
          !Array.isArray(change.row_json)
        ) {
          const { server_version: _serverVersion, ...row } =
            change.row_json as TasksTable;
          return { ...change, row_json: row };
        }
        return change;
      },
    };
    const handlers = createServerHandlerCollection<ServerDb>([
      projectedHandler,
    ]);

    await pushTask(handlers, 'schema-project-task', 'Initial');
    const bootstrap = await pull({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'schema-project-reader',
        schemaVersion: 6,
        limitCommits: 10,
        subscriptions: [
          {
            id: 's1',
            table: 'tasks',
            scopes: { user_id: 'u1' },
            cursor: -1,
            crdtStateVectors: [],
          },
        ],
      },
    });

    await pushTask(handlers, 'schema-project-task', 'Changed');
    const result = await pull({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'schema-project-reader',
        schemaVersion: 6,
        limitCommits: 10,
        subscriptions: [
          {
            id: 's1',
            table: 'tasks',
            scopes: { user_id: 'u1' },
            cursor: bootstrap.response.subscriptions[0]!.nextCursor,
            crdtStateVectors: [],
          },
        ],
      },
    });

    expect(seenSchemaVersion).toBe(6);
    const row = result.response.subscriptions[0]?.commits[0]?.changes[0]
      ?.row_json as Record<string, unknown>;
    expect(row).toMatchObject({
      id: 'schema-project-task',
      user_id: 'u1',
      title: 'Changed',
    });
    expect(row).not.toHaveProperty('server_version');
  });

  it('keeps snapshot chunk cache entries separated by client schema version', async () => {
    const handlers = makeHandlers();
    await pushTask(handlers, 't-schema-cache', 'Schema cached task');

    const pullSnapshot = async (schemaVersion: number) => {
      const result = await pull({
        db,
        dialect,
        handlers,
        auth: { actorId: 'u1' },
        request: {
          clientId: `schema-cache-${schemaVersion}`,
          schemaVersion,
          limitCommits: 10,
          subscriptions: [
            {
              id: 's1',
              table: 'tasks',
              scopes: { user_id: 'u1' },
              cursor: -1,
              crdtStateVectors: [],
            },
          ],
        },
      });
      const snapshot = result.response.subscriptions[0]?.snapshots?.[0];
      if (!snapshot?.chunks?.[0]) {
        throw new Error('Expected chunked snapshot');
      }
      return snapshot;
    };

    const schema6First = await pullSnapshot(6);
    const schema6Second = await pullSnapshot(6);
    const schema7 = await pullSnapshot(7);

    expect(schema6Second.chunks?.[0]?.id).toBe(schema6First.chunks?.[0]?.id);
    expect(schema7.chunks?.[0]?.id).not.toBe(schema6First.chunks?.[0]?.id);
    await expect(readSnapshotRows(db, schema7)).resolves.toEqual([
      {
        id: 't-schema-cache',
        user_id: 'u1',
        title: 'Schema cached task',
        server_version: 1,
      },
    ]);
  });

  it('emits binary snapshot chunks when the client requests them', async () => {
    const handlers = makeHandlers();

    await pushTask(handlers, 'task-1', 'First Task');
    await pushTask(handlers, 'task-2', 'Second Task');

    const res = await pull({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'c1',
        schemaVersion: 1,
        limitCommits: 10,
        subscriptions: [
          {
            id: 's1',
            table: 'tasks',
            scopes: { user_id: 'u1' },
            cursor: -1,
            crdtStateVectors: [],
          },
        ],
      },
    });

    const snapshot = res.response.subscriptions[0]!.snapshots![0]!;
    const chunkRef = snapshot.chunks?.[0];
    expect(chunkRef?.encoding).toBe(
      SYNC_SNAPSHOT_CHUNK_ENCODING_BINARY_TABLE_V1
    );

    const chunk = await readSnapshotChunk(db, chunkRef!.id);
    if (!chunk) throw new Error('Expected stored snapshot chunk');
    expect(chunkRef!.sha256).toBe(
      await sha256Hex(snapshotBodyBytes(chunk.body))
    );
    const decoded = decodeBinarySnapshotTable(
      gunzipSync(snapshotBodyBytes(chunk.body))
    );
    expect(decoded.table).toBe('tasks');
    expect(decoded.columns.map((column) => column.name).sort()).toEqual([
      'id',
      'server_version',
      'title',
      'user_id',
    ]);
    expect(decoded.rows.map((row) => row.title).sort()).toEqual([
      'First Task',
      'Second Task',
    ]);
  });

  it('keeps bootstrap snapshots chunked when resync could otherwise inline small rows', async () => {
    const handlers = makeHandlers();

    await pushTask(handlers, 'task-1', 'First Task');
    await pushTask(handlers, 'task-2', 'Second Task');

    const res = await pull({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'c2',
        schemaVersion: 1,
        limitCommits: 10,
        subscriptions: [
          {
            id: 's1',
            table: 'tasks',
            scopes: { user_id: 'u1' },
            cursor: 999999,
            crdtStateVectors: [],
          },
        ],
      },
    });

    const snapshot = res.response.subscriptions[0]!.snapshots![0]!;
    expect(snapshot.rows).toEqual([]);
    expect(snapshot.chunks?.[0]?.encoding).toBe(
      SYNC_SNAPSHOT_CHUNK_ENCODING_BINARY_TABLE_V1
    );
  });

  it('uses binary snapshot chunk continuation metadata to skip cached snapshot queries', async () => {
    let snapshotQueryCount = 0;
    const handlers = makeHandlers({
      snapshotBinaryColumns: [
        { name: 'id', type: 'string' },
        { name: 'user_id', type: 'string' },
        { name: 'title', type: 'string' },
        { name: 'server_version', type: 'integer' },
      ],
      snapshot: async (ctx) => {
        snapshotQueryCount += 1;
        let query = ctx.db
          .selectFrom('tasks')
          .selectAll()
          .where('user_id', '=', ctx.actorId);
        if (ctx.cursor !== null) {
          query = query.where('id', '>', ctx.cursor);
        }
        const rows = await query
          .orderBy('id', 'asc')
          .limit(ctx.limit + 1)
          .execute();
        const pageRows = rows.slice(0, ctx.limit);
        const hasMore = rows.length > ctx.limit;
        const nextCursor = hasMore
          ? (pageRows[pageRows.length - 1]?.id ?? null)
          : null;
        return { rows: pageRows, nextCursor };
      },
    });

    for (let index = 0; index < 5; index += 1) {
      await pushTask(handlers, `task-${index}`, `Task ${index}`);
    }

    const pullRequest = (clientId: string) =>
      pull({
        db,
        dialect,
        handlers,
        auth: { actorId: 'u1' },
        request: {
          clientId,
          schemaVersion: 1,
          limitCommits: 10,
          limitSnapshotRows: 2,
          maxSnapshotPages: 3,
          subscriptions: [
            {
              id: 's1',
              table: 'tasks',
              scopes: { user_id: 'u1' },
              cursor: -1,
              crdtStateVectors: [],
            },
          ],
        },
      });

    await pullRequest('c-cache-warm');
    expect(snapshotQueryCount).toBe(3);

    snapshotQueryCount = 0;
    const cached = await pullRequest('c-cache-hit');
    expect(snapshotQueryCount).toBe(0);

    const snapshot = cached.response.subscriptions[0]!.snapshots![0]!;
    expect(snapshot.isLastPage).toBe(true);
    const chunkRef = snapshot.chunks?.[0];
    expect(chunkRef?.encoding).toBe(
      SYNC_SNAPSHOT_CHUNK_ENCODING_BINARY_TABLE_V1
    );
    const chunk = await readSnapshotChunk(db, chunkRef!.id);
    if (!chunk) throw new Error('Expected stored snapshot chunk');
    const decoded = decodeBinarySnapshotTable(
      gunzipSync(snapshotBodyBytes(chunk.body))
    );
    expect(decoded.rows).toHaveLength(5);
  });

  it('uses stable binary chunk cache keys when page size exceeds bundle target', async () => {
    let snapshotQueryCount = 0;
    const rows = Array.from({ length: 5 }, (_, index) => ({
      id: `task-${index}`,
      user_id: 'u1',
      title: `Task ${index}`,
      server_version: 1,
    }));
    const handlers = makeHandlers({
      snapshotBinaryColumns: [
        { name: 'id', type: 'string' },
        { name: 'user_id', type: 'string' },
        { name: 'title', type: 'string' },
        { name: 'server_version', type: 'integer' },
      ],
      snapshot: async (ctx) => {
        snapshotQueryCount += 1;
        const start =
          ctx.cursor == null
            ? 0
            : rows.findIndex((row) => row.id > ctx.cursor!);
        const offset = start < 0 ? rows.length : start;
        const pageRows = rows.slice(offset, offset + ctx.limit);
        const nextRow = rows[offset + ctx.limit - 1];
        return {
          rows: pageRows,
          nextCursor:
            offset + ctx.limit < rows.length && nextRow ? nextRow.id : null,
        };
      },
    });

    const pullRequest = (clientId: string) =>
      pull({
        db,
        dialect,
        handlers,
        auth: { actorId: 'u1' },
        request: {
          clientId,
          schemaVersion: 1,
          limitCommits: 10,
          limitSnapshotRows: 60_000,
          maxSnapshotPages: 1,
          subscriptions: [
            {
              id: 's1',
              table: 'tasks',
              scopes: { user_id: 'u1' },
              cursor: -1,
              crdtStateVectors: [],
            },
          ],
        },
      });

    await pullRequest('c-large-page-cache-warm');
    expect(snapshotQueryCount).toBe(1);

    snapshotQueryCount = 0;
    const cached = await pullRequest('c-large-page-cache-hit');
    expect(snapshotQueryCount).toBe(0);
    expect(cached.response.subscriptions[0]!.snapshots![0]!.isLastPage).toBe(
      true
    );
  });

  it('uses handler-provided binary snapshot columns when available', async () => {
    const handlers = makeHandlers({
      snapshotBinaryColumns: [
        { name: 'id', type: 'string' },
        { name: 'user_id', type: 'string' },
        { name: 'title', type: 'string' },
        { name: 'server_version', type: 'integer' },
      ],
    });

    await pushTask(handlers, 'task-1', 'First Task');

    const res = await pull({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'c1',
        schemaVersion: 1,
        limitCommits: 10,
        subscriptions: [
          {
            id: 's1',
            table: 'tasks',
            scopes: { user_id: 'u1' },
            cursor: -1,
            crdtStateVectors: [],
          },
        ],
      },
    });

    const chunkRef = res.response.subscriptions[0]!.snapshots![0]!.chunks![0]!;
    const chunk = await readSnapshotChunk(db, chunkRef.id);
    if (!chunk) throw new Error('Expected stored snapshot chunk');
    const decoded = decodeBinarySnapshotTable(
      gunzipSync(snapshotBodyBytes(chunk.body))
    );

    expect(decoded.columns).toEqual([
      { name: 'id', type: 'string' },
      { name: 'user_id', type: 'string' },
      { name: 'title', type: 'string' },
      { name: 'server_version', type: 'integer' },
    ]);
    expect(decoded.rows).toEqual([
      {
        id: 'task-1',
        user_id: 'u1',
        title: 'First Task',
        server_version: 1,
      },
    ]);
  });

  it('attaches generated snapshot binary metadata at the handler collection boundary', async () => {
    const columns = [
      { name: 'id', type: 'string' },
      { name: 'user_id', type: 'string' },
      { name: 'title', type: 'string' },
      { name: 'server_version', type: 'integer' },
    ] as const;
    let encoderCallCount = 0;
    const taskHandler = createServerHandler<ServerDb, ClientDb, 'tasks'>({
      table: 'tasks',
      scopes: ['user:{user_id}'],
      resolveScopes: async (ctx) => ({ user_id: [ctx.actorId] }),
    });
    const handlers = createServerHandlerCollection<ServerDb>([taskHandler], {
      snapshotBinary: {
        columns: { tasks: columns },
        encoders: {
          tasks: (rows) => {
            encoderCallCount += 1;
            return encodeBinarySnapshotTable({
              table: 'tasks',
              columns: [...columns],
              rows: rows as Record<string, unknown>[],
            });
          },
        },
        columnsForVersion: (table, schemaVersion) =>
          table === 'tasks' && schemaVersion === 6 ? columns : undefined,
        encoderForVersion: (_table, schemaVersion) =>
          schemaVersion === 6 ? null : undefined,
      },
    });
    const resolvedTaskHandler = handlers.byTable.get('tasks');
    expect(resolvedTaskHandler?.snapshotBinaryColumnsForVersion?.(6)).toEqual(
      columns
    );
    expect(resolvedTaskHandler?.snapshotBinaryEncoderForVersion?.(6)).toBeNull();

    await pushTask(handlers, 'task-1', 'First Task');

    const res = await pull({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'c1',
        schemaVersion: 1,
        limitCommits: 10,
        subscriptions: [
          {
            id: 's1',
            table: 'tasks',
            scopes: { user_id: 'u1' },
            cursor: -1,
            crdtStateVectors: [],
          },
        ],
      },
    });

    expect(encoderCallCount).toBe(1);
    const chunkRef = res.response.subscriptions[0]!.snapshots![0]!.chunks![0]!;
    const chunk = await readSnapshotChunk(db, chunkRef.id);
    if (!chunk) throw new Error('Expected stored snapshot chunk');
    const decoded = decodeBinarySnapshotTable(
      gunzipSync(snapshotBodyBytes(chunk.body))
    );

    expect(decoded.columns).toEqual([...columns]);
    expect(decoded.rows).toEqual([
      {
        id: 'task-1',
        user_id: 'u1',
        title: 'First Task',
        server_version: 1,
      },
    ]);
  });

  it('uses schema-versioned binary metadata for old-client bootstrap chunks', async () => {
    const historicalColumns = [
      { name: 'id', type: 'string' },
      { name: 'user_id', type: 'string' },
      { name: 'title', type: 'string' },
      { name: 'server_version', type: 'integer' },
    ] as const;
    let currentEncoderCallCount = 0;
    const handlers = makeHandlers({
      snapshotBinaryColumns: [
        ...historicalColumns,
        { name: 'current_only', type: 'string', nullable: true },
      ],
      snapshotBinaryColumnsForVersion: (schemaVersion) =>
        schemaVersion === 6 ? historicalColumns : undefined,
      snapshotBinaryEncoder: (rows) => {
        currentEncoderCallCount += 1;
        return encodeBinarySnapshotTable({
          table: 'tasks',
          columns: [
            ...historicalColumns,
            { name: 'current_only', type: 'string', nullable: true },
          ],
          rows: rows as Record<string, unknown>[],
        });
      },
      snapshotBinaryEncoderForVersion: (schemaVersion) =>
        schemaVersion === 6 ? null : undefined,
    });

    await pushTask(handlers, 'task-1', 'First Task');

    const res = await pull({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'c-schema-6',
        schemaVersion: 6,
        limitCommits: 10,
        subscriptions: [
          {
            id: 's1',
            table: 'tasks',
            scopes: { user_id: 'u1' },
            cursor: -1,
            crdtStateVectors: [],
          },
        ],
      },
    });

    expect(currentEncoderCallCount).toBe(0);
    const chunkRef = res.response.subscriptions[0]!.snapshots![0]!.chunks![0]!;
    const chunk = await readSnapshotChunk(db, chunkRef.id);
    if (!chunk) throw new Error('Expected stored snapshot chunk');
    const decoded = decodeBinarySnapshotTable(
      gunzipSync(snapshotBodyBytes(chunk.body))
    );

    expect(decoded.columns).toEqual([...historicalColumns]);
    expect(decoded.rows).toEqual([
      {
        id: 'task-1',
        user_id: 'u1',
        title: 'First Task',
        server_version: 1,
      },
    ]);
  });

  it('keeps snapshot chunk cache entries separate by gzip level', async () => {
    const handlers = makeHandlers({
      snapshotBinaryColumns: [
        { name: 'id', type: 'string' },
        { name: 'user_id', type: 'string' },
        { name: 'title', type: 'string' },
        { name: 'server_version', type: 'integer' },
      ],
    });

    for (let index = 0; index < 40; index += 1) {
      await pushTask(
        handlers,
        `task-${index}`,
        `Repeated title ${'x'.repeat(512)}`
      );
    }

    const pullSnapshot = async (clientId: string, gzipLevel?: number) => {
      const res = await pull({
        db,
        dialect,
        handlers,
        auth: { actorId: 'u1' },
        snapshotChunkGzipLevel: gzipLevel,
        request: {
          clientId,
          schemaVersion: 1,
          limitCommits: 10,
          subscriptions: [
            {
              id: 's1',
              table: 'tasks',
              scopes: { user_id: 'u1' },
              cursor: -1,
              crdtStateVectors: [],
            },
          ],
        },
      });
      const chunkRef =
        res.response.subscriptions[0]!.snapshots![0]!.chunks![0]!;
      const chunk = await readSnapshotChunk(db, chunkRef.id);
      if (!chunk) throw new Error('Expected stored snapshot chunk');
      return chunk;
    };

    const compressed = await pullSnapshot('c-gzip-default');
    const uncompressedGzip = await pullSnapshot('c-gzip-zero', 0);
    const snapshotChunkCountRow = await db
      .selectFrom('sync_snapshot_chunks')
      .select(({ fn }) => fn.countAll().as('count'))
      .executeTakeFirstOrThrow();

    expect(Number(snapshotChunkCountRow.count)).toBe(2);
    const uncompressedBody = snapshotBodyBytes(uncompressedGzip.body);
    const compressedBody = snapshotBodyBytes(compressed.body);
    expect(uncompressedBody.length).toBeGreaterThan(compressedBody.length);
    expect(
      decodeBinarySnapshotTable(
        gunzipSync(snapshotBodyBytes(uncompressedGzip.body))
      ).rows
    ).toHaveLength(40);
  });

  // -----------------------------------------------------------
  // Bootstrap completion
  // -----------------------------------------------------------

  it('sets bootstrapState to null and status to active when bootstrap completes in one page', async () => {
    const handlers = makeHandlers();
    await pushTask(handlers, 'task-1', 'Task One');

    const res = await pull({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'c1',
        schemaVersion: 1,
        limitCommits: 10,
        subscriptions: [
          {
            id: 's1',
            table: 'tasks',
            scopes: { user_id: 'u1' },
            cursor: -1,
            crdtStateVectors: [],
          },
        ],
      },
    });

    const sub = res.response.subscriptions[0]!;
    expect(sub.status).toBe('active');
    expect(sub.bootstrap).toBe(true);
    // When bootstrap completes in one page, bootstrapState should be null
    expect(sub.bootstrapState).toBeNull();

    // The snapshot's last page flag should be true
    const snapshot = sub.snapshots![0]!;
    expect(snapshot.isLastPage).toBe(true);
  });

  // -----------------------------------------------------------
  // Incremental pull
  // -----------------------------------------------------------

  it('returns commits in order for incremental pull', async () => {
    const handlers = makeHandlers();

    // Push three tasks to create three commits
    await pushTask(handlers, 'task-1', 'First');
    await pushTask(handlers, 'task-2', 'Second');
    await pushTask(handlers, 'task-3', 'Third');

    // First do a bootstrap pull to get the cursor
    const bootstrapRes = await pull({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'c1',
        schemaVersion: 1,
        limitCommits: 50,
        subscriptions: [
          {
            id: 's1',
            table: 'tasks',
            scopes: { user_id: 'u1' },
            cursor: -1,
            crdtStateVectors: [],
          },
        ],
      },
    });

    const bootstrapCursor = bootstrapRes.response.subscriptions[0]!.nextCursor;

    // Push more data after bootstrap
    await pushTask(handlers, 'task-4', 'Fourth');
    await pushTask(handlers, 'task-5', 'Fifth');

    // Now do an incremental pull
    const res = await pull({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'c1',
        schemaVersion: 1,
        limitCommits: 50,
        subscriptions: [
          {
            id: 's1',
            table: 'tasks',
            scopes: { user_id: 'u1' },
            cursor: bootstrapCursor,
            crdtStateVectors: [],
          },
        ],
      },
    });

    const sub = res.response.subscriptions[0]!;
    expect(sub.status).toBe('active');
    expect(sub.bootstrap).toBe(false);
    expect(sub.commits.length).toBe(2);

    // Commits should be in ascending order
    expect(sub.commits[0]!.commitSeq).toBeLessThan(sub.commits[1]!.commitSeq);
  });

  it('skips the extra commit-window scan when incremental pull returns matching rows', async () => {
    const handlers = makeHandlers();

    await pushTask(handlers, 'task-1', 'First');

    const bootstrapRes = await pull({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'c1',
        schemaVersion: 1,
        limitCommits: 50,
        subscriptions: [
          {
            id: 's1',
            table: 'tasks',
            scopes: { user_id: 'u1' },
            cursor: -1,
            crdtStateVectors: [],
          },
        ],
      },
    });
    const cursor = bootstrapRes.response.subscriptions[0]!.nextCursor;

    await pushTask(handlers, 'task-2', 'Second');
    await pushTask(handlers, 'task-3', 'Third');

    const countingDialect = createSqliteServerDialect();
    let readCommitSeqsForPullCalls = 0;
    const originalReadCommitSeqsForPull =
      countingDialect.readCommitSeqsForPull.bind(countingDialect);
    countingDialect.readCommitSeqsForPull = async (executor, args) => {
      readCommitSeqsForPullCalls += 1;
      return originalReadCommitSeqsForPull(executor, args);
    };

    const res = await pull({
      db,
      dialect: countingDialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'c1',
        schemaVersion: 1,
        limitCommits: 50,
        subscriptions: [
          {
            id: 's1',
            table: 'tasks',
            scopes: { user_id: 'u1' },
            cursor,
            crdtStateVectors: [],
          },
        ],
      },
    });

    expect(res.response.subscriptions[0]!.commits.length).toBe(2);
    expect(readCommitSeqsForPullCalls).toBe(0);
  });

  it('falls back to the commit-window scan when no incremental rows match scopes', async () => {
    const handlers = makeHandlers({
      resolveScopes: async (ctx) => ({ user_id: [ctx.actorId] }),
    });

    await pushTask(handlers, 'task-u1', 'User 1 Task', 'u1');

    const bootstrapRes = await pull({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'c1',
        schemaVersion: 1,
        limitCommits: 50,
        subscriptions: [
          {
            id: 's1',
            table: 'tasks',
            scopes: { user_id: 'u1' },
            cursor: -1,
            crdtStateVectors: [],
          },
        ],
      },
    });
    const cursor = bootstrapRes.response.subscriptions[0]!.nextCursor;

    await pushTask(handlers, 'task-u2', 'User 2 Task', 'u2', 'c2');
    const latestCommitSeq = await dialect.readMaxCommitSeq(db);

    const countingDialect = createSqliteServerDialect();
    let readCommitSeqsForPullCalls = 0;
    const originalReadCommitSeqsForPull =
      countingDialect.readCommitSeqsForPull.bind(countingDialect);
    countingDialect.readCommitSeqsForPull = async (executor, args) => {
      readCommitSeqsForPullCalls += 1;
      return originalReadCommitSeqsForPull(executor, args);
    };

    const res = await pull({
      db,
      dialect: countingDialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'c1',
        schemaVersion: 1,
        limitCommits: 50,
        subscriptions: [
          {
            id: 's1',
            table: 'tasks',
            scopes: { user_id: 'u1' },
            cursor,
            crdtStateVectors: [],
          },
        ],
      },
    });

    const sub = res.response.subscriptions[0]!;
    expect(sub.commits).toEqual([]);
    expect(sub.nextCursor).toBe(latestCommitSeq);
    expect(readCommitSeqsForPullCalls).toBe(1);
  });

  it('retries a transient serialization failure inside pull', async () => {
    const handlers = makeHandlers();
    await pushTask(handlers, 'task-1', 'First');

    const flakyDialect = createSqliteServerDialect();
    const originalExecuteInTransaction =
      flakyDialect.executeInTransaction.bind(flakyDialect);
    let attempts = 0;
    flakyDialect.executeInTransaction = async (executor, fn) => {
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(
          new Error('could not serialize access due to concurrent update'),
          {
            code: '40001',
          }
        );
      }
      return originalExecuteInTransaction(executor, fn);
    };

    const res = await pull({
      db,
      dialect: flakyDialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'c1',
        schemaVersion: 1,
        limitCommits: 50,
        subscriptions: [
          {
            id: 's1',
            table: 'tasks',
            scopes: { user_id: 'u1' },
            cursor: -1,
            crdtStateVectors: [],
          },
        ],
      },
    });

    expect(attempts).toBe(2);
    expect(res.response.subscriptions[0]?.bootstrap).toBe(true);
  });

  // -----------------------------------------------------------
  // No new commits
  // -----------------------------------------------------------

  it('returns empty commits and same cursor when no new data exists', async () => {
    const handlers = makeHandlers();
    await pushTask(handlers, 'task-1', 'First');

    // Bootstrap first
    const bootstrapRes = await pull({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'c1',
        schemaVersion: 1,
        limitCommits: 50,
        subscriptions: [
          {
            id: 's1',
            table: 'tasks',
            scopes: { user_id: 'u1' },
            cursor: -1,
            crdtStateVectors: [],
          },
        ],
      },
    });

    const cursor = bootstrapRes.response.subscriptions[0]!.nextCursor;

    // Pull again with same cursor, no new data
    const res = await pull({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'c1',
        schemaVersion: 1,
        limitCommits: 50,
        subscriptions: [
          {
            id: 's1',
            table: 'tasks',
            scopes: { user_id: 'u1' },
            cursor,
            crdtStateVectors: [],
          },
        ],
      },
    });

    const sub = res.response.subscriptions[0]!;
    expect(sub.commits).toEqual([]);
    expect(sub.nextCursor).toBe(cursor);
  });

  // -----------------------------------------------------------
  // Subscription revocation
  // -----------------------------------------------------------

  it('returns status revoked when resolveScopes returns empty scopes', async () => {
    // Handler with resolveScopes that returns empty (no access)
    const handlers = makeHandlers({
      resolveScopes: async () => ({ user_id: [] }),
    });

    await pushTask(
      makeHandlers(), // use normal handlers to push data
      'task-1',
      'First'
    );

    const res = await pull({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'c1',
        schemaVersion: 1,
        limitCommits: 10,
        subscriptions: [
          {
            id: 's1',
            table: 'tasks',
            scopes: { user_id: 'u1' },
            cursor: -1,
            crdtStateVectors: [],
          },
        ],
      },
    });

    const sub = res.response.subscriptions[0]!;
    expect(sub.status).toBe('revoked');
    expect(sub.scopes).toEqual({});
    expect(sub.commits).toEqual([]);
  });

  // -----------------------------------------------------------
  // Scope filtering
  // -----------------------------------------------------------

  it('returns only data matching the requested scopes', async () => {
    // Use a handler that allows both u1 and u2
    const handlers = makeHandlers({
      resolveScopes: async (ctx) => ({ user_id: [ctx.actorId] }),
    });

    // Push data for u1
    await pushTask(handlers, 'task-u1', 'User 1 Task', 'u1');

    // Push data for u2 (using separate push with u2 auth)
    await pushCommit({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u2' },
      request: {
        clientId: 'c2',
        clientCommitId: 'commit-u2-task',
        schemaVersion: 1,
        operations: [
          {
            table: 'tasks',
            row_id: 'task-u2',
            op: 'upsert',
            payload: { title: 'User 2 Task', user_id: 'u2' },
            base_version: null,
          },
        ],
      },
    });

    // Pull for u1 only
    const res = await pull({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'c1',
        schemaVersion: 1,
        limitCommits: 50,
        subscriptions: [
          {
            id: 's1',
            table: 'tasks',
            scopes: { user_id: 'u1' },
            cursor: -1,
            crdtStateVectors: [],
          },
        ],
      },
    });

    const sub = res.response.subscriptions[0]!;
    expect(sub.status).toBe('active');
    expect(sub.bootstrap).toBe(true);

    // Read snapshot data - should only contain u1's task
    const snapshot = sub.snapshots![0]!;
    const rows = (await readSnapshotRows(db, snapshot)) as TasksTable[];
    expect(rows.length).toBe(1);
    expect(rows[0]!.user_id).toBe('u1');
  });

  // -----------------------------------------------------------
  // Deduplication (dedupeRows=true)
  // -----------------------------------------------------------

  it('returns only the latest row version when dedupeRows is true', async () => {
    const handlers = makeHandlers();

    // Push initial task
    await pushTask(handlers, 'task-1', 'Version 1');

    // Bootstrap to get a cursor
    const bootstrapRes = await pull({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'c1',
        schemaVersion: 1,
        limitCommits: 50,
        subscriptions: [
          {
            id: 's1',
            table: 'tasks',
            scopes: { user_id: 'u1' },
            cursor: -1,
            crdtStateVectors: [],
          },
        ],
      },
    });
    const cursor = bootstrapRes.response.subscriptions[0]!.nextCursor;

    // Push multiple updates to the same row
    await pushTask(handlers, 'task-1', 'Version 2');
    await pushTask(handlers, 'task-1', 'Version 3');

    // Pull with dedupeRows=true
    const res = await pull({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'c1',
        schemaVersion: 1,
        limitCommits: 50,
        dedupeRows: true,
        subscriptions: [
          {
            id: 's1',
            table: 'tasks',
            scopes: { user_id: 'u1' },
            cursor,
            crdtStateVectors: [],
          },
        ],
      },
    });

    const sub = res.response.subscriptions[0]!;
    expect(sub.bootstrap).toBe(false);

    // With deduplication, only the latest version of task-1 should appear
    const allChanges = sub.commits.flatMap((c) => c.changes);
    const task1Changes = allChanges.filter((c) => c.row_id === 'task-1');
    expect(task1Changes.length).toBe(1);

    // The row should have the latest title
    const rowJson = task1Changes[0]!.row_json as TasksTable;
    expect(rowJson.title).toBe('Version 3');
  });

  // -----------------------------------------------------------
  // Deduplication disabled
  // -----------------------------------------------------------

  it('returns all intermediate changes when dedupeRows is false', async () => {
    const handlers = makeHandlers();

    // Push initial task
    await pushTask(handlers, 'task-1', 'Version 1');

    // Bootstrap to get a cursor
    const bootstrapRes = await pull({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'c1',
        schemaVersion: 1,
        limitCommits: 50,
        subscriptions: [
          {
            id: 's1',
            table: 'tasks',
            scopes: { user_id: 'u1' },
            cursor: -1,
            crdtStateVectors: [],
          },
        ],
      },
    });
    const cursor = bootstrapRes.response.subscriptions[0]!.nextCursor;

    // Push multiple updates to the same row
    await pushTask(handlers, 'task-1', 'Version 2');
    await pushTask(handlers, 'task-1', 'Version 3');

    // Pull with dedupeRows=false (default)
    const res = await pull({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'c1',
        schemaVersion: 1,
        limitCommits: 50,
        dedupeRows: false,
        subscriptions: [
          {
            id: 's1',
            table: 'tasks',
            scopes: { user_id: 'u1' },
            cursor,
            crdtStateVectors: [],
          },
        ],
      },
    });

    const sub = res.response.subscriptions[0]!;
    expect(sub.bootstrap).toBe(false);

    // Without deduplication, both updates should appear
    const allChanges = sub.commits.flatMap((c) => c.changes);
    const task1Changes = allChanges.filter((c) => c.row_id === 'task-1');
    expect(task1Changes.length).toBe(2);
  });

  // -----------------------------------------------------------
  // Limit enforcement
  // -----------------------------------------------------------

  it('returns at most limitCommits commits', async () => {
    const handlers = makeHandlers();

    // Push initial data and bootstrap
    await pushTask(handlers, 'task-0', 'Initial');
    const bootstrapRes = await pull({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'c1',
        schemaVersion: 1,
        limitCommits: 50,
        subscriptions: [
          {
            id: 's1',
            table: 'tasks',
            scopes: { user_id: 'u1' },
            cursor: -1,
            crdtStateVectors: [],
          },
        ],
      },
    });
    const cursor = bootstrapRes.response.subscriptions[0]!.nextCursor;

    // Push 5 more tasks
    for (let i = 1; i <= 5; i++) {
      await pushTask(handlers, `task-${i}`, `Task ${i}`);
    }

    // Pull with limitCommits=2
    const res = await pull({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'c1',
        schemaVersion: 1,
        limitCommits: 2,
        subscriptions: [
          {
            id: 's1',
            table: 'tasks',
            scopes: { user_id: 'u1' },
            cursor,
            crdtStateVectors: [],
          },
        ],
      },
    });

    const sub = res.response.subscriptions[0]!;
    expect(sub.commits.length).toBeLessThanOrEqual(2);
  });

  // -----------------------------------------------------------
  // Limit sanitization
  // -----------------------------------------------------------

  it('falls back to defaults for NaN, negative, and Infinity limitCommits', async () => {
    const handlers = makeHandlers();
    await pushTask(handlers, 'task-1', 'Task 1');

    // Test with NaN
    const resNaN = await pull({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'c1',
        schemaVersion: 1,
        limitCommits: Number.NaN,
        subscriptions: [
          {
            id: 's1',
            table: 'tasks',
            scopes: { user_id: 'u1' },
            cursor: -1,
            crdtStateVectors: [],
          },
        ],
      },
    });
    expect(resNaN.response.ok).toBe(true);

    // Test with negative
    const resNeg = await pull({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'c1',
        schemaVersion: 1,
        limitCommits: -5,
        subscriptions: [
          {
            id: 's1',
            table: 'tasks',
            scopes: { user_id: 'u1' },
            cursor: -1,
            crdtStateVectors: [],
          },
        ],
      },
    });
    expect(resNeg.response.ok).toBe(true);

    // Test with Infinity
    const resInf = await pull({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'c1',
        schemaVersion: 1,
        limitCommits: Number.POSITIVE_INFINITY,
        subscriptions: [
          {
            id: 's1',
            table: 'tasks',
            scopes: { user_id: 'u1' },
            cursor: -1,
            crdtStateVectors: [],
          },
        ],
      },
    });
    expect(resInf.response.ok).toBe(true);
  });

  // -----------------------------------------------------------
  // Multi-subscription pull
  // -----------------------------------------------------------

  it('handles multiple subscriptions with merged effective scopes', async () => {
    // Use a handler that allows all users (wildcard)
    const handlers = makeHandlers({
      resolveScopes: async () => ({ user_id: '*' }),
    });

    // Push data for two users
    await pushTask(handlers, 'task-u1', 'User 1 Task', 'u1');
    await pushCommit({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u2' },
      request: {
        clientId: 'c2',
        clientCommitId: 'commit-u2-multi',
        schemaVersion: 1,
        operations: [
          {
            table: 'tasks',
            row_id: 'task-u2',
            op: 'upsert',
            payload: { title: 'User 2 Task', user_id: 'u2' },
            base_version: null,
          },
        ],
      },
    });

    // Pull with two subscriptions for different scopes
    const res = await pull({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'c1',
        schemaVersion: 1,
        limitCommits: 50,
        subscriptions: [
          {
            id: 's1',
            table: 'tasks',
            scopes: { user_id: 'u1' },
            cursor: -1,
            crdtStateVectors: [],
          },
          {
            id: 's2',
            table: 'tasks',
            scopes: { user_id: 'u2' },
            cursor: -1,
            crdtStateVectors: [],
          },
        ],
      },
    });

    expect(res.response.ok).toBe(true);
    expect(res.response.subscriptions.length).toBe(2);

    const sub1 = res.response.subscriptions[0]!;
    const sub2 = res.response.subscriptions[1]!;
    expect(sub1.id).toBe('s1');
    expect(sub2.id).toBe('s2');
    expect(sub1.status).toBe('active');
    expect(sub2.status).toBe('active');

    // effectiveScopes should be merged from both subscriptions
    const mergedUserIds = res.effectiveScopes.user_id;
    expect(mergedUserIds).toBeDefined();
    if (Array.isArray(mergedUserIds)) {
      expect(mergedUserIds).toContain('u1');
      expect(mergedUserIds).toContain('u2');
    }
  });

  // -----------------------------------------------------------
  // Cursor beyond max commit triggers bootstrap
  // -----------------------------------------------------------

  it('triggers bootstrap when cursor is beyond max commit seq', async () => {
    const handlers = makeHandlers();
    await pushTask(handlers, 'task-1', 'Task 1');

    // Use a cursor far beyond any existing commit
    const res = await pull({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'c1',
        schemaVersion: 1,
        limitCommits: 10,
        subscriptions: [
          {
            id: 's1',
            table: 'tasks',
            scopes: { user_id: 'u1' },
            cursor: 999999,
            crdtStateVectors: [],
          },
        ],
      },
    });

    const sub = res.response.subscriptions[0]!;
    expect(sub.status).toBe('active');
    expect(sub.bootstrap).toBe(true);
    expect(sub.snapshots).toBeDefined();
  });

  // -----------------------------------------------------------
  // Client cursor tracking
  // -----------------------------------------------------------

  it('tracks minimum nextCursor across active subscriptions as clientCursor', async () => {
    // Use wildcard handler so both scopes are allowed
    const handlers = makeHandlers({
      resolveScopes: async () => ({ user_id: '*' }),
    });

    // Push data for u1 and u2
    await pushTask(handlers, 'task-u1', 'User 1 Task', 'u1');
    await pushCommit({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u2' },
      request: {
        clientId: 'c2',
        clientCommitId: 'commit-u2-cursor',
        schemaVersion: 1,
        operations: [
          {
            table: 'tasks',
            row_id: 'task-u2',
            op: 'upsert',
            payload: { title: 'User 2 Task', user_id: 'u2' },
            base_version: null,
          },
        ],
      },
    });

    // First bootstrap subscription s1 (it will get a nextCursor at current maxCommitSeq)
    const bootstrap1 = await pull({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'c1',
        schemaVersion: 1,
        limitCommits: 50,
        subscriptions: [
          {
            id: 's1',
            table: 'tasks',
            scopes: { user_id: 'u1' },
            cursor: -1,
            crdtStateVectors: [],
          },
        ],
      },
    });
    const cursor1 = bootstrap1.response.subscriptions[0]!.nextCursor;

    // Push more data
    await pushTask(handlers, 'task-u1-2', 'User 1 Task 2', 'u1');

    // Pull with two subscriptions at different cursors
    // s1 at the bootstrap cursor, s2 starting fresh at -1
    const res = await pull({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'c1',
        schemaVersion: 1,
        limitCommits: 50,
        subscriptions: [
          {
            id: 's1',
            table: 'tasks',
            scopes: { user_id: 'u1' },
            cursor: cursor1,
            crdtStateVectors: [],
          },
          {
            id: 's2',
            table: 'tasks',
            scopes: { user_id: 'u2' },
            cursor: -1,
            crdtStateVectors: [],
          },
        ],
      },
    });

    const sub1Cursor = res.response.subscriptions[0]!.nextCursor;
    const sub2Cursor = res.response.subscriptions[1]!.nextCursor;

    // clientCursor should be the minimum of the two nextCursors
    expect(res.clientCursor).toBe(Math.min(sub1Cursor, sub2Cursor));
  });

  // -----------------------------------------------------------
  // Bootstrap nextCursor equals asOfCommitSeq
  // -----------------------------------------------------------

  it('sets nextCursor to asOfCommitSeq during bootstrap', async () => {
    const handlers = makeHandlers();
    await pushTask(handlers, 'task-1', 'Task 1');
    await pushTask(handlers, 'task-2', 'Task 2');

    const res = await pull({
      db,
      dialect,
      handlers,
      auth: { actorId: 'u1' },
      request: {
        clientId: 'c1',
        schemaVersion: 1,
        limitCommits: 10,
        subscriptions: [
          {
            id: 's1',
            table: 'tasks',
            scopes: { user_id: 'u1' },
            cursor: -1,
            crdtStateVectors: [],
          },
        ],
      },
    });

    const sub = res.response.subscriptions[0]!;
    expect(sub.bootstrap).toBe(true);
    // The nextCursor should be a positive number equal to the maxCommitSeq at the time
    expect(sub.nextCursor).toBeGreaterThan(0);
  });
});
