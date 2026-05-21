import { describe, expect, it } from 'bun:test';
import { type BlobRef, codecs } from '@syncular/core';
import { createServerHandler, type SyncCoreDb } from '../../../server/src';
import { createHttpServerFixture } from '../../../testkit/src/http-fixtures';
import {
  createSyncularV2Database,
  type SyncularV2Database,
  withSyncularV2SchemaWrites,
} from '../database';
import type {
  SyncularV2AppSchema,
  SyncularV2AuthLeaseRecord,
  SyncularV2RuntimeArtifactCandidate,
  SyncularV2SubscriptionSpec,
} from '../types';
import { getSyncularV2RuntimeArtifact } from '../wasm-runtime';

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

const fileVersionAppSchema: SyncularV2AppSchema = {
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
      await expect(
        syncular.db
          .selectFrom('basic_tasks')
          .select(['id'])
          .where('id', '=', 'task-core-leased-expired')
          .execute()
      ).resolves.toEqual([]);

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
    const clients: SyncularV2Database<FileAssetDb>[] = [];

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
}): Promise<SyncularV2Database<FileAssetDb>> {
  const syncular = await createSyncularV2Database<FileAssetDb>({
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
  syncular: SyncularV2Database<FileAssetDb>
): Promise<void> {
  await withSyncularV2SchemaWrites(syncular, async (db) => {
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
  db: import('kysely').Kysely<FileAssetServerDb>
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

function fileVersionSubscription(ownerId: string): SyncularV2SubscriptionSpec {
  return {
    id: 'sub-file-versions',
    table: 'file_versions',
    scopes: { owner_id: ownerId },
    params: {},
  };
}

function basicTaskSubscription(actorId: string): SyncularV2SubscriptionSpec {
  return {
    id: 'sub-basic-tasks',
    table: 'basic_tasks',
    scopes: { user_id: actorId },
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
}): SyncularV2AuthLeaseRecord {
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

function coreRuntimeArtifact(): SyncularV2RuntimeArtifactCandidate {
  return getSyncularV2RuntimeArtifact('core');
}
