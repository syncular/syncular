/**
 * Syncular server module scaffold (SQLite).
 */

import { createBunSqliteDb } from '@syncular/dialect-bun-sqlite';
import { createServerHandler, ensureSyncSchema, type SyncCoreDb } from '@syncular/server';
import { createSqliteServerDialect } from '@syncular/server-dialect-sqlite';
import { createSyncServer } from '@syncular/server-hono';

export interface AppServerDb extends SyncCoreDb {}

export async function createSyncularServer() {
  const db = createBunSqliteDb<AppServerDb>({ path: './data/server.sqlite' });
  const dialect = createSqliteServerDialect();
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
