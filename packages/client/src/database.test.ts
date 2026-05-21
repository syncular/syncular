import { describe, expect, it } from 'bun:test';
import {
  type BlobRef,
  createDatabase,
  type SyncOperation,
} from '@syncular/core';
import { Kysely, sql } from 'kysely';
import {
  ensureSyncularAppBaseSchema,
  ensureSyncularAppSchema,
  type SyncularAppDb,
  syncularGeneratedCodecs,
  syncularGeneratedSchemaVersion,
  syncularGeneratedTableConfig,
} from '../../../rust/examples/todo-app/generated/typescript/syncular.generated';
import { createBunSqliteDialect } from '../../dialect-bun-sqlite/src';
import { createServerHandler } from '../../server/src/handlers';
import type { SyncCoreDb } from '../../server/src/schema';
import {
  createSyncularV2BlobClient,
  createSyncularV2Commit,
  createSyncularV2Dialect,
  withSyncularV2SchemaWrites,
} from './database';
import type {
  SyncularV2Client,
  SyncularV2DiagnosticEvent,
  SyncularV2LiveQueryDependencyHint,
} from './types';

describe('Syncular v2 mutations', () => {
  it('keeps BlobRef mutation payloads app-shaped while encoding local SQLite rows', async () => {
    const batches: Array<
      Array<{ operation: SyncOperation; localRow?: unknown | null }>
    > = [];
    const commit = createSyncularV2Commit<SyncularAppDb>({
      client: {
        async applyMutation() {
          throw new Error('not used');
        },
        async applyMutationsBatch() {
          throw new Error('not used');
        },
        async applyMutationsCommit(batch) {
          batches.push(batch);
          return 'commit-blob-ref';
        },
      },
      codecs: syncularGeneratedCodecs,
    });
    const image = {
      hash: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
      size: 123,
      mimeType: 'image/png',
    };

    await commit(async (tx) => {
      await tx.tasks.insert({
        id: 'task-blob',
        title: 'Blob task',
        completed: 0,
        user_id: 'user-blob',
        image,
      });
    });

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1);
    const entry = batches[0]![0]!;
    expect(entry.operation.payload?.image).toEqual(image);
    expect((entry.localRow as Record<string, unknown>).image).toBe(
      JSON.stringify(image)
    );
  });

  it('uses generated soft-delete table config for browser mutation deletes', async () => {
    const batches: Array<
      Array<{ operation: SyncOperation; localRow?: unknown | null }>
    > = [];
    const baseVersionReads: Array<{
      table: string;
      rowId: string;
      idColumn: string;
      versionColumn: string;
    }> = [];
    const commit = createSyncularV2Commit<SyncularAppDb>({
      client: {
        async applyMutation() {
          throw new Error('not used');
        },
        async applyMutationsBatch() {
          throw new Error('not used');
        },
        async applyMutationsCommit(batch) {
          batches.push(batch);
          return 'commit-soft-delete';
        },
      },
      tableConfig: syncularGeneratedTableConfig,
      async readBaseVersion(args) {
        baseVersionReads.push(args);
        return 42;
      },
    });

    const result = await commit(async (tx) => {
      await tx.comments.delete('comment-soft-delete');
      return 'done';
    });

    expect(result.result).toBe('done');
    expect(result.meta.localMutations).toEqual([
      { table: 'comments', rowId: 'comment-soft-delete', op: 'upsert' },
    ]);
    expect(baseVersionReads).toEqual([
      {
        table: 'comments',
        rowId: 'comment-soft-delete',
        idColumn: 'id',
        versionColumn: 'server_version',
      },
    ]);
    expect(batches).toHaveLength(1);
    const entry = batches[0]![0]!;
    expect(entry.operation).toEqual({
      table: 'comments',
      row_id: 'comment-soft-delete',
      op: 'upsert',
      payload: { deleted: 1 },
      base_version: 42,
    });
    expect(entry.localRow).toEqual({ id: 'comment-soft-delete', deleted: 1 });
  });
});

describe('Syncular v2 blobs', () => {
  it('runs store hooks with the stored blob ref and options', async () => {
    const afterStores: unknown[] = [];
    const blobs = createSyncularV2BlobClient(
      {
        async storeBlob() {
          return {
            hash: 'sha256:3333333333333333333333333333333333333333333333333333333333333333',
            size: 3,
            mimeType: 'text/plain',
          };
        },
        async retrieveBlob() {
          return new Uint8Array();
        },
        async isBlobLocal() {
          return true;
        },
        async processBlobUploadQueue() {
          return { uploaded: 0, failed: 0 };
        },
        async blobUploadQueueStats() {
          return { pending: 0, uploading: 0, failed: 0 };
        },
        async blobCacheStats() {
          return { count: 0, totalBytes: 0 };
        },
        async pruneBlobCache() {
          return 0;
        },
        async clearBlobCache() {},
      },
      {
        afterStore: (args) => afterStores.push(args),
      }
    );

    const ref = await blobs.store(new Uint8Array([1, 2, 3]), {
      mimeType: 'text/plain',
    });

    expect(ref.mimeType).toBe('text/plain');
    expect(afterStores).toEqual([
      {
        ref,
        options: { mimeType: 'text/plain' },
      },
    ]);
  });

  it('rejects oversized blob-like inputs before arrayBuffer conversion', async () => {
    let converted = false;
    const diagnostics: SyncularV2DiagnosticEvent[] = [];
    const blobLike = {
      size: 3,
      async arrayBuffer() {
        converted = true;
        return new ArrayBuffer(3);
      },
    } as unknown as Blob;
    const blobs = createSyncularV2BlobClient(
      {
        async storeBlob() {
          throw new Error('storeBlob should not be called');
        },
        async retrieveBlob() {
          return new Uint8Array();
        },
        async isBlobLocal() {
          return true;
        },
        async processBlobUploadQueue() {
          return { uploaded: 0, failed: 0 };
        },
        async blobUploadQueueStats() {
          return { pending: 0, uploading: 0, failed: 0 };
        },
        async blobCacheStats() {
          return { count: 0, totalBytes: 0 };
        },
        async pruneBlobCache() {
          return 0;
        },
        async clearBlobCache() {},
      },
      {
        limits: { maxPayloadBytes: 2 },
        diagnostics: (event) => diagnostics.push(event),
      }
    );

    await expect(
      blobs.store(blobLike, { mimeType: 'application/octet-stream' })
    ).rejects.toMatchObject({
      code: 'blob.too_large',
      details: {
        operation: 'store',
        size: 3,
        maxPayloadBytes: 2,
        mimeType: 'application/octet-stream',
      },
    });
    expect(converted).toBe(false);
    expect(diagnostics.at(-1)).toMatchObject({
      source: 'blob',
      code: 'blob.too_large',
      details: { operation: 'store', size: 3, maxPayloadBytes: 2 },
    });
  });
});

describe('generated Syncular v2 codecs', () => {
  it('let server handlers store BlobRef columns as SQLite text and emit app-shaped rows', async () => {
    const db = createDatabase<ServerDb>({
      dialect: createBunSqliteDialect({ path: ':memory:' }),
      family: 'sqlite',
    });
    try {
      await db.schema
        .createTable('tasks')
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('title', 'text', (col) => col.notNull())
        .addColumn('user_id', 'text', (col) => col.notNull())
        .addColumn('image', 'text')
        .addColumn('server_version', 'integer', (col) =>
          col.notNull().defaultTo(0)
        )
        .execute();

      const handler = createServerHandler<ServerDb, ClientDb, 'tasks'>({
        table: 'tasks',
        scopes: ['user:{user_id}'],
        resolveScopes: async (ctx) => ({ user_id: [ctx.actorId] }),
        codecs: syncularGeneratedCodecs,
      });
      const image: BlobRef = {
        hash: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
        size: 456,
        mimeType: 'image/jpeg',
      };

      const applied = await handler.applyOperation(
        {
          db,
          trx: db,
          actorId: 'user-blob',
          auth: { actorId: 'user-blob' },
          clientId: 'client-blob',
          commitId: 'commit-blob',
          schemaVersion: syncularGeneratedSchemaVersion,
        },
        {
          table: 'tasks',
          row_id: 'task-blob',
          op: 'upsert',
          payload: {
            title: 'Server codec task',
            user_id: 'user-blob',
            image,
          },
          base_version: 0,
        },
        0
      );

      expect(applied.result).toEqual({ opIndex: 0, status: 'applied' });
      expect(applied.emittedChanges[0]?.row_json).toMatchObject({ image });

      const stored = await db
        .selectFrom('tasks')
        .select(['image'])
        .where('id', '=', 'task-blob')
        .executeTakeFirstOrThrow();
      expect(stored.image).toBe(JSON.stringify(image));

      const snapshot = await handler.snapshot(
        {
          db,
          actorId: 'user-blob',
          auth: { actorId: 'user-blob' },
          scopeValues: { user_id: 'user-blob' },
          cursor: null,
          limit: 10,
        },
        undefined
      );
      expect(snapshot.rows[0]).toMatchObject({ image });
    } finally {
      await db.destroy();
    }
  });
});

describe('Syncular v2 live query dependencies', () => {
  it('infers nested Kysely subquery dependencies from generated app tables', async () => {
    const probe = createLiveClientProbe();
    const dialect = createSyncularV2Dialect(probe.client, {
      appTables: ['tasks', 'comments'],
    });
    const db = new Kysely<LiveQueryDb>({ dialect });

    try {
      await dialect.live(
        db
          .selectFrom('tasks')
          .selectAll('tasks')
          .where((eb) =>
            eb.exists(
              eb
                .selectFrom('comments')
                .select('comments.id')
                .whereRef('comments.task_id', '=', 'tasks.id')
            )
          ),
        { onChange() {} }
      );
    } finally {
      await db.destroy();
    }

    expect(probe.subscriptions).toEqual([['tasks', 'comments']]);
  });

  it('filters CTE aliases while keeping their app-table dependencies', async () => {
    const probe = createLiveClientProbe();
    const dialect = createSyncularV2Dialect(probe.client, {
      appTables: ['tasks'],
    });
    const db = new Kysely<LiveQueryDb>({ dialect });

    try {
      await dialect.live(
        db
          .with('open_tasks', (qb) =>
            qb
              .selectFrom('tasks')
              .select(['id', 'title'])
              .where('completed', '=', 0)
          )
          .selectFrom('open_tasks')
          .select(['id', 'title']),
        { onChange() {} }
      );
    } finally {
      await db.destroy();
    }

    expect(probe.subscriptions).toEqual([['tasks']]);
  });

  it('passes primary-key live query row hints to the Rust subscription', async () => {
    const probe = createLiveClientProbe();
    const dialect = createSyncularV2Dialect(probe.client, {
      appTables: ['tasks'],
      tableConfig: { tasks: { primaryKeyColumn: 'id' } },
    });
    const db = new Kysely<LiveQueryDb>({ dialect });

    try {
      await dialect.live(
        db
          .selectFrom('tasks')
          .select(['id', 'title'])
          .where('id', '=', 'task-42')
          .where('completed', '=', 0),
        { onChange() {} }
      );
    } finally {
      await db.destroy();
    }

    expect(probe.subscriptions).toEqual([['tasks']]);
    expect(probe.hints).toEqual([[{ table: 'tasks', rowIds: ['task-42'] }]]);
  });

  it('does not infer row hints through disjunctive predicates', async () => {
    const probe = createLiveClientProbe();
    const dialect = createSyncularV2Dialect(probe.client, {
      appTables: ['tasks'],
      tableConfig: { tasks: { primaryKeyColumn: 'id' } },
    });
    const db = new Kysely<LiveQueryDb>({ dialect });

    try {
      await dialect.live(
        db
          .selectFrom('tasks')
          .select(['id', 'title'])
          .where((eb) =>
            eb.or([eb('id', '=', 'task-42'), eb('completed', '=', 0)])
          ),
        { onChange() {} }
      );
    } finally {
      await db.destroy();
    }

    expect(probe.hints).toEqual([[]]);
  });

  it('rejects explicit live query tables outside the generated app schema', async () => {
    const probe = createLiveClientProbe();
    const dialect = createSyncularV2Dialect(probe.client, {
      appTables: ['tasks'],
    });
    const db = new Kysely<LiveQueryDb>({ dialect });

    try {
      await expect(
        dialect.live(db.selectFrom('tasks').selectAll(), {
          tables: ['tasks', 'sync_outbox'],
          onChange() {},
        })
      ).rejects.toThrow('sync_outbox is not part of the generated app schema');
    } finally {
      await db.destroy();
    }
  });

  it('unsubscribes active Rust live queries when the dialect is destroyed', async () => {
    const probe = createLiveClientProbe();
    const dialect = createSyncularV2Dialect(probe.client, {
      appTables: ['tasks'],
    });
    const db = new Kysely<LiveQueryDb>({ dialect });

    await dialect.live(db.selectFrom('tasks').selectAll(), { onChange() {} });
    await dialect.destroyLiveQueries();
    await db.destroy();

    expect(probe.unsubscribed).toEqual(['query-1']);
  });
});

describe('generated Syncular v2 schema migrations', () => {
  it('advances older browser app schema metadata through generated app-only migrations', async () => {
    const db = new Kysely<SyncularAppDb>({
      dialect: createBunSqliteDialect({ path: ':memory:' }),
    });

    try {
      await ensureSyncularAppBaseSchema(db);
      await sql`
        insert into syncular_app_schema (schema_id, schema_version, updated_at)
        values ('syncular-app', 1, 1)
      `.execute(db);

      await ensureSyncularAppSchema(db);

      const state = await sql<{ schema_version: number }>`
        select schema_version
        from syncular_app_schema
        where schema_id = 'syncular-app'
      `.execute(db);
      expect(Number(state.rows[0]?.schema_version)).toBe(
        syncularGeneratedSchemaVersion
      );
    } finally {
      await db.destroy();
    }
  });
});

describe('Syncular v2 SQL boundary', () => {
  it('allows public Kysely reads', async () => {
    const probe = createSqlBoundaryProbe();
    const dialect = createSyncularV2Dialect(probe.client, {
      appTables: ['tasks'],
    });
    const db = new Kysely<LiveQueryDb>({ dialect });

    try {
      await expect(
        db
          .selectFrom('tasks')
          .select(['id', 'title'])
          .where('id', '=', 'task-read')
          .execute()
      ).resolves.toEqual([{ id: 'task-read', title: 'Read task' }]);
    } finally {
      await db.destroy();
    }

    expect(probe.readSql).toHaveLength(1);
    expect(probe.readSql[0]).toContain('select');
    expect(probe.unsafeSql).toEqual([]);
  });

  it('rejects public Kysely writes before they reach the client', async () => {
    const probe = createSqlBoundaryProbe();
    const dialect = createSyncularV2Dialect(probe.client, {
      appTables: ['tasks'],
    });
    const db = new Kysely<LiveQueryDb>({ dialect });

    try {
      await expect(
        db
          .insertInto('tasks')
          .values({ id: 'task-write', title: 'Write task', completed: 0 })
          .execute()
      ).rejects.toThrow('public SQL is read-only');
      await expect(
        db.updateTable('tasks').set({ title: 'Blocked' }).execute()
      ).rejects.toThrow('public SQL is read-only');
      await expect(
        db.deleteFrom('tasks').where('id', '=', 'task-write').execute()
      ).rejects.toThrow('public SQL is read-only');
      await expect(sql`delete from tasks`.execute(db)).rejects.toThrow(
        'public SQL is read-only'
      );
      await expect(
        db.schema.createTable('blocked').addColumn('id', 'text').execute()
      ).rejects.toThrow('public SQL is read-only');
    } finally {
      await db.destroy();
    }

    expect(probe.readSql).toEqual([]);
    expect(probe.unsafeSql).toEqual([]);
  });

  it('allows generated schema setup through the internal schema-write helper', async () => {
    const probe = createSqlBoundaryProbe();

    await withSyncularV2SchemaWrites({ client: probe.client }, async (db) => {
      await db.schema
        .createTable('schema_setup')
        .ifNotExists()
        .addColumn('id', 'text', (col) => col.primaryKey())
        .execute();
      await sql`
        insert into syncular_app_schema (schema_id, schema_version, updated_at)
        values ('test', 1, 1)
      `.execute(db);
    });

    expect(probe.readSql).toEqual([]);
    expect(
      probe.unsafeSql.some((query) => query.includes('create table'))
    ).toBe(true);
    expect(probe.unsafeSql.some((query) => query.includes('insert into'))).toBe(
      true
    );
  });
});

interface ServerTaskRow {
  id: string;
  title: string;
  user_id: string;
  image: string | null;
  server_version: number;
}

interface ClientTaskRow {
  id: string;
  title: string;
  user_id: string;
  image: BlobRef | null;
  server_version: number;
}

interface ServerDb extends SyncCoreDb {
  tasks: ServerTaskRow;
}

interface ClientDb {
  tasks: ClientTaskRow;
}

interface LiveTaskRow {
  id: string;
  title: string;
  completed: number;
}

interface LiveCommentRow {
  id: string;
  task_id: string;
  body: string;
}

interface LiveQueryDb {
  tasks: LiveTaskRow;
  comments: LiveCommentRow;
}

function createLiveClientProbe(): {
  client: SyncularV2Client;
  subscriptions: string[][];
  hints: SyncularV2LiveQueryDependencyHint[][];
  unsubscribed: string[];
} {
  const subscriptions: string[][] = [];
  const hints: SyncularV2LiveQueryDependencyHint[][] = [];
  const unsubscribed: string[] = [];
  const client = {
    async subscribeQuery(
      _sql: string,
      _params: readonly unknown[],
      tables: readonly string[],
      dependencyHints: readonly SyncularV2LiveQueryDependencyHint[] = []
    ) {
      subscriptions.push([...tables]);
      hints.push(dependencyHints.map((hint) => ({ ...hint })));
      return { id: `query-${subscriptions.length}`, rows: [] };
    },
    async unsubscribeQuery(id: string) {
      unsubscribed.push(id);
    },
    addLiveQueryListener() {},
    removeLiveQueryListener() {},
    async drainLiveQueryEvents() {
      return [];
    },
    async close() {},
  } as unknown as SyncularV2Client;
  return { client, subscriptions, hints, unsubscribed };
}

function createSqlBoundaryProbe(): {
  client: SyncularV2Client & {
    executeUnsafeSql(
      sql: string,
      params?: readonly unknown[]
    ): Promise<{ rows: Record<string, unknown>[] }>;
  };
  readSql: string[];
  unsafeSql: string[];
} {
  const readSql: string[] = [];
  const unsafeSql: string[] = [];
  const client = {
    async executeSql(query: string) {
      readSql.push(query);
      return { rows: [{ id: 'task-read', title: 'Read task' }] };
    },
    async executeUnsafeSql(query: string) {
      unsafeSql.push(query);
      return { rows: [] };
    },
    async subscribeQuery() {
      return { id: 'query-unused', rows: [] };
    },
    async unsubscribeQuery() {},
    addLiveQueryListener() {},
    removeLiveQueryListener() {},
    async drainLiveQueryEvents() {
      return [];
    },
    async close() {},
  } as unknown as SyncularV2Client & {
    executeUnsafeSql(
      sql: string,
      params?: readonly unknown[]
    ): Promise<{ rows: Record<string, unknown>[] }>;
  };
  return { client, readSql, unsafeSql };
}
