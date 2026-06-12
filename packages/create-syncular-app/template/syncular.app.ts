import { defineSyncularClient, scope, syncedTable } from '@syncular/typegen';

/**
 * Syncular app contract.
 *
 * The schema lives in migrations/*.sql; this file describes how the synced
 * tables map to subscriptions and scopes. After changing either, run
 * `bun run codegen` (or `npx syncular generate`) to refresh the generated
 * modules under src/generated/.
 */
export const app = defineSyncularClient({
  typescriptOutputPath: 'src/generated/syncular.generated.ts',
  typescriptServerOutputPath: 'src/generated/syncular.server.generated.ts',
  tables: {
    tasks: syncedTable({
      table: 'tasks',
      subscriptionId: 'sub-tasks',
      scopes: [scope('user_id', { source: 'actorId', required: true })],
      serverVersion: 'server_version',
      sqliteWithoutRowid: true,
    }),
  },
});
