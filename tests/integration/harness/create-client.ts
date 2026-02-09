/**
 * Integration test client factory
 *
 * Creates a client with real HTTP transport pointing at the integration server.
 */

import { ClientTableRegistry, ensureClientSyncSchema } from '@syncular/client';
import { createBunSqliteDb } from '@syncular/dialect-bun-sqlite';
import { createPgliteDb } from '@syncular/dialect-pglite';
import { createHttpTransport } from '@syncular/transport-http';
import { projectsClientHandler } from '../shapes/projects-client';
import { tasksClientHandler } from '../shapes/tasks-client';
import type {
  ClientDialect,
  IntegrationClient,
  IntegrationClientDb,
  IntegrationServer,
} from './types';

export async function createIntegrationClient(
  clientDialect: ClientDialect,
  server: IntegrationServer,
  opts: { actorId: string; clientId: string }
): Promise<IntegrationClient> {
  const db =
    clientDialect === 'pglite'
      ? createPgliteDb<IntegrationClientDb>()
      : createBunSqliteDb<IntegrationClientDb>({ path: ':memory:' });

  await ensureClientSyncSchema(db);

  // Create application tables
  await db.schema
    .createTable('projects')
    .ifNotExists()
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('owner_id', 'text', (col) => col.notNull())
    .addColumn('server_version', 'integer', (col) => col.notNull().defaultTo(0))
    .execute();

  await db.schema
    .createTable('tasks')
    .ifNotExists()
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('title', 'text', (col) => col.notNull())
    .addColumn('completed', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('user_id', 'text', (col) => col.notNull())
    .addColumn('project_id', 'text', (col) => col.notNull())
    .addColumn('server_version', 'integer', (col) => col.notNull().defaultTo(0))
    .execute();

  // Register client table handlers
  const shapes = new ClientTableRegistry<IntegrationClientDb>();
  shapes.register(tasksClientHandler);
  shapes.register(projectsClientHandler);

  // Create real HTTP transport
  // Use native fetch saved before happy-dom preload replaces it with a CORS-enforcing polyfill
  const nativeFetch = (globalThis as Record<string, unknown>).__nativeFetch as
    | typeof globalThis.fetch
    | undefined;
  const transport = createHttpTransport({
    baseUrl: server.baseUrl,
    getHeaders: () => ({ 'x-actor-id': opts.actorId }),
    ...(nativeFetch && { fetch: nativeFetch }),
  });

  return {
    db,
    transport,
    shapes,
    actorId: opts.actorId,
    clientId: opts.clientId,
    destroy: async () => {
      await db.destroy();
    },
  };
}
