/**
 * Integration test client factory.
 *
 * Uses @syncular/testkit HTTP fixtures to avoid duplicating transport/client
 * setup logic while preserving current harness behavior.
 */

import { createHttpClientFixture } from '@syncular/testkit';
import { projectsClientHandler } from '../handlers/projects-client';
import { tasksClientHandler } from '../handlers/tasks-client';
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
  const nativeFetch = (globalThis as Record<string, unknown>).__nativeFetch as
    | typeof globalThis.fetch
    | undefined;

  return createHttpClientFixture<IntegrationClientDb>({
    clientDialect,
    baseUrl: server.baseUrl,
    actorId: opts.actorId,
    clientId: opts.clientId,
    createTables: async (db) => {
      await db.schema
        .createTable('projects')
        .ifNotExists()
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('name', 'text', (col) => col.notNull())
        .addColumn('owner_id', 'text', (col) => col.notNull())
        .addColumn('server_version', 'integer', (col) =>
          col.notNull().defaultTo(0)
        )
        .execute();

      await db.schema
        .createTable('tasks')
        .ifNotExists()
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('title', 'text', (col) => col.notNull())
        .addColumn('completed', 'integer', (col) => col.notNull().defaultTo(0))
        .addColumn('user_id', 'text', (col) => col.notNull())
        .addColumn('project_id', 'text', (col) => col.notNull())
        .addColumn('server_version', 'integer', (col) =>
          col.notNull().defaultTo(0)
        )
        .execute();
    },
    registerHandlers: (handlers) => {
      handlers.push(tasksClientHandler);
      handlers.push(projectsClientHandler);
    },
    ...(nativeFetch ? { fetch: nativeFetch } : {}),
  });
}
