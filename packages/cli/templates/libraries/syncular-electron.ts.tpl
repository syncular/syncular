/**
 * Syncular Electron module scaffold.
 *
 * Dialect: <%= it.ELECTRON_DIALECT_LABEL %>
 */

import { createClient } from '@syncular/client';
import type { SyncClientDb } from '@syncular/client';
<%= it.ELECTRON_DIALECT_IMPORT %>
import { createHttpTransport } from '@syncular/transport-http';

export const clientDialect = '<%= it.ELECTRON_DIALECT %>';

export function createClientDb<DB extends SyncClientDb>() {
  <%= it.ELECTRON_DB_FACTORY_LINE %>
}

export async function createSyncularElectronClient<DB extends SyncClientDb>(args: {
  actorId: string;
  token: string;
  baseUrl: string;
  tables: string[];
  scopes: string[];
}) {
  const db = createClientDb<DB>();
  return createClient({
    db,
    actorId: args.actorId,
    transport: createHttpTransport({
      baseUrl: args.baseUrl,
      getHeaders: () => ({ Authorization: `Bearer ${args.token}` }),
    }),
    tables: args.tables,
    scopes: args.scopes,
  });
}
