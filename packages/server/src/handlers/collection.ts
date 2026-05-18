import {
  assertKnownTableDependencies,
  createTableLookup,
  topologicallySortTablesByDependencies,
  type BinarySnapshotColumn,
  type BinarySnapshotRowsEncoder,
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

export interface ServerSnapshotBinaryMetadata {
  columns: Readonly<
    Record<string, readonly BinarySnapshotColumn[] | undefined>
  >;
  encoders?: Readonly<Record<string, BinarySnapshotRowsEncoder | undefined>>;
}

export interface ServerHandlerCollectionOptions {
  snapshotBinary?: ServerSnapshotBinaryMetadata;
}

function attachSnapshotBinaryMetadata<
  DB extends SyncCoreDb = SyncCoreDb,
  Auth extends SyncServerAuth = SyncServerAuth,
>(
  handler: ServerTableHandler<DB, Auth>,
  metadata: ServerSnapshotBinaryMetadata
): ServerTableHandler<DB, Auth> {
  const generatedColumns = metadata.columns[handler.table];
  const generatedEncoder = metadata.encoders?.[handler.table];
  if (!generatedColumns && !generatedEncoder) return handler;

  return {
    ...handler,
    snapshotBinaryColumns: handler.snapshotBinaryColumns ?? generatedColumns,
    snapshotBinaryEncoder: handler.snapshotBinaryEncoder ?? generatedEncoder,
  };
}

export function createServerHandlerCollection<
  DB extends SyncCoreDb = SyncCoreDb,
  Auth extends SyncServerAuth = SyncServerAuth,
>(
  handlers: ServerTableHandler<DB, Auth>[],
  options: ServerHandlerCollectionOptions = {}
): ServerHandlerCollection<DB, Auth> {
  const snapshotBinary = options.snapshotBinary;
  const resolvedHandlers = snapshotBinary
    ? handlers.map((handler) =>
        attachSnapshotBinaryMetadata(handler, snapshotBinary)
      )
    : handlers;
  const byTable = createTableLookup(
    resolvedHandlers,
    (table) => `Table "${table}" is already registered`
  );
  assertKnownTableDependencies(
    resolvedHandlers,
    byTable,
    (table, dependency) =>
      `Table "${table}" depends on unknown table "${dependency}"`
  );

  return { handlers: resolvedHandlers, byTable };
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
