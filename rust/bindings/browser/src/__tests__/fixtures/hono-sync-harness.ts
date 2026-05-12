import { type BlobRef, createDatabase } from '@syncular/core';
import type { Kysely } from 'kysely';
import { createBunSqliteDialect } from '../../../../../../packages/dialect-bun-sqlite/src';
import {
  createServerHandler,
  ensureSyncSchema,
  type SyncAuthResult,
  type SyncCoreDb,
} from '../../../../../../packages/server/src';
import { createSqliteServerDialect } from '../../../../../../packages/server-dialect-sqlite/src';
import { createSyncRoutes } from '../../../../../../packages/server-hono/src/routes';
import {
  closeNodeServer,
  createNodeHonoServer,
} from '../../../../../../packages/testkit/src/hono-node-server';
import { syncularGeneratedCodecs } from '../../../../../examples/todo-app/generated/typescript/syncular.generated';
import type {
  CreateSyncularV2DatabaseOptions,
  SyncularV2AuthHeaders,
  SyncularV2Client,
} from '../../types';
import { createSyncularV2WorkerClient } from '../../worker-client';

export interface HonoSyncActor {
  actorId: string;
  token: string;
}

export interface CreateHonoSyncHarnessOptions {
  actors: readonly HonoSyncActor[];
  seedTasks?: readonly HonoTaskSeed[];
  edgeGate?: (request: Request) => Response | Promise<Response> | null;
  snapshotBundleMaxBytes?: number;
}

export interface HonoSyncHarness {
  baseUrl: string;
  db: Kysely<HonoSyncServerDb>;
  syncRouteAuthHeaders: string[];
  openWorkerClient(options: HonoWorkerClientOptions): Promise<SyncularV2Client>;
  close(): Promise<void>;
}

export interface HonoWorkerClientOptions {
  clientId: string;
  actorId: string;
  getHeaders: () => SyncularV2AuthHeaders | Promise<SyncularV2AuthHeaders>;
  authLifecycle?: CreateSyncularV2DatabaseOptions['authLifecycle'];
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
  const clients: SyncularV2Client[] = [];
  const serverDialect = createSqliteServerDialect();
  const db = createDatabase<HonoSyncServerDb>({
    dialect: createBunSqliteDialect({ path: ':memory:' }),
    family: 'sqlite',
  });
  let server: ReturnType<typeof createNodeHonoServer> | undefined;

  try {
    await ensureSyncSchema(db, serverDialect);
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
    const routes = createSyncRoutes<HonoSyncServerDb, HonoAuthContext>({
      db,
      dialect: serverDialect,
      handlers: [
        createServerHandler<
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
        }),
      ],
      authenticate: async (c) => {
        const authorization = c.req.header('authorization');
        if (authorization) syncRouteAuthHeaders.push(authorization);
        const actorId = authorization ? actorByToken.get(authorization) : null;
        return actorId ? { actorId } : null;
      },
      sync: {
        rateLimit: false,
      },
    });

    const app = {
      fetch(request: Request): Response | Promise<Response> {
        const url = new URL(request.url);
        if (!url.pathname.startsWith('/sync')) {
          return new Response('not found', { status: 404 });
        }
        const gated = options.edgeGate?.(request);
        if (gated) return gated;
        url.pathname = url.pathname.slice('/sync'.length) || '/';
        return routes.fetch(new Request(url, request));
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

    return {
      baseUrl,
      db,
      syncRouteAuthHeaders,
      async openWorkerClient(clientOptions) {
        const client = await createSyncularV2WorkerClient({
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
          },
        });
        clients.push(client);
        return client;
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

export interface HonoSyncServerDb extends SyncCoreDb {
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
