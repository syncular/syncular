import { type BlobRef, createDatabase } from '@syncular/core';
import type { Kysely } from 'kysely';
import { createBunSqliteDialect } from '../../../../../../packages/dialect-bun-sqlite/src';
import {
  createBlobManager,
  createDatabaseBlobStorageAdapter,
  createEncryptedCrdtSystemHandlers,
  createHmacTokenSigner,
  createServerHandler,
  createServerHandlerCollection,
  ensureBlobStorageSchemaSqlite,
  ensureSyncSchema,
  precomputeScopedSnapshotArtifacts,
  type SnapshotArtifactStorage,
  type SyncAuthResult,
  type SyncBlobDb,
  type SyncCoreDb,
} from '../../../../../../packages/server/src';
import { createBunSqliteSnapshotArtifactEncoder } from '../../../../../../packages/server/src/snapshot-artifacts/sqlite-bun';
import { createSqliteServerDialect } from '../../../../../../packages/server-dialect-sqlite/src';
import { createBlobRoutes } from '../../../../../../packages/server-hono/src/blobs';
import { createSyncRoutes } from '../../../../../../packages/server-hono/src/routes';
import {
  closeNodeServer,
  createNodeHonoServer,
} from '../../../../../../packages/testkit/src/hono-node-server';
import {
  createSyncularAppDatabase,
  type SyncularAppDatabase,
  syncularGeneratedCodecs,
  syncularGeneratedSchemaVersion,
} from '../../../../../examples/todo-app/generated/typescript/syncular.generated';
import { syncularGeneratedServerSnapshotBinary } from '../../../../../examples/todo-app/generated/typescript/syncular.server.generated';
import type {
  CreateSyncularV2DatabaseOptions,
  SyncularV2AuthHeaders,
  SyncularV2Client,
  SyncularV2ClientConfig,
  SyncularV2PullOptions,
} from '../../types';

export interface HonoSyncActor {
  actorId: string;
  token: string;
}

export interface CreateHonoSyncHarnessOptions {
  actors: readonly HonoSyncActor[];
  seedTasks?: readonly HonoTaskSeed[];
  edgeGate?: (request: Request) => Response | Promise<Response> | null;
  snapshotBundleMaxBytes?: number;
  precomputedTaskSnapshotArtifact?: {
    actorId: string;
    artifactId?: string;
    asOfCommitSeq?: number;
    rowLimit?: number;
  };
  requiredSchemaVersion?: number;
  latestSchemaVersion?: number;
}

export interface HonoSyncHarness {
  baseUrl: string;
  db: Kysely<HonoSyncServerDb>;
  syncRouteAuthHeaders: string[];
  openWorkerDatabase(
    options: HonoWorkerClientOptions
  ): Promise<SyncularAppDatabase>;
  openWorkerClient(options: HonoWorkerClientOptions): Promise<SyncularV2Client>;
  close(): Promise<void>;
}

export interface HonoWorkerClientOptions {
  clientId: string;
  actorId: string;
  getHeaders: () => SyncularV2AuthHeaders | Promise<SyncularV2AuthHeaders>;
  authLifecycle?: CreateSyncularV2DatabaseOptions['authLifecycle'];
  appSchema?: SyncularV2ClientConfig['appSchema'];
  pull?: SyncularV2PullOptions;
  fileName?: string;
  requestTimeoutMs?: number;
}

export interface HonoTaskSeed {
  id: string;
  title: string;
  actorId: string;
  completed?: number;
  projectId?: string | null;
  serverVersion?: number;
  image?: string | null;
  titleYjsState?: string | null;
}

export async function createHonoSyncHarness(
  options: CreateHonoSyncHarnessOptions
): Promise<HonoSyncHarness> {
  const clients: Array<{ close(): Promise<void> }> = [];
  const serverDialect = createSqliteServerDialect();
  const db = createDatabase<HonoSyncServerDb>({
    dialect: createBunSqliteDialect({ path: ':memory:' }),
    family: 'sqlite',
  });
  let server: ReturnType<typeof createNodeHonoServer> | undefined;

  try {
    await ensureSyncSchema(db, serverDialect);
    await ensureBlobStorageSchemaSqlite(db);
    await ensureHonoSyncTasksTable(db);
    for (const task of options.seedTasks ?? []) {
      await db
        .insertInto('tasks')
        .values({
          id: task.id,
          title: task.title,
          completed: task.completed ?? 0,
          user_id: task.actorId,
          project_id: task.projectId ?? null,
          server_version: task.serverVersion ?? 1,
          image: task.image ?? null,
          title_yjs_state: task.titleYjsState ?? null,
        })
        .execute();
    }

    const actorByToken = new Map(
      options.actors.map((actor) => [actor.token, actor.actorId])
    );
    const syncRouteAuthHeaders: string[] = [];
    const taskHandler = createServerHandler<
      HonoSyncServerDb,
      HonoSyncClientDb,
      'tasks',
      HonoAuthContext
    >({
      table: 'tasks',
      scopes: ['user:{user_id}'],
      codecs: syncularGeneratedCodecs,
      snapshotBundleMaxBytes: options.snapshotBundleMaxBytes,
      resolveScopes: async (ctx) => ({ user_id: [ctx.actorId] }),
    });
    const handlers = [
      taskHandler,
      ...createEncryptedCrdtSystemHandlers<HonoSyncServerDb, HonoAuthContext>({
        resolveScopes: async (ctx) => ({ user_id: [ctx.actorId] }),
        authorizeUpdate: ({ ctx, row }) => row.scopes.user_id === ctx.actorId,
        authorizeCheckpoint: ({ ctx, row }) =>
          row.scopes.user_id === ctx.actorId,
      }),
    ];
    const handlerCollection = createServerHandlerCollection<
      HonoSyncServerDb,
      HonoAuthContext
    >(handlers, {
      snapshotBinary: syncularGeneratedServerSnapshotBinary,
    });
    let snapshotArtifactStorage: SnapshotArtifactStorage | undefined;
    if (options.precomputedTaskSnapshotArtifact) {
      const artifactBodies = new Map<string, Uint8Array>();
      snapshotArtifactStorage = {
        name: 'hono-memory-artifacts',
        async storeArtifact(artifact) {
          artifactBodies.set(artifact.artifactId, artifact.body);
          return { blobHash: `memory:${artifact.artifactId}` };
        },
        async readArtifact(artifact) {
          return artifactBodies.get(artifact.id) ?? null;
        },
      };
      await precomputeScopedSnapshotArtifacts({
        db,
        storage: snapshotArtifactStorage,
        handlers: handlerCollection,
        auth: { actorId: options.precomputedTaskSnapshotArtifact.actorId },
        partitionId: 'default',
        subscriptionId: 'sub-tasks',
        table: 'tasks',
        scopes: { user_id: options.precomputedTaskSnapshotArtifact.actorId },
        schemaVersion: syncularGeneratedSchemaVersion,
        asOfCommitSeq:
          options.precomputedTaskSnapshotArtifact.asOfCommitSeq ?? 0,
        rowCursor: null,
        rowLimit: options.precomputedTaskSnapshotArtifact.rowLimit ?? 50_000,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        artifactIdPrefix: options.precomputedTaskSnapshotArtifact.artifactId,
        encoder: createBunSqliteSnapshotArtifactEncoder(),
      });
    }
    const syncRoutes = createSyncRoutes<HonoSyncServerDb, HonoAuthContext>({
      db,
      dialect: serverDialect,
      handlers: handlerCollection.handlers,
      snapshotBinary: syncularGeneratedServerSnapshotBinary,
      snapshotArtifactStorage,
      authenticate: async (c) => {
        const authorization = c.req.header('authorization');
        if (authorization) syncRouteAuthHeaders.push(authorization);
        const actorId = authorization ? actorByToken.get(authorization) : null;
        return actorId ? { actorId } : null;
      },
      sync: {
        rateLimit: false,
        requiredSchemaVersion: options.requiredSchemaVersion,
        latestSchemaVersion: options.latestSchemaVersion,
      },
    });
    let blobRoutes: ReturnType<typeof createBlobRoutes> | undefined;

    const app = {
      async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);
        if (!url.pathname.startsWith('/sync')) {
          return new Response('not found', { status: 404 });
        }
        const gated = await options.edgeGate?.(request);
        if (gated) return gated;
        url.pathname = url.pathname.slice('/sync'.length) || '/';
        if (url.pathname.startsWith('/blobs')) {
          if (!blobRoutes) return new Response('not ready', { status: 503 });
          return blobRoutes.fetch(new Request(url, request));
        }
        return syncRoutes.fetch(new Request(url, request));
      },
    } as Parameters<typeof createNodeHonoServer>[0];
    server = createNodeHonoServer(app);
    await new Promise<void>((resolve) => {
      server!.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (typeof address !== 'object' || !address) {
      throw new Error('Failed to resolve Hono sync test server address');
    }
    const baseUrl = `http://127.0.0.1:${address.port}/sync`;
    const tokenSigner = createHmacTokenSigner('syncular-rust-sync-hono-secret');
    blobRoutes = createBlobRoutes({
      blobManager: createBlobManager({
        db,
        adapter: createDatabaseBlobStorageAdapter({
          db,
          baseUrl,
          tokenSigner,
        }),
      }),
      authenticate: async (c) => {
        const authorization = c.req.header('authorization');
        const actorId = authorization ? actorByToken.get(authorization) : null;
        return actorId ? { actorId } : null;
      },
      tokenSigner,
      db,
      canAccessBlob: async ({ actorId }) =>
        options.actors.some((actor) => actor.actorId === actorId),
    });

    const openWorkerDatabase = async (
      clientOptions: HonoWorkerClientOptions
    ): Promise<SyncularAppDatabase> => {
      const database = await createSyncularAppDatabase({
        requestTimeoutMs: clientOptions.requestTimeoutMs ?? 10_000,
        getHeaders: clientOptions.getHeaders,
        authLifecycle: clientOptions.authLifecycle,
        config: {
          baseUrl,
          clientId: clientOptions.clientId,
          actorId: clientOptions.actorId,
          fileName:
            clientOptions.fileName ?? `${clientOptions.clientId}.sqlite`,
          storage: 'memory',
          clearOnInit: true,
          appSchema: clientOptions.appSchema,
          pull: clientOptions.pull,
        },
      });
      clients.push(database);
      return database;
    };

    return {
      baseUrl,
      db,
      syncRouteAuthHeaders,
      openWorkerDatabase,
      async openWorkerClient(clientOptions) {
        return (await openWorkerDatabase(clientOptions)).client;
      },
      async close() {
        while (clients.length > 0) await clients.pop()!.close();
        if (server) {
          await closeNodeServer(server);
          server = undefined;
        }
        await db.destroy();
      },
    };
  } catch (error) {
    while (clients.length > 0) await clients.pop()!.close();
    if (server) await closeNodeServer(server);
    await db.destroy();
    throw error;
  }
}

export interface HonoTaskTable {
  id: string;
  title: string;
  completed: number;
  user_id: string;
  project_id: string | null;
  server_version: number;
  image: string | null;
  title_yjs_state: string | null;
}

interface HonoClientTaskTable extends Omit<HonoTaskTable, 'image'> {
  image: BlobRef | null;
}

export interface HonoSyncServerDb extends SyncCoreDb, SyncBlobDb {
  tasks: HonoTaskTable;
}

export interface HonoSyncClientDb {
  tasks: HonoClientTaskTable;
}

export interface HonoAuthContext extends SyncAuthResult {
  actorId: string;
}

export async function ensureHonoSyncTasksTable(
  db: Kysely<HonoSyncServerDb>
): Promise<void> {
  await db.schema
    .createTable('tasks')
    .ifNotExists()
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('title', 'text', (col) => col.notNull())
    .addColumn('completed', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('user_id', 'text', (col) => col.notNull())
    .addColumn('project_id', 'text')
    .addColumn('server_version', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('image', 'text')
    .addColumn('title_yjs_state', 'text')
    .execute();
}
