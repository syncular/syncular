/**
 * Syncular server module scaffold (Postgres).
 */

import { createServerHandler, ensureSyncSchema, type SyncCoreDb } from '@syncular/server';
import { createPostgresServerDialect } from '@syncular/server-dialect-postgres';
import { createSyncServer } from '@syncular/server-hono';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';

export interface AppServerDb extends SyncCoreDb {}

export async function createSyncularServer() {
  const db = new Kysely<AppServerDb>({
    dialect: new PostgresDialect({
      pool: new Pool({ connectionString: process.env.DATABASE_URL }),
    }),
  });

  const dialect = createPostgresServerDialect();
  await ensureSyncSchema(db, dialect);

  const tasksHandler = createServerHandler({
    table: 'tasks',
    scopes: ['user:{user_id}'],
    resolveScopes: async (ctx) => ({ user_id: [ctx.actorId] }),
  });

  const server = createSyncServer({
    db,
    dialect,
    sync: {
      handlers: [tasksHandler],
      authenticate: async (request) => {
        const actorId = request.headers.get('x-user-id');
        return actorId ? { actorId } : null;
      },
    },
  });

  return { ...server, db, dialect };
}
