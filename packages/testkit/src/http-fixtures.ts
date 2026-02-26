import {
  type ClientHandlerCollection,
  enqueueOutboxCommit,
  ensureClientSyncSchema,
  type SyncClientDb,
  type SyncOnceOptions,
  type SyncOnceResult,
  type SyncPullOnceOptions,
  type SyncPullResponse,
  type SyncPushOnceOptions,
  type SyncPushOnceResult,
  syncOnce,
  syncPullOnce,
  syncPushOnce,
} from '@syncular/client';
import { createDatabase, type SyncTransport } from '@syncular/core';
import { createBunSqliteDialect } from '@syncular/dialect-bun-sqlite';
import { createPgliteDialect } from '@syncular/dialect-pglite';
import {
  ensureSyncSchema,
  type ServerSyncDialect,
  type ServerTableHandler,
  type SyncCoreDb,
} from '@syncular/server';
import { createPostgresServerDialect } from '@syncular/server-dialect-postgres';
import { createSqliteServerDialect } from '@syncular/server-dialect-sqlite';
import {
  type CreateSyncRoutesOptions,
  createSyncRoutes,
} from '@syncular/server-hono';
import { createHttpTransport } from '@syncular/transport-http';
import { Hono } from 'hono';
import type { Kysely } from 'kysely';
import { createNodeHonoServer } from './hono-node-server';

export type HttpServerDialect = 'sqlite' | 'pglite';
export type HttpClientDialect = 'bun-sqlite' | 'pglite';

export interface HttpServerFixture<DB extends SyncCoreDb> {
  db: Kysely<DB>;
  dialect: ServerSyncDialect;
  app: Hono;
  httpServer: ReturnType<typeof createNodeHonoServer>;
  baseUrl: string;
  destroy: () => Promise<void>;
}

export interface CreateHttpServerFixtureOptions<DB extends SyncCoreDb> {
  serverDialect: HttpServerDialect;
  createTables: (db: Kysely<DB>) => Promise<void>;
  handlers: ServerTableHandler<DB>[];
  authenticate: CreateSyncRoutesOptions<
    DB,
    { actorId: string }
  >['authenticate'];
  sync?: CreateSyncRoutesOptions<DB, { actorId: string }>['sync'];
  routePath?: string;
  cors?: boolean;
  corsAllowMethods?: string;
  corsAllowHeaders?: string;
  corsMaxAgeSeconds?: number;
}

export interface HttpClientFixture<DB extends SyncClientDb> {
  db: Kysely<DB>;
  transport: SyncTransport;
  handlers: ClientHandlerCollection<DB>;
  actorId: string;
  clientId: string;
  enqueue: (
    args: Parameters<typeof enqueueOutboxCommit<DB>>[1]
  ) => Promise<{ id: string; clientCommitId: string }>;
  push: (
    options?: Omit<SyncPushOnceOptions, 'clientId' | 'actorId'>
  ) => Promise<SyncPushOnceResult>;
  pull: (
    options: Omit<SyncPullOnceOptions, 'clientId' | 'actorId'>
  ) => Promise<SyncPullResponse>;
  syncOnce: (
    options: Omit<SyncOnceOptions, 'clientId' | 'actorId'>
  ) => Promise<SyncOnceResult>;
  destroy: () => Promise<void>;
}

export interface CreateHttpClientFixtureOptions<DB extends SyncClientDb> {
  clientDialect: HttpClientDialect;
  baseUrl: string;
  actorId: string;
  clientId: string;
  createTables: (db: Kysely<DB>) => Promise<void>;
  registerHandlers: (handlers: ClientHandlerCollection<DB>) => void;
  fetch?: typeof globalThis.fetch;
  getHeaders?: () => Record<string, string>;
}

const PGLITE_INIT_ATTEMPTS = 3;

function isTransientPgliteInitError(error: Error): boolean {
  return (
    error.message.includes('access to a null reference') ||
    error.message.includes('_pgl_initdb')
  );
}

function isServerNotRunningError(error: Error | null): boolean {
  return (
    error !== null && 'code' in error && error.code === 'ERR_SERVER_NOT_RUNNING'
  );
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function withPgliteInitRetry<T>(
  useRetries: boolean,
  create: () => Promise<T>
): Promise<T> {
  const maxAttempts = useRetries ? PGLITE_INIT_ATTEMPTS : 1;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await create();
    } catch (error) {
      const candidate =
        error instanceof Error ? error : new Error(String(error));
      lastError = candidate;

      const isRetryable =
        useRetries &&
        attempt < maxAttempts &&
        isTransientPgliteInitError(candidate);
      if (!isRetryable) {
        throw candidate;
      }

      await delay(25 * attempt);
    }
  }

  throw lastError ?? new Error('PGLite initialization failed');
}

export async function createHttpServerFixture<DB extends SyncCoreDb>(
  options: CreateHttpServerFixtureOptions<DB>
): Promise<HttpServerFixture<DB>> {
  const dialect =
    options.serverDialect === 'pglite'
      ? createPostgresServerDialect()
      : createSqliteServerDialect();

  const db = await withPgliteInitRetry(
    options.serverDialect === 'pglite',
    async () => {
      const candidateDb =
        options.serverDialect === 'pglite'
          ? createDatabase<DB>({
              dialect: createPgliteDialect(),
              family: 'postgres',
            })
          : createDatabase<DB>({
              dialect: createBunSqliteDialect({ path: ':memory:' }),
              family: 'sqlite',
            });

      try {
        await ensureSyncSchema(candidateDb, dialect);
        if (dialect.ensureConsoleSchema) {
          await dialect.ensureConsoleSchema(candidateDb);
        }
        await options.createTables(candidateDb);
        return candidateDb;
      } catch (error) {
        await candidateDb.destroy();
        throw error;
      }
    }
  );

  const app = new Hono();
  const routePath = options.routePath ?? '/sync';

  const syncRoutes = createSyncRoutes<DB>({
    db,
    dialect,
    handlers: options.handlers,
    authenticate: options.authenticate,
    sync: options.sync,
  });

  app.route(routePath, syncRoutes);

  const httpServer = createNodeHonoServer(app, {
    cors: options.cors,
    corsAllowMethods: options.corsAllowMethods,
    corsAllowHeaders: options.corsAllowHeaders,
    corsMaxAgeSeconds: options.corsMaxAgeSeconds,
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(0, resolve);
  });

  const address = httpServer.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  let destroyed = false;

  return {
    db,
    dialect,
    app,
    httpServer,
    baseUrl: `http://localhost:${port}`,
    destroy: async () => {
      if (destroyed) {
        return;
      }
      destroyed = true;

      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => {
          if (err && !isServerNotRunningError(err)) {
            reject(err);
            return;
          }
          resolve();
        });
      });
      await db.destroy();
    },
  };
}

export async function createHttpClientFixture<DB extends SyncClientDb>(
  options: CreateHttpClientFixtureOptions<DB>
): Promise<HttpClientFixture<DB>> {
  const db = await withPgliteInitRetry(
    options.clientDialect === 'pglite',
    async () => {
      const candidateDb =
        options.clientDialect === 'pglite'
          ? createDatabase<DB>({
              dialect: createPgliteDialect(),
              family: 'postgres',
            })
          : createDatabase<DB>({
              dialect: createBunSqliteDialect({ path: ':memory:' }),
              family: 'sqlite',
            });

      try {
        await ensureClientSyncSchema(candidateDb);
        await options.createTables(candidateDb);
        return candidateDb;
      } catch (error) {
        await candidateDb.destroy();
        throw error;
      }
    }
  );

  const handlers: ClientHandlerCollection<DB> = [];
  options.registerHandlers(handlers);

  const transport = createHttpTransport({
    baseUrl: options.baseUrl,
    getHeaders:
      options.getHeaders ??
      (() => ({
        'x-actor-id': options.actorId,
      })),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  return {
    db,
    transport,
    handlers,
    actorId: options.actorId,
    clientId: options.clientId,
    enqueue: (args) => enqueueOutboxCommit(db, args),
    push: (pushOptions) =>
      syncPushOnce(db, transport, {
        clientId: options.clientId,
        actorId: options.actorId,
        plugins: pushOptions?.plugins,
      }),
    pull: (pullOptions) =>
      syncPullOnce(db, transport, handlers, {
        ...pullOptions,
        clientId: options.clientId,
        actorId: options.actorId,
      }),
    syncOnce: (syncOptions) =>
      syncOnce(db, transport, handlers, {
        ...syncOptions,
        clientId: options.clientId,
        actorId: options.actorId,
      }),
    destroy: async () => {
      await db.destroy();
    },
  };
}
