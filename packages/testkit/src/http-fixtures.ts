import { createDatabase } from '@syncular/core';
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
import { Hono } from 'hono';
import type { Kysely } from 'kysely';
import { createNodeHonoServer } from './hono-node-server';

export type HttpServerDialect = 'sqlite' | 'pglite';

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
