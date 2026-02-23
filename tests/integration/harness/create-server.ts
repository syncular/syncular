/**
 * Integration test server factory.
 *
 * Uses @syncular/testkit HTTP fixtures to avoid duplicating Hono/node:http
 * bridge and sync route bootstrapping logic.
 */

import { createHttpServerFixture } from '@syncular/testkit';
import { projectsServerShape } from '../handlers/projects-server';
import { createTasksServerShape } from '../handlers/tasks-server';
import type {
  IntegrationServer,
  IntegrationServerDb,
  ServerDialect,
} from './types';

export async function createIntegrationServer(
  serverDialect: ServerDialect
): Promise<IntegrationServer> {
  return createHttpServerFixture<IntegrationServerDb>({
    serverDialect,
    routePath: '/sync',
    createTables: async (db) => {
      await db.schema
        .createTable('projects')
        .ifNotExists()
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('name', 'text', (col) => col.notNull())
        .addColumn('owner_id', 'text', (col) => col.notNull())
        .addColumn('server_version', 'integer', (col) =>
          col.notNull().defaultTo(1)
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
          col.notNull().defaultTo(1)
        )
        .execute();
    },
    handlers: [
      createTasksServerShape<IntegrationServerDb>(),
      projectsServerShape,
    ],
    authenticate: async (c) => {
      const actorId = c.req.header('x-actor-id');
      if (!actorId) {
        return null;
      }

      return { actorId };
    },
    sync: {
      rateLimit: false,
    },
  });
}
