import { describe, expect, it } from 'bun:test';
import {
  createServerHandler,
  type SyncCoreDb,
} from '../../../../../packages/server/src';
import { createHttpServerFixture } from '../../../../../packages/testkit/src/http-fixtures';
import {
  createSyncularV2Database,
  type SyncularV2Database,
  withSyncularV2SchemaWrites,
} from '../database';
import type {
  SyncularV2AppSchema,
  SyncularV2RuntimeArtifactCandidate,
  SyncularV2SubscriptionSpec,
} from '../types';

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

const basicAppSchema: SyncularV2AppSchema = {
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

const crdtAppSchema: SyncularV2AppSchema = {
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

const blobAppSchema: SyncularV2AppSchema = {
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

describe('Syncular v2 core WASM artifact', () => {
  it('opens a basic SQLite app schema without CRDT or E2EE', async () => {
    const syncular = await createSyncularV2Database<BasicDb>({
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

      await withSyncularV2SchemaWrites(syncular, async (db) => {
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
    const clients: SyncularV2Database<BasicDb>[] = [];

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

  it('rejects a CRDT schema against the core artifact', async () => {
    await expect(
      createSyncularV2Database<BasicDb>({
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
      createSyncularV2Database<BasicDb>({
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
}): Promise<SyncularV2Database<BasicDb>> {
  const syncular = await createSyncularV2Database<BasicDb>({
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

async function installBasicClientSchema(
  syncular: SyncularV2Database<BasicDb>
): Promise<void> {
  await withSyncularV2SchemaWrites(syncular, async (db) => {
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
  db: import('kysely').Kysely<BasicServerDb>
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

function basicTaskSubscription(actorId: string): SyncularV2SubscriptionSpec {
  return {
    id: 'sub-basic-tasks',
    table: 'basic_tasks',
    scopes: { user_id: actorId },
    params: {},
  };
}

function coreRuntimeArtifact(): SyncularV2RuntimeArtifactCandidate {
  return {
    name: 'core',
    features: ['web-owned-sqlite-core'],
    wasmGlueUrl: new URL(
      '../../dist/wasm-core/syncular_v2.js',
      import.meta.url
    ),
    wasmUrl: new URL(
      '../../dist/wasm-core/syncular_v2_bg.wasm',
      import.meta.url
    ),
  };
}
