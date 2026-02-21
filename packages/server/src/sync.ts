import type {
  ColumnCodecDialect,
  ColumnCodecSource,
  ScopeDefinition,
} from '@syncular/core';
import {
  type CreateServerHandlerOptions,
  createServerHandler,
} from './handlers';
import type { ServerTableHandler, SyncServerAuth } from './handlers/types';
import type { SyncCoreDb } from './schema';

type SharedTableName<ServerDB, ClientDB> = keyof ServerDB &
  keyof ClientDB &
  string;

export type ServerSyncHandlerOptionsForTable<
  ServerDB extends SyncCoreDb,
  ClientDB,
  TableName extends SharedTableName<ServerDB, ClientDB>,
  Auth extends SyncServerAuth,
  ScopeDefs extends readonly ScopeDefinition[],
> = Omit<
  CreateServerHandlerOptions<ServerDB, ClientDB, TableName, Auth, ScopeDefs>,
  'columnCodecs' | 'codecDialect'
>;

export interface ServerSyncConfig<
  ServerDB extends SyncCoreDb = SyncCoreDb,
  Auth extends SyncServerAuth = SyncServerAuth,
> {
  authenticate: (request: Request) => Promise<Auth | null> | Auth | null;
  handlers: ServerTableHandler<ServerDB, Auth>[];
}

export interface DefineServerSyncOptions<Auth extends SyncServerAuth> {
  authenticate: (request: Request) => Promise<Auth | null> | Auth | null;
  codecs?: ColumnCodecSource;
  codecDialect?: ColumnCodecDialect;
}

export interface ServerSyncBuilder<
  ServerDB extends SyncCoreDb,
  ClientDB,
  ScopeDefs extends readonly ScopeDefinition[],
  Auth extends SyncServerAuth,
> extends ServerSyncConfig<ServerDB, Auth> {
  addHandler<TableName extends SharedTableName<ServerDB, ClientDB>>(
    options: ServerSyncHandlerOptionsForTable<
      ServerDB,
      ClientDB,
      TableName,
      Auth,
      ScopeDefs
    >
  ): this;
}

export function defineServerSync<
  ServerDB extends SyncCoreDb,
  ClientDB,
  ScopeDefs extends readonly ScopeDefinition[],
  Auth extends SyncServerAuth,
>(
  options: DefineServerSyncOptions<Auth>
): ServerSyncBuilder<ServerDB, ClientDB, ScopeDefs, Auth> {
  const handlers: ServerTableHandler<ServerDB, Auth>[] = [];
  const registeredTables = new Set<string>();

  const sync: ServerSyncBuilder<ServerDB, ClientDB, ScopeDefs, Auth> = {
    authenticate: options.authenticate,
    handlers,
    addHandler<TableName extends SharedTableName<ServerDB, ClientDB>>(
      handlerOptions: ServerSyncHandlerOptionsForTable<
        ServerDB,
        ClientDB,
        TableName,
        Auth,
        ScopeDefs
      >
    ) {
      if (registeredTables.has(handlerOptions.table)) {
        throw new Error(
          `Server table handler already registered: ${handlerOptions.table}`
        );
      }

      handlers.push(
        createServerHandler({
          ...handlerOptions,
          columnCodecs: options.codecs,
          codecDialect: options.codecDialect,
        })
      );
      registeredTables.add(handlerOptions.table);
      return sync;
    },
  };

  return sync;
}
