import { defineSyncularClient, scope, syncedTable } from '@syncular/typegen';

/**
 * Syncular app contract for the split-view demo.
 *
 * The schema lives in migrations/*.sql; this file describes how the synced
 * tables map to subscriptions and scopes. Run `bun run codegen` (or
 * `syncular generate`) to refresh the generated client and server modules
 * under src/generated/.
 *
 * `typescriptRuntimeImportPath` is omitted on purpose: the generated client
 * then imports its runtime from the published `@syncular/client` package,
 * exactly like an app outside this repository would.
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
