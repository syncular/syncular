import {
  createTableLookup,
} from '@syncular/core';
import type { ProxyTableHandler } from './types';

export interface ProxyHandlerCollection {
  handlers: ProxyTableHandler[];
  byTable: ReadonlyMap<string, ProxyTableHandler>;
}

export function createProxyHandlerCollection(
  handlers: ProxyTableHandler[]
): ProxyHandlerCollection {
  const byTable = createTableLookup(
    handlers,
    (table) => `Proxy table handler already registered: ${table}`
  );
  return { handlers, byTable };
}
