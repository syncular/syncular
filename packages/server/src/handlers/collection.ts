import {
  assertKnownTableDependencies,
  createTableLookup,
  topologicallySortTablesByDependencies,
} from '@syncular/core';
import type { SyncCoreDb } from '../schema';
import type { ServerTableHandler, SyncServerAuth } from './types';

export interface ServerHandlerCollection<
  DB extends SyncCoreDb = SyncCoreDb,
  Auth extends SyncServerAuth = SyncServerAuth,
> {
  handlers: ServerTableHandler<DB, Auth>[];
  byTable: ReadonlyMap<string, ServerTableHandler<DB, Auth>>;
}

export function createServerHandlerCollection<
  DB extends SyncCoreDb = SyncCoreDb,
  Auth extends SyncServerAuth = SyncServerAuth,
>(handlers: ServerTableHandler<DB, Auth>[]): ServerHandlerCollection<DB, Auth> {
  const byTable = createTableLookup(
    handlers,
    (table) => `Table "${table}" is already registered`
  );
  assertKnownTableDependencies(
    handlers,
    byTable,
    (table, dependency) =>
      `Table "${table}" depends on unknown table "${dependency}"`
  );

  return { handlers, byTable };
}

export function getServerBootstrapOrder<
  DB extends SyncCoreDb = SyncCoreDb,
  Auth extends SyncServerAuth = SyncServerAuth,
>(
  collection: ServerHandlerCollection<DB, Auth>
): ServerTableHandler<DB, Auth>[] {
  return topologicallySortTablesByDependencies(collection.byTable);
}

export function getServerBootstrapOrderFor<
  DB extends SyncCoreDb = SyncCoreDb,
  Auth extends SyncServerAuth = SyncServerAuth,
>(
  collection: ServerHandlerCollection<DB, Auth>,
  table: string
): ServerTableHandler<DB, Auth>[] {
  return topologicallySortTablesByDependencies(collection.byTable, table);
}
