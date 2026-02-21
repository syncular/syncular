import type { ProxyTableHandler } from './types';

export interface ProxyHandlerCollection {
  handlers: ProxyTableHandler[];
  byTable: ReadonlyMap<string, ProxyTableHandler>;
}

export function createProxyHandlerCollection(
  handlers: ProxyTableHandler[]
): ProxyHandlerCollection {
  const byTable = new Map<string, ProxyTableHandler>();
  for (const handler of handlers) {
    if (byTable.has(handler.table)) {
      throw new Error(
        `Proxy table handler already registered: ${handler.table}`
      );
    }
    byTable.set(handler.table, handler);
  }
  return { handlers, byTable };
}

export function getProxyHandler(
  collection: ProxyHandlerCollection,
  tableName: string
): ProxyTableHandler | undefined {
  return collection.byTable.get(tableName);
}

export function getProxyHandlerOrThrow(
  collection: ProxyHandlerCollection,
  tableName: string
): ProxyTableHandler {
  const handler = collection.byTable.get(tableName);
  if (!handler) {
    throw new Error(`No proxy table handler for table: ${tableName}`);
  }
  return handler;
}
