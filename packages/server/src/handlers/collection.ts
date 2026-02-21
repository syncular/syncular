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
  const byTable = new Map<string, ServerTableHandler<DB, Auth>>();

  for (const handler of handlers) {
    if (byTable.has(handler.table)) {
      throw new Error(`Table "${handler.table}" is already registered`);
    }
    byTable.set(handler.table, handler);
  }

  for (const handler of handlers) {
    for (const dep of handler.dependsOn ?? []) {
      if (!byTable.has(dep)) {
        throw new Error(
          `Table "${handler.table}" depends on unknown table "${dep}"`
        );
      }
    }
  }

  return { handlers, byTable };
}

export function getServerHandler<
  DB extends SyncCoreDb = SyncCoreDb,
  Auth extends SyncServerAuth = SyncServerAuth,
>(
  collection: ServerHandlerCollection<DB, Auth>,
  table: string
): ServerTableHandler<DB, Auth> | undefined {
  return collection.byTable.get(table);
}

export function getServerHandlerOrThrow<
  DB extends SyncCoreDb = SyncCoreDb,
  Auth extends SyncServerAuth = SyncServerAuth,
>(
  collection: ServerHandlerCollection<DB, Auth>,
  table: string
): ServerTableHandler<DB, Auth> {
  const handler = collection.byTable.get(table);
  if (!handler) throw new Error(`Unknown table: ${table}`);
  return handler;
}

function topoSortTables<
  DB extends SyncCoreDb = SyncCoreDb,
  Auth extends SyncServerAuth = SyncServerAuth,
>(
  collection: ServerHandlerCollection<DB, Auth>,
  targetTable?: string
): ServerTableHandler<DB, Auth>[] {
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const sorted: ServerTableHandler<DB, Auth>[] = [];

  const visit = (table: string) => {
    if (visited.has(table)) return;
    if (visiting.has(table)) {
      throw new Error(
        `Circular dependency detected involving table "${table}"`
      );
    }

    const handler = collection.byTable.get(table);
    if (!handler) {
      throw new Error(`Unknown table: ${table}`);
    }

    visiting.add(table);
    for (const dep of handler.dependsOn ?? []) {
      visit(dep);
    }
    visiting.delete(table);
    visited.add(table);
    sorted.push(handler);
  };

  if (targetTable) {
    visit(targetTable);
    return sorted;
  }

  for (const table of collection.byTable.keys()) {
    visit(table);
  }
  return sorted;
}

export function getServerBootstrapOrder<
  DB extends SyncCoreDb = SyncCoreDb,
  Auth extends SyncServerAuth = SyncServerAuth,
>(
  collection: ServerHandlerCollection<DB, Auth>
): ServerTableHandler<DB, Auth>[] {
  return topoSortTables(collection);
}

export function getServerBootstrapOrderFor<
  DB extends SyncCoreDb = SyncCoreDb,
  Auth extends SyncServerAuth = SyncServerAuth,
>(
  collection: ServerHandlerCollection<DB, Auth>,
  table: string
): ServerTableHandler<DB, Auth>[] {
  return topoSortTables(collection, table);
}
