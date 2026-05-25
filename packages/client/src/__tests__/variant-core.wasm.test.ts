import { describe, expect, it } from 'bun:test';
import { type BlobRef, codecs } from '@syncular/core';
import { type Kysely, sql } from 'kysely';
import { syncularGeneratedApp as todoGeneratedClientApp } from '../../../../rust/examples/todo-app/generated/typescript/syncular.generated';
import {
  createSyncularAppServerHandler as createTodoAppServerHandler,
  type SyncularGeneratedClientSchemaMetadata as TodoGeneratedClientSchemaMetadata,
  syncularGeneratedClientSchemaForVersion as todoGeneratedClientSchemaForVersion,
  syncularGeneratedClientSchemaSupport as todoGeneratedClientSchemaSupport,
  syncularGeneratedSchemaVersion as todoGeneratedSchemaVersion,
  syncularGeneratedApp as todoGeneratedServerApp,
  syncularProjectGeneratedClientRowForVersion as todoProjectGeneratedClientRowForVersion,
} from '../../../../rust/examples/todo-app/generated/typescript/syncular.server.generated';
import {
  createServerHandler,
  createServerHandlerCollection,
  pushCommit,
  type SyncCoreDb,
} from '../../../server/src';
import { createHttpServerFixture } from '../../../testkit/src/http-fixtures';
import {
  createSyncularDatabase,
  type SyncularDatabase,
  withSyncularSchemaWrites,
} from '../database';
import type {
  SyncularAppSchema,
  SyncularAuthLeaseRecord,
  SyncularRuntimeArtifactCandidate,
  SyncularSubscriptionSpec,
  SyncularUnsafeSqlClient,
} from '../types';
import { getSyncularRuntimeArtifact } from '../wasm-runtime';

interface BasicTaskRow {
  id: string;
  title: string;
  user_id: string;
  server_version: number;
}

interface BasicDb {
  basic_tasks: BasicTaskRow;
}

interface BasicServerDb extends SyncCoreDb {
  basic_tasks: BasicTaskRow;
}

interface BasicClientDb {
  basic_tasks: BasicTaskRow;
}

interface FileVersionServerRow {
  id: string;
  file_id: string;
  owner_id: string;
  blob_ref: string;
  content_hash: string;
  byte_size: number;
  server_version: number;
}

interface FileVersionClientRow extends Omit<FileVersionServerRow, 'blob_ref'> {
  blob_ref: BlobRef;
}

interface FileAssetDb {
  file_versions: FileVersionClientRow;
}

interface FileAssetServerDb extends SyncCoreDb {
  file_versions: FileVersionServerRow;
}

interface FileAssetClientDb {
  file_versions: FileVersionClientRow;
}

interface GeneratedTodoTaskCurrentServerRow {
  id: string;
  title: string;
  completed: number;
  user_id: string;
  project_id: string | null;
  server_version: number;
  image: string | null;
  title_yjs_state: string | null;
  description: string | null;
}

interface GeneratedTodoServerDb extends SyncCoreDb {
  tasks: GeneratedTodoTaskCurrentServerRow;
}

interface GeneratedTodoCurrentClientDb {
  tasks: GeneratedTodoTaskCurrentServerRow;
}

interface GeneratedTodoTaskV6ClientRow
  extends Omit<GeneratedTodoTaskCurrentServerRow, 'image' | 'description'> {
  image: BlobRef | null;
}

interface GeneratedTodoV6ClientDb {
  tasks: GeneratedTodoTaskV6ClientRow;
}

const basicAppSchema: SyncularAppSchema = {
  schemaVersion: 1,
  tables: [
    {
      name: 'basic_tasks',
      primaryKeyColumn: 'id',
      serverVersionColumn: 'server_version',
      softDeleteColumn: null,
      subscriptionId: 'sub-basic-tasks',
      columns: [
        {
          name: 'id',
          typeFamily: 'text',
          notnullRequired: false,
          primaryKey: true,
        },
        {
          name: 'title',
          typeFamily: 'text',
          notnullRequired: true,
          primaryKey: false,
        },
        {
          name: 'user_id',
          typeFamily: 'text',
          notnullRequired: true,
          primaryKey: false,
        },
        {
          name: 'server_version',
          typeFamily: 'integer',
          notnullRequired: true,
          primaryKey: false,
        },
      ],
      blobColumns: [],
      crdtYjsFields: [],
      encryptedFields: [],
      scopes: [
        {
          name: 'user_id',
          column: 'user_id',
          source: 'actorId',
          required: true,
        },
      ],
    },
  ],
};

const basicAppSchemaWithMigrations: SyncularAppSchema = {
  ...basicAppSchema,
  migrations: [
    {
      version: '0001',
      schemaVersion: 1,
      name: 'create_basic_tasks',
      upSql: `
        CREATE TABLE IF NOT EXISTS basic_tasks (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          user_id TEXT NOT NULL,
          server_version INTEGER NOT NULL DEFAULT 0
        ) WITHOUT ROWID;
      `,
    },
  ],
};

const crdtAppSchema: SyncularAppSchema = {
  schemaVersion: 1,
  tables: [
    {
      ...basicAppSchema.tables[0]!,
      crdtYjsFields: [
        {
          field: 'title',
          stateColumn: 'title_yjs_state',
          containerKey: 'title',
          rowIdField: 'id',
          kind: 'text',
          syncMode: 'server-merge',
        },
      ],
    },
  ],
};

const blobAppSchema: SyncularAppSchema = {
  schemaVersion: 1,
  tables: [
    {
      ...basicAppSchema.tables[0]!,
      columns: [
        ...basicAppSchema.tables[0]!.columns,
        {
          name: 'image',
          typeFamily: 'text',
          notnullRequired: false,
          primaryKey: false,
        },
      ],
      blobColumns: ['image'],
    },
  ],
};

const fileVersionAppSchema: SyncularAppSchema = {
  schemaVersion: 1,
  tables: [
    {
      name: 'file_versions',
      primaryKeyColumn: 'id',
      serverVersionColumn: 'server_version',
      softDeleteColumn: null,
      subscriptionId: 'sub-file-versions',
      columns: [
        {
          name: 'id',
          typeFamily: 'text',
          notnullRequired: false,
          primaryKey: true,
        },
        {
          name: 'file_id',
          typeFamily: 'text',
          notnullRequired: true,
          primaryKey: false,
        },
        {
          name: 'owner_id',
          typeFamily: 'text',
          notnullRequired: true,
          primaryKey: false,
        },
        {
          name: 'blob_ref',
          typeFamily: 'text',
          notnullRequired: true,
          primaryKey: false,
        },
        {
          name: 'content_hash',
          typeFamily: 'text',
          notnullRequired: true,
          primaryKey: false,
        },
        {
          name: 'byte_size',
          typeFamily: 'integer',
          notnullRequired: true,
          primaryKey: false,
        },
        {
          name: 'server_version',
          typeFamily: 'integer',
          notnullRequired: true,
          primaryKey: false,
        },
      ],
      blobColumns: ['blob_ref'],
      crdtYjsFields: [],
      encryptedFields: [],
      scopes: [
        {
          name: 'owner_id',
          column: 'owner_id',
          source: 'actorId',
          required: true,
        },
      ],
    },
  ],
};

describe('Syncular core WASM artifact', () => {
  it('applies embedded app schema migrations during Rust WASM open', async () => {
    const syncular = await createSyncularDatabase<BasicDb>({
      config: {
        baseUrl: 'http://127.0.0.1:1/sync',
        actorId: 'actor-core',
        clientId: `client-core-migrated-${Date.now()}`,
        storage: 'memory',
        clearOnInit: true,
        appSchema: basicAppSchemaWithMigrations,
      },
      appTables: ['basic_tasks'],
      tableConfig: {
        basic_tasks: {
          primaryKeyColumn: 'id',
          serverVersionColumn: 'server_version',
        },
      },
      requiredRuntimeFeatures: ['web-owned-sqlite-core'],
      runtimeArtifacts: [coreRuntimeArtifact()],
    });

    try {
      await expect(syncular.client.generatedSchemaState()).resolves.toEqual({
        schemaId: 'syncular-app',
        schemaVersion: 1,
        currentSchemaVersion: 1,
        updatedAt: expect.any(Number),
      });

      await syncular.mutations.basic_tasks.insert({
        id: 'task-runtime-migrated',
        title: 'Runtime migrated task',
        user_id: 'actor-core',
        server_version: 0,
      });

      await expect(
        syncular.db
          .selectFrom('basic_tasks')
          .select(['id', 'title', 'user_id', 'server_version'])
          .execute()
      ).resolves.toEqual([
        {
          id: 'task-runtime-migrated',
          title: 'Runtime migrated task',
          user_id: 'actor-core',
          server_version: 0,
        },
      ]);
    } finally {
      await syncular.close();
    }
  });

  it('opens a generated local-sync-compatible client without a server', async () => {
    const actorId = 'actor-generated-local';
    const projectId = 'project-generated-local';
    const syncular = await createSyncularDatabase<GeneratedTodoCurrentClientDb>(
      {
        config: {
          mode: 'local-sync-compatible',
          actorId,
          projectId,
          clientId: `client-generated-local-${Date.now()}`,
          storage: 'memory',
          clearOnInit: true,
          schemaVersion: todoGeneratedSchemaVersion,
          appSchema: todoGeneratedClientApp.appSchema,
        },
        codecs: todoGeneratedClientApp.codecs,
        appTables: todoGeneratedClientApp.tableNames,
        tableConfig: todoGeneratedClientApp.tableConfig,
        requiredRuntimeFeatures: ['web-owned-sqlite'],
      }
    );

    try {
      await syncular.mutations.tasks.insert({
        id: 'generated-local-task-1',
        title: 'Local generated task',
        completed: 0,
        user_id: actorId,
        project_id: projectId,
        server_version: 0,
        image: null,
        title_yjs_state: null,
        description: 'local-only until remote is attached',
      });

      await expect(
        syncular.db
          .selectFrom('tasks')
          .select(['id', 'title', 'description'])
          .execute()
      ).resolves.toEqual([
        {
          id: 'generated-local-task-1',
          title: 'Local generated task',
          description: 'local-only until remote is attached',
        },
      ]);
      const unsafe = syncular.client as unknown as SyncularUnsafeSqlClient;
      const outboxRows = await unsafe.executeUnsafeSql<{
        status: string;
        schema_version: number;
      }>(
        'select status, schema_version from sync_outbox_commits order by created_at'
      );
      expect(outboxRows.rows).toEqual([
        { status: 'pending', schema_version: todoGeneratedSchemaVersion },
      ]);
      await expect(syncular.client.syncOnce()).rejects.toThrow(
        'requires remote mode'
      );
    } finally {
      await syncular.close();
    }
  });

  it('opens a basic SQLite app schema without CRDT or E2EE', async () => {
    const syncular = await createSyncularDatabase<BasicDb>({
      config: {
        baseUrl: 'http://127.0.0.1:1/sync',
        actorId: 'actor-core',
        clientId: `client-core-${Date.now()}`,
        storage: 'memory',
        clearOnInit: true,
        appSchema: basicAppSchema,
      },
      appTables: ['basic_tasks'],
      tableConfig: {
        basic_tasks: {
          primaryKeyColumn: 'id',
          serverVersionColumn: 'server_version',
        },
      },
      requiredRuntimeFeatures: ['web-owned-sqlite-core'],
      runtimeArtifacts: [coreRuntimeArtifact()],
    });

    try {
      const runtimeInfo = await syncular.client.runtimeInfo();
      expect(runtimeInfo.rust?.features).toContain('web-owned-sqlite-core');
      expect(runtimeInfo.rust?.features).not.toContain('blobs');
      expect(runtimeInfo.rust?.features).not.toContain('crdt-yjs');
      expect(runtimeInfo.wasmUrl).toContain('/dist/wasm-core/');

      await withSyncularSchemaWrites(syncular, async (db) => {
        await db.schema
          .createTable('basic_tasks')
          .ifNotExists()
          .addColumn('id', 'text', (col) => col.primaryKey())
          .addColumn('title', 'text', (col) => col.notNull())
          .addColumn('user_id', 'text', (col) => col.notNull())
          .addColumn('server_version', 'integer', (col) =>
            col.notNull().defaultTo(0)
          )
          .execute();
      });

      await syncular.mutations.basic_tasks.insert({
        id: 'task-core',
        title: 'Core artifact task',
        user_id: 'actor-core',
        server_version: 0,
      });

      await expect(
        syncular.db
          .selectFrom('basic_tasks')
          .select(['id', 'title', 'user_id', 'server_version'])
          .execute()
      ).resolves.toEqual([
        {
          id: 'task-core',
          title: 'Core artifact task',
          user_id: 'actor-core',
          server_version: 0,
        },
      ]);

      await expect(
        syncular.leasedMutations.basic_tasks.insert({
          id: 'task-core-leased-missing',
          title: 'Missing leased task',
          user_id: 'actor-core',
          server_version: 0,
        })
      ).rejects.toThrow('sync.auth_lease_missing');
      await expect(
        syncular.db
          .selectFrom('basic_tasks')
          .select(['id'])
          .where('id', '=', 'task-core-leased-missing')
          .execute()
      ).resolves.toEqual([]);

      await syncular.client.upsertAuthLease(
        authLease({
          leaseId: 'lease-core-expired',
          actorId: 'actor-core',
          table: 'basic_tasks',
          values: { user_id: 'actor-core' },
          operations: ['upsert'],
          schemaVersion: basicAppSchema.schemaVersion,
          expiresAtMs: Date.now() - 1_000,
        })
      );
      await expect(
        syncular.client.activeAuthLeases('actor-core', Date.now())
      ).resolves.toEqual([]);
      await expect(
        syncular.leasedMutations.basic_tasks.insert({
          id: 'task-core-leased-expired',
          title: 'Expired leased task',
          user_id: 'actor-core',
          server_version: 0,
        })
      ).rejects.toThrow('sync.auth_lease_expired');
      const expiredRows = await syncular.db
        .selectFrom('basic_tasks')
        .select(['id'])
        .where('id', '=', 'task-core-leased-expired')
        .execute();
      expect(expiredRows).toEqual([]);

      await syncular.client.upsertAuthLease(
        authLease({
          leaseId: 'lease-core-active',
          actorId: 'actor-core',
          table: 'basic_tasks',
          values: { user_id: 'actor-core' },
          operations: ['upsert'],
          schemaVersion: basicAppSchema.schemaVersion,
        })
      );
      await syncular.leasedMutations.basic_tasks.insert({
        id: 'task-core-leased',
        title: 'Core artifact leased task',
        user_id: 'actor-core',
        server_version: 0,
      });
      await expect(
        syncular.db
          .selectFrom('basic_tasks')
          .select(['id', 'title', 'user_id', 'server_version'])
          .where('id', '=', 'task-core-leased')
          .execute()
      ).resolves.toEqual([
        {
          id: 'task-core-leased',
          title: 'Core artifact leased task',
          user_id: 'actor-core',
          server_version: 0,
        },
      ]);
    } finally {
      await syncular.close();
    }
  });

  it('syncs a basic SQLite schema through the Hono server routes', async () => {
    const actorId = 'actor-core-sync';
    const token = 'token-core-sync';
    const server = await createHttpServerFixture<BasicServerDb>({
      serverDialect: 'sqlite',
      createTables: ensureBasicServerTables,
      handlers: [
        createServerHandler<BasicServerDb, BasicClientDb, 'basic_tasks'>({
          table: 'basic_tasks',
          scopes: ['user:{user_id}'],
          resolveScopes: async (ctx) => ({ user_id: [ctx.actorId] }),
        }),
      ],
      authenticate: async (c) => {
        const authorization = c.req.header('authorization');
        return authorization === token ? { actorId } : null;
      },
    });
    const clients: SyncularDatabase<BasicDb>[] = [];

    try {
      const writer = await openBasicCoreDatabase({
        baseUrl: `${server.baseUrl}/sync`,
        actorId,
        clientId: `client-core-writer-${Date.now()}`,
        token,
      });
      clients.push(writer);
      const reader = await openBasicCoreDatabase({
        baseUrl: `${server.baseUrl}/sync`,
        actorId,
        clientId: `client-core-reader-${Date.now()}`,
        token,
      });
      clients.push(reader);

      await writer.mutations.basic_tasks.insert({
        id: 'task-core-sync',
        title: 'Core artifact synced task',
        user_id: actorId,
        server_version: 0,
      });

      await expect(writer.client.syncPush()).resolves.toMatchObject({
        pushedCommits: 1,
      });
      await expect(
        server.db
          .selectFrom('basic_tasks')
          .select(['id', 'title', 'user_id'])
          .where('id', '=', 'task-core-sync')
          .executeTakeFirstOrThrow()
      ).resolves.toEqual({
        id: 'task-core-sync',
        title: 'Core artifact synced task',
        user_id: actorId,
      });

      await expect(reader.client.syncPull()).resolves.toMatchObject({
        changedTables: ['basic_tasks'],
        pushedCommits: 0,
      });
      await expect(
        reader.db
          .selectFrom('basic_tasks')
          .select(['id', 'title', 'user_id'])
          .execute()
      ).resolves.toEqual([
        {
          id: 'task-core-sync',
          title: 'Core artifact synced task',
          user_id: actorId,
        },
      ]);
    } finally {
      while (clients.length > 0) await clients.pop()!.close();
      await server.destroy();
    }
  });

  it('applies generated old-client bootstrap chunks without current-only columns', async () => {
    const actorId = 'actor-generated-old-client';
    const token = 'token-generated-old-client';
    const projectId = 'project-generated-old-client';
    const oldSchemaVersion = todoGeneratedClientSchemaSupport.minSupported;
    const oldTaskColumns = todoGeneratedClientSchemaForVersion(oldSchemaVersion)
      ?.tables.find((table) => table.name === 'tasks')
      ?.columns.map((column) => column.name);
    expect(oldTaskColumns).toContain('title_yjs_state');
    expect(oldTaskColumns).not.toContain('description');

    const server = await createHttpServerFixture<GeneratedTodoServerDb>({
      serverDialect: 'sqlite',
      createTables: ensureGeneratedTodoServerTables,
      handlers: [
        createTodoAppServerHandler<GeneratedTodoServerDb>({
          table: todoGeneratedServerApp.tables.tasks,
          resolveScopes: async (ctx) => ({
            user_id: [ctx.actorId],
            project_id: [projectId],
          }),
          async snapshot(ctx) {
            const rows = await ctx.db
              .selectFrom('tasks')
              .select([
                'id',
                'title',
                'completed',
                'user_id',
                'project_id',
                'server_version',
                'image',
                'title_yjs_state',
                'description',
              ])
              .where('user_id', '=', ctx.actorId)
              .where('project_id', '=', projectId)
              .execute();
            return {
              rows: rows.map((row) =>
                todoProjectGeneratedClientRowForVersion(
                  'tasks',
                  row,
                  ctx.schemaVersion
                )
              ),
              nextCursor: null,
            };
          },
          async applyOperation(_ctx, _op, opIndex) {
            return {
              result: {
                opIndex,
                status: 'error',
                error: 'read-only generated old-client fixture',
                retriable: false,
              },
              emittedChanges: [],
            };
          },
        }),
      ],
      authenticate: async (c) => {
        const authorization = c.req.header('authorization');
        return authorization === token ? { actorId } : null;
      },
      sync: {
        latestSchemaVersion: todoGeneratedSchemaVersion,
      },
    });
    let oldClient: SyncularDatabase<GeneratedTodoV6ClientDb> | null = null;

    try {
      await server.db
        .insertInto('tasks')
        .values({
          id: 'generated-task-1',
          title: 'Visible to generated old client',
          completed: 0,
          user_id: actorId,
          project_id: projectId,
          server_version: todoGeneratedSchemaVersion,
          image: null,
          title_yjs_state: null,
          description: 'current-only-description',
        })
        .execute();

      oldClient = await openGeneratedTodoOldClient({
        baseUrl: `${server.baseUrl}/sync`,
        actorId,
        projectId,
        schemaVersion: oldSchemaVersion,
        clientId: `client-generated-v${oldSchemaVersion}-${Date.now()}`,
        token,
      });

      const pullResult = await oldClient.client.syncPull();
      expect(pullResult).toMatchObject({
        changedTables: ['tasks'],
        pushedCommits: 0,
      });
      await expect(
        oldClient.db
          .selectFrom('tasks')
          .select([
            'id',
            'title',
            'completed',
            'user_id',
            'project_id',
            'server_version',
          ])
          .execute()
      ).resolves.toEqual([
        {
          id: 'generated-task-1',
          title: 'Visible to generated old client',
          completed: 0,
          user_id: actorId,
          project_id: projectId,
          server_version: todoGeneratedSchemaVersion,
        },
      ]);
    } finally {
      await oldClient?.close();
      await server.destroy();
    }
  });

  it('applies generated old-client incremental pulls without current-only columns', async () => {
    const actorId = 'actor-generated-old-client-incremental';
    const token = 'token-generated-old-client-incremental';
    const projectId = 'project-generated-old-client-incremental';
    const oldSchemaVersion = todoGeneratedClientSchemaSupport.minSupported;
    const taskId = 'generated-incremental-task-1';
    const handler = createTodoAppServerHandler<GeneratedTodoServerDb>({
      table: todoGeneratedServerApp.tables.tasks,
      resolveScopes: async (ctx) => ({
        user_id: [ctx.actorId],
        project_id: [projectId],
      }),
      async snapshot(ctx) {
        const rows = await ctx.db
          .selectFrom('tasks')
          .select([
            'id',
            'title',
            'completed',
            'user_id',
            'project_id',
            'server_version',
            'image',
            'title_yjs_state',
            'description',
          ])
          .where('user_id', '=', ctx.actorId)
          .where('project_id', '=', projectId)
          .execute();
        return {
          rows: rows.map((row) =>
            todoProjectGeneratedClientRowForVersion(
              'tasks',
              row,
              ctx.schemaVersion
            )
          ),
          nextCursor: null,
        };
      },
      async applyOperation(ctx, op, opIndex) {
        if (op.op !== 'upsert') {
          return {
            result: {
              opIndex,
              status: 'error',
              error: 'only upsert is supported in this fixture',
              retriable: false,
            },
            emittedChanges: [],
          };
        }
        const payload =
          op.payload &&
          typeof op.payload === 'object' &&
          !Array.isArray(op.payload)
            ? (op.payload as Record<string, unknown>)
            : {};
        const existing = await ctx.trx
          .selectFrom('tasks')
          .select('server_version')
          .where('id', '=', op.row_id)
          .executeTakeFirst();
        const nextVersion = Number(existing?.server_version ?? 0) + 1;
        const row: GeneratedTodoTaskCurrentServerRow = {
          id: op.row_id,
          title: String(payload.title ?? 'Incremental server title'),
          completed: Number(payload.completed ?? 0),
          user_id: String(payload.user_id ?? ctx.actorId),
          project_id:
            payload.project_id == null ? projectId : String(payload.project_id),
          server_version: nextVersion,
          image: null,
          title_yjs_state: null,
          description: String(
            payload.description ?? 'current-only incremental description'
          ),
        };
        await ctx.trx
          .insertInto('tasks')
          .values(row)
          .onConflict((oc) =>
            oc.column('id').doUpdateSet({
              title: row.title,
              completed: row.completed,
              user_id: row.user_id,
              project_id: row.project_id,
              server_version: row.server_version,
              image: row.image,
              title_yjs_state: row.title_yjs_state,
              description: row.description,
            })
          )
          .execute();
        return {
          result: { opIndex, status: 'applied' },
          emittedChanges: [
            {
              table: 'tasks',
              row_id: row.id,
              op: 'upsert',
              row_json: row,
              row_version: row.server_version,
              scopes: { user_id: row.user_id, project_id: row.project_id },
            },
          ],
        };
      },
    });
    const handlers = [handler];
    const handlerCollection =
      createServerHandlerCollection<GeneratedTodoServerDb>(handlers);
    const server = await createHttpServerFixture<GeneratedTodoServerDb>({
      serverDialect: 'sqlite',
      createTables: ensureGeneratedTodoServerTables,
      handlers,
      authenticate: async (c) => {
        const authorization = c.req.header('authorization');
        return authorization === token ? { actorId } : null;
      },
      sync: {
        latestSchemaVersion: todoGeneratedSchemaVersion,
      },
    });
    let oldClient: SyncularDatabase<GeneratedTodoV6ClientDb> | null = null;

    try {
      await server.db
        .insertInto('tasks')
        .values({
          id: taskId,
          title: 'Initial old-client title',
          completed: 0,
          user_id: actorId,
          project_id: projectId,
          server_version: 1,
          image: null,
          title_yjs_state: null,
          description: 'initial current-only description',
        })
        .execute();

      oldClient = await openGeneratedTodoOldClient({
        baseUrl: `${server.baseUrl}/sync`,
        actorId,
        projectId,
        schemaVersion: oldSchemaVersion,
        clientId: `client-generated-incremental-v${oldSchemaVersion}-${Date.now()}`,
        token,
      });

      await expect(oldClient.client.syncPull()).resolves.toMatchObject({
        changedTables: ['tasks'],
      });

      await pushCommit({
        db: server.db,
        dialect: server.dialect,
        handlers: handlerCollection,
        auth: { actorId },
        request: {
          clientId: 'current-schema-writer',
          clientCommitId: `current-schema-writer-${Date.now()}`,
          schemaVersion: todoGeneratedSchemaVersion,
          operations: [
            {
              table: 'tasks',
              row_id: taskId,
              op: 'upsert',
              payload: {
                title: 'Incremental title visible to v6',
                completed: 1,
                user_id: actorId,
                project_id: projectId,
                description: 'incremental current-only description',
              },
              base_version: null,
            },
          ],
        },
      });

      await expect(oldClient.client.syncPull()).resolves.toMatchObject({
        changedTables: ['tasks'],
      });
      await expect(
        oldClient.db
          .selectFrom('tasks')
          .select([
            'id',
            'title',
            'completed',
            'user_id',
            'project_id',
            'server_version',
          ])
          .execute()
      ).resolves.toEqual([
        {
          id: taskId,
          title: 'Incremental title visible to v6',
          completed: 1,
          user_id: actorId,
          project_id: projectId,
          server_version: 2,
        },
      ]);
      const unsafe = oldClient.client as unknown as SyncularUnsafeSqlClient;
      const columns = await unsafe.executeUnsafeSql<{ name: string }>(
        'pragma table_info("tasks")'
      );
      expect(columns.rows.map((row) => row.name)).not.toContain('description');
    } finally {
      await oldClient?.close();
      await server.destroy();
    }
  });

  it('classifies unsupported generated old-client schemas as upgrade-required', async () => {
    const actorId = 'actor-generated-unsupported-client';
    const token = 'token-generated-unsupported-client';
    const projectId = 'project-generated-unsupported-client';
    const unsupportedSchemaVersion =
      todoGeneratedClientSchemaSupport.minSupported - 1;
    let snapshotCalled = false;
    const server = await createHttpServerFixture<GeneratedTodoServerDb>({
      serverDialect: 'sqlite',
      createTables: ensureGeneratedTodoServerTables,
      handlers: [
        createTodoAppServerHandler<GeneratedTodoServerDb>({
          table: todoGeneratedServerApp.tables.tasks,
          resolveScopes: async (ctx) => ({
            user_id: [ctx.actorId],
            project_id: [projectId],
          }),
          async snapshot() {
            snapshotCalled = true;
            return { rows: [], nextCursor: null };
          },
          async applyOperation(_ctx, _op, opIndex) {
            return {
              result: {
                opIndex,
                status: 'error',
                error: 'read-only generated unsupported-client fixture',
                retriable: false,
              },
              emittedChanges: [],
            };
          },
        }),
      ],
      authenticate: async (c) => {
        const authorization = c.req.header('authorization');
        return authorization === token ? { actorId } : null;
      },
      sync: {
        latestSchemaVersion: todoGeneratedSchemaVersion,
      },
    });
    let oldClient: SyncularDatabase<GeneratedTodoV6ClientDb> | null = null;

    try {
      oldClient = await openGeneratedTodoOldClient({
        baseUrl: `${server.baseUrl}/sync`,
        actorId,
        projectId,
        schemaVersion: unsupportedSchemaVersion,
        appSchema: generatedTodoUnsupportedAppSchemaForVersion(
          unsupportedSchemaVersion
        ),
        clientId: `client-generated-v${unsupportedSchemaVersion}-${Date.now()}`,
        token,
      });

      await expect(oldClient.client.syncPull()).rejects.toMatchObject({
        code: 'sync.client_schema_unsupported',
        recommendedAction: 'upgradeClient',
        retryable: false,
      });
      expect(snapshotCalled).toBe(false);
    } finally {
      await oldClient?.close();
      await server.destroy();
    }
  });

  it('syncs file-version BlobRef rows through Hono and clears them on revocation', async () => {
    const actorId = 'actor-file-assets';
    const token = 'token-file-assets';
    const server = await createHttpServerFixture<FileAssetServerDb>({
      serverDialect: 'sqlite',
      createTables: ensureFileAssetServerTables,
      handlers: [
        createServerHandler<
          FileAssetServerDb,
          FileAssetClientDb,
          'file_versions'
        >({
          table: 'file_versions',
          scopes: ['user:{owner_id}'],
          codecs: fileAssetCodecs,
          resolveScopes: async (ctx) => ({ owner_id: [ctx.actorId] }),
        }),
      ],
      authenticate: async (c) => {
        const authorization = c.req.header('authorization');
        return authorization === token ? { actorId } : null;
      },
    });
    const clients: SyncularDatabase<FileAssetDb>[] = [];

    try {
      const writer = await openFileAssetDatabase({
        baseUrl: `${server.baseUrl}/sync`,
        actorId,
        clientId: `client-file-assets-writer-${Date.now()}`,
        token,
      });
      clients.push(writer);
      const reader = await openFileAssetDatabase({
        baseUrl: `${server.baseUrl}/sync`,
        actorId,
        clientId: `client-file-assets-reader-${Date.now()}`,
        token,
      });
      clients.push(reader);
      const blob = {
        hash: `sha256:${'1'.repeat(64)}`,
        size: 23,
        mimeType: 'text/plain',
      } satisfies BlobRef;

      await writer.mutations.file_versions.insert({
        id: 'version-browser-1',
        file_id: 'file-browser-1',
        owner_id: actorId,
        blob_ref: blob,
        content_hash: blob.hash,
        byte_size: blob.size,
        server_version: 0,
      });
      await expect(writer.client.syncPush()).resolves.toMatchObject({
        pushedCommits: 1,
      });
      const serverRow = await server.db
        .selectFrom('file_versions')
        .select(['id', 'blob_ref', 'content_hash'])
        .where('id', '=', 'version-browser-1')
        .executeTakeFirstOrThrow();
      expect(serverRow).toMatchObject({
        id: 'version-browser-1',
        content_hash: blob.hash,
      });
      expect(JSON.parse(serverRow.blob_ref)).toEqual(blob);

      await expect(reader.client.syncPull()).resolves.toMatchObject({
        changedTables: ['file_versions'],
        pushedCommits: 0,
      });
      await expect(
        reader.db
          .selectFrom('file_versions')
          .select(['id', 'blob_ref', 'content_hash'])
          .execute()
      ).resolves.toEqual([
        {
          id: 'version-browser-1',
          blob_ref: blob,
          content_hash: blob.hash,
        },
      ]);

      await reader.client.setSubscriptions([fileVersionSubscription('other')]);
      const revoked = await reader.client.syncPull();
      expect(revoked.subscriptions[0]).toMatchObject({
        id: 'sub-file-versions',
        table: 'file_versions',
        status: 'revoked',
      });
      await expect(
        reader.db.selectFrom('file_versions').select(['id']).execute()
      ).resolves.toEqual([]);
    } finally {
      while (clients.length > 0) await clients.pop()!.close();
      await server.destroy();
    }
  });

  it('rejects a CRDT schema against the core artifact', async () => {
    await expect(
      createSyncularDatabase<BasicDb>({
        config: {
          baseUrl: 'http://127.0.0.1:1/sync',
          actorId: 'actor-core',
          clientId: `client-core-crdt-${Date.now()}`,
          storage: 'memory',
          clearOnInit: true,
          appSchema: crdtAppSchema,
        },
        requiredRuntimeFeatures: ['web-owned-sqlite-core'],
        runtimeArtifacts: [coreRuntimeArtifact()],
      })
    ).rejects.toThrow('crdt-yjs');
  });

  it('rejects a blob schema against the core artifact', async () => {
    await expect(
      createSyncularDatabase<BasicDb>({
        config: {
          baseUrl: 'http://127.0.0.1:1/sync',
          actorId: 'actor-core',
          clientId: `client-core-blob-${Date.now()}`,
          storage: 'memory',
          clearOnInit: true,
          appSchema: blobAppSchema,
        },
        requiredRuntimeFeatures: ['web-owned-sqlite-core'],
        runtimeArtifacts: [coreRuntimeArtifact()],
      })
    ).rejects.toThrow('blobs');
  });
});

async function openBasicCoreDatabase(args: {
  baseUrl: string;
  actorId: string;
  clientId: string;
  token: string;
}): Promise<SyncularDatabase<BasicDb>> {
  const syncular = await createSyncularDatabase<BasicDb>({
    config: {
      baseUrl: args.baseUrl,
      actorId: args.actorId,
      clientId: args.clientId,
      storage: 'memory',
      clearOnInit: true,
      appSchema: basicAppSchema,
    },
    getHeaders: () => ({ authorization: args.token }),
    appTables: ['basic_tasks'],
    tableConfig: {
      basic_tasks: {
        primaryKeyColumn: 'id',
        serverVersionColumn: 'server_version',
      },
    },
    requiredRuntimeFeatures: ['web-owned-sqlite-core'],
    runtimeArtifacts: [coreRuntimeArtifact()],
  });
  try {
    await installBasicClientSchema(syncular);
    await syncular.client.setSubscriptions([
      basicTaskSubscription(args.actorId),
    ]);
    return syncular;
  } catch (error) {
    await syncular.close();
    throw error;
  }
}

async function openGeneratedTodoOldClient(args: {
  baseUrl: string;
  actorId: string;
  projectId: string;
  schemaVersion: number;
  appSchema?: SyncularAppSchema;
  clientId: string;
  token: string;
}): Promise<SyncularDatabase<GeneratedTodoV6ClientDb>> {
  const syncular = await createSyncularDatabase<GeneratedTodoV6ClientDb>({
    config: {
      baseUrl: args.baseUrl,
      actorId: args.actorId,
      projectId: args.projectId,
      clientId: args.clientId,
      storage: 'memory',
      clearOnInit: true,
      schemaVersion: args.schemaVersion,
      appSchema:
        args.appSchema ?? generatedTodoAppSchemaForVersion(args.schemaVersion),
    },
    getHeaders: () => ({ authorization: args.token }),
    codecs: todoGeneratedClientApp.codecs,
    appTables: todoGeneratedClientApp.tableNames,
    tableConfig: todoGeneratedClientApp.tableConfig,
    requiredRuntimeFeatures: ['web-owned-sqlite'],
  });
  try {
    await syncular.client.setSubscriptions([
      generatedTodoTaskSubscription(args.actorId, args.projectId),
    ]);
    return syncular;
  } catch (error) {
    await syncular.close();
    throw error;
  }
}

type GeneratedTableMetadata =
  TodoGeneratedClientSchemaMetadata['tables'][number] & {
    blobColumns?: readonly string[];
    crdtYjsFields?: SyncularAppSchema['tables'][number]['crdtYjsFields'];
    encryptedFields?: SyncularAppSchema['tables'][number]['encryptedFields'];
    softDeleteColumn?: string | null;
    subscription?: { id?: string };
  };

function generatedTodoAppSchemaForVersion(
  schemaVersion: number
): SyncularAppSchema {
  const schema = todoGeneratedClientSchemaForVersion(schemaVersion);
  if (!schema) {
    throw new Error(`Missing generated todo schema version ${schemaVersion}`);
  }
  const localBaseSql = schema.localBaseSchema?.tableSetupSql ?? [];
  if (localBaseSql.length === 0) {
    throw new Error(
      `Generated todo schema version ${schemaVersion} is missing local base SQL`
    );
  }

  return {
    schemaVersion: schema.schemaVersion,
    localBaseSchema: { tableSetupSql: localBaseSql },
    migrations: [
      {
        version: `historical-${schema.schemaVersion}`,
        schemaVersion: schema.schemaVersion,
        name: `generated_todo_schema_${schema.schemaVersion}`,
        upSql: localBaseSql.join(';\n'),
      },
    ],
    tables: schema.tables.map((table) => {
      const generated = table as GeneratedTableMetadata;
      return {
        name: table.name,
        primaryKeyColumn: table.primaryKeyColumn,
        serverVersionColumn: table.serverVersionColumn,
        softDeleteColumn: generated.softDeleteColumn ?? null,
        subscriptionId: generated.subscription?.id ?? `sub-${table.name}`,
        columns: table.columns.map((column) => ({
          name: column.name,
          typeFamily: column.typeFamily,
          notnullRequired: column.notnullRequired,
          primaryKey: column.primaryKey,
        })),
        blobColumns: [...(generated.blobColumns ?? [])],
        crdtYjsFields: [...(generated.crdtYjsFields ?? [])],
        encryptedFields: [...(generated.encryptedFields ?? [])],
        scopes: table.scopes.map((scope) => ({
          name: scope.name,
          column: scope.column,
          source: scope.source as 'actorId' | 'projectId',
          required: scope.required,
        })),
      };
    }),
  };
}

function generatedTodoUnsupportedAppSchemaForVersion(
  schemaVersion: number
): SyncularAppSchema {
  const supportedBase = generatedTodoAppSchemaForVersion(
    todoGeneratedClientSchemaSupport.minSupported
  );
  return {
    ...supportedBase,
    schemaVersion,
    migrations: supportedBase.migrations?.map((migration) => ({
      ...migration,
      version: `unsupported-${schemaVersion}`,
      schemaVersion,
      name: `generated_todo_unsupported_schema_${schemaVersion}`,
    })),
  };
}

async function installBasicClientSchema(
  syncular: SyncularDatabase<BasicDb>
): Promise<void> {
  await withSyncularSchemaWrites(syncular, async (db) => {
    await db.schema
      .createTable('basic_tasks')
      .ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('title', 'text', (col) => col.notNull())
      .addColumn('user_id', 'text', (col) => col.notNull())
      .addColumn('server_version', 'integer', (col) =>
        col.notNull().defaultTo(0)
      )
      .execute();
  });
}

async function ensureBasicServerTables(
  db: Kysely<BasicServerDb>
): Promise<void> {
  await db.schema
    .createTable('basic_tasks')
    .ifNotExists()
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('title', 'text', (col) => col.notNull())
    .addColumn('user_id', 'text', (col) => col.notNull())
    .addColumn('server_version', 'integer', (col) => col.notNull().defaultTo(0))
    .execute();
}

async function ensureGeneratedTodoServerTables(
  db: Kysely<GeneratedTodoServerDb>
): Promise<void> {
  for (const statement of todoGeneratedClientApp.appSchema.localBaseSchema
    ?.tableSetupSql ?? []) {
    await sql.raw(statement).execute(db);
  }
}

const fileAssetCodecs = (column: { table: string; column: string }) => {
  if (column.table === 'file_versions' && column.column === 'blob_ref') {
    return codecs.stringJson<BlobRef>();
  }
  return undefined;
};

async function openFileAssetDatabase(args: {
  baseUrl: string;
  actorId: string;
  clientId: string;
  token: string;
}): Promise<SyncularDatabase<FileAssetDb>> {
  const syncular = await createSyncularDatabase<FileAssetDb>({
    config: {
      baseUrl: args.baseUrl,
      actorId: args.actorId,
      clientId: args.clientId,
      storage: 'memory',
      clearOnInit: true,
      appSchema: fileVersionAppSchema,
    },
    getHeaders: () => ({ authorization: args.token }),
    sync: { autoSyncAfterMutation: false },
    codecs: fileAssetCodecs,
    appTables: ['file_versions'],
    tableConfig: {
      file_versions: {
        primaryKeyColumn: 'id',
        serverVersionColumn: 'server_version',
        blobColumns: ['blob_ref'],
      },
    },
    requiredRuntimeFeatures: ['web-owned-sqlite'],
  });
  try {
    await installFileAssetClientSchema(syncular);
    await syncular.client.setSubscriptions([
      fileVersionSubscription(args.actorId),
    ]);
    return syncular;
  } catch (error) {
    await syncular.close();
    throw error;
  }
}

async function installFileAssetClientSchema(
  syncular: SyncularDatabase<FileAssetDb>
): Promise<void> {
  await withSyncularSchemaWrites(syncular, async (db) => {
    await db.schema
      .createTable('file_versions')
      .ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('file_id', 'text', (col) => col.notNull())
      .addColumn('owner_id', 'text', (col) => col.notNull())
      .addColumn('blob_ref', 'text', (col) => col.notNull())
      .addColumn('content_hash', 'text', (col) => col.notNull())
      .addColumn('byte_size', 'integer', (col) => col.notNull())
      .addColumn('server_version', 'integer', (col) =>
        col.notNull().defaultTo(0)
      )
      .execute();
  });
}

async function ensureFileAssetServerTables(
  db: Kysely<FileAssetServerDb>
): Promise<void> {
  await db.schema
    .createTable('file_versions')
    .ifNotExists()
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('file_id', 'text', (col) => col.notNull())
    .addColumn('owner_id', 'text', (col) => col.notNull())
    .addColumn('blob_ref', 'text', (col) => col.notNull())
    .addColumn('content_hash', 'text', (col) => col.notNull())
    .addColumn('byte_size', 'integer', (col) => col.notNull())
    .addColumn('server_version', 'integer', (col) => col.notNull().defaultTo(0))
    .execute();
}

function fileVersionSubscription(ownerId: string): SyncularSubscriptionSpec {
  return {
    id: 'sub-file-versions',
    table: 'file_versions',
    scopes: { owner_id: ownerId },
    params: {},
  };
}

function basicTaskSubscription(actorId: string): SyncularSubscriptionSpec {
  return {
    id: 'sub-basic-tasks',
    table: 'basic_tasks',
    scopes: { user_id: actorId },
    params: {},
  };
}

function generatedTodoTaskSubscription(
  actorId: string,
  projectId: string
): SyncularSubscriptionSpec {
  return {
    id: 'sub-tasks',
    table: 'tasks',
    scopes: { user_id: actorId, project_id: projectId },
    params: {},
  };
}

function authLease(args: {
  leaseId: string;
  actorId: string;
  table: string;
  values: Record<string, string>;
  operations: string[];
  schemaVersion: number;
  expiresAtMs?: number;
}): SyncularAuthLeaseRecord {
  const now = Date.now();
  const expiresAtMs = args.expiresAtMs ?? now + 60_000;
  return {
    leaseId: args.leaseId,
    kid: 'test-kid',
    actorId: args.actorId,
    issuedAtMs: now - 1_000,
    notBeforeMs: now - 1_000,
    expiresAtMs,
    schemaVersion: args.schemaVersion,
    payloadJson: JSON.stringify({
      version: 1,
      leaseId: args.leaseId,
      issuer: 'syncular-test',
      audience: 'syncular-client',
      actorId: args.actorId,
      schemaVersion: args.schemaVersion,
      protocolVersion: 1,
      issuedAtMs: now - 1_000,
      notBeforeMs: now - 1_000,
      expiresAtMs,
      maxClockSkewMs: 0,
      scopes: [
        {
          subscriptionId: 'sub-basic-tasks',
          table: args.table,
          values: args.values,
          operations: args.operations,
        },
      ],
      capabilities: {
        allowBlobs: true,
        allowCrdt: true,
        allowEncryptedFields: true,
      },
    }),
    token: `token-${args.leaseId}`,
    status: 'active',
    lastValidationError: null,
    createdAtMs: now,
    updatedAtMs: now,
  };
}

function coreRuntimeArtifact(): SyncularRuntimeArtifactCandidate {
  return getSyncularRuntimeArtifact('core');
}
