import type {
  ColumnCodecDialect,
  ColumnCodecSource,
  ScopeDefinition,
  ScopeValue,
  ScopeValuesFromPatterns,
  SyncSubscriptionRequest,
} from '@syncular/core';
import {
  type CreateClientHandlerOptions,
  createClientHandler,
} from './handlers/create-handler';
import type { ClientTableHandler } from './handlers/types';
import type { SyncClientDb } from './schema';

type ClientSyncSubscription<ScopeDefs extends readonly ScopeDefinition[]> =
  Omit<SyncSubscriptionRequest, 'cursor' | 'table' | 'scopes'> & {
    table: string;
    scopes?: ScopeValuesFromPatterns<ScopeDefs>;
  };

type SharedTableName<DB extends SyncClientDb> = keyof DB & string;

export type ClientSyncHandlerOptionsForTable<
  DB extends SyncClientDb,
  TableName extends SharedTableName<DB>,
  ScopeDefs extends readonly ScopeDefinition[],
  Identity,
> = Omit<
  CreateClientHandlerOptions<DB, TableName, ScopeDefs>,
  'columnCodecs' | 'codecDialect' | 'subscribe'
> & {
  columnCodecs?: ColumnCodecSource;
  codecDialect?: ColumnCodecDialect;
  subscribe?:
    | ClientSyncSubscription<ScopeDefs>
    | ClientSyncSubscription<ScopeDefs>[]
    | null
    | ((args: {
        identity: Identity;
      }) =>
        | ClientSyncSubscription<ScopeDefs>
        | ClientSyncSubscription<ScopeDefs>[]
        | null);
};

export interface ClientSyncConfig<
  DB extends SyncClientDb = SyncClientDb,
  Identity = { actorId: string },
> {
  handlers: ClientTableHandler<DB>[];
  subscriptions(
    identity: Identity
  ): Array<Omit<SyncSubscriptionRequest, 'cursor'>>;
}

export interface DefineClientSyncOptions {
  codecs?: ColumnCodecSource;
  codecDialect?: ColumnCodecDialect;
}

export interface ClientSyncBuilder<
  DB extends SyncClientDb,
  ScopeDefs extends readonly ScopeDefinition[],
  Identity,
> extends ClientSyncConfig<DB, Identity> {
  addHandler<TableName extends SharedTableName<DB>>(
    options: ClientSyncHandlerOptionsForTable<
      DB,
      TableName,
      ScopeDefs,
      Identity
    >
  ): this;
}

export function defineClientSync<
  DB extends SyncClientDb,
  ScopeDefs extends readonly ScopeDefinition[],
  Identity,
>(
  options: DefineClientSyncOptions
): ClientSyncBuilder<DB, ScopeDefs, Identity> {
  const handlers: ClientTableHandler<DB>[] = [];
  const registeredTables = new Set<string>();
  const subscriptionsByTable = new Map<
    string,
    ClientSyncHandlerOptionsForTable<
      DB,
      SharedTableName<DB>,
      ScopeDefs,
      Identity
    >['subscribe']
  >();

  const toScopeValues = (
    value: ScopeValuesFromPatterns<ScopeDefs> | undefined
  ): Record<string, ScopeValue> => {
    const result: Record<string, ScopeValue> = {};
    for (const [key, scopeValue] of Object.entries(
      (value ?? {}) as Record<string, ScopeValue | undefined>
    )) {
      if (scopeValue === undefined) continue;
      result[key] = scopeValue;
    }
    return result;
  };

  const sync: ClientSyncBuilder<DB, ScopeDefs, Identity> = {
    handlers,
    addHandler<TableName extends SharedTableName<DB>>(
      handlerOptions: ClientSyncHandlerOptionsForTable<
        DB,
        TableName,
        ScopeDefs,
        Identity
      >
    ) {
      if (registeredTables.has(handlerOptions.table)) {
        throw new Error(
          `Client table handler already registered: ${handlerOptions.table}`
        );
      }

      handlers.push(
        createClientHandler({
          ...handlerOptions,
          subscribe: false,
          columnCodecs: options.codecs,
          codecDialect: options.codecDialect,
        })
      );
      subscriptionsByTable.set(
        handlerOptions.table,
        handlerOptions.subscribe as ClientSyncHandlerOptionsForTable<
          DB,
          SharedTableName<DB>,
          ScopeDefs,
          Identity
        >['subscribe']
      );
      registeredTables.add(handlerOptions.table);
      return sync;
    },
    subscriptions(
      identity: Identity
    ): Array<Omit<SyncSubscriptionRequest, 'cursor'>> {
      const resolved: Array<Omit<SyncSubscriptionRequest, 'cursor'>> = [];
      for (const [table, subscribe] of subscriptionsByTable.entries()) {
        if (!subscribe) continue;
        const value =
          typeof subscribe === 'function' ? subscribe({ identity }) : subscribe;
        if (!value) continue;
        const entries = Array.isArray(value) ? value : [value];
        for (const entry of entries) {
          resolved.push({
            id: entry.id,
            table: entry.table ?? table,
            scopes: toScopeValues(entry.scopes),
            params: entry.params,
            bootstrapState: entry.bootstrapState,
          });
        }
      }
      return resolved;
    },
  };

  return sync;
}
