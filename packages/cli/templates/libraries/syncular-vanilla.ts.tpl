/**
 * Syncular vanilla module scaffold.
 *
 * Dialect: <%= it.CLIENT_DIALECT_LABEL %>
 */

import { createClient } from '@syncular/client';
import type { SyncClientDb } from '@syncular/client';
<%= it.CLIENT_DIALECT_IMPORT %>
import { createHttpTransport } from '@syncular/transport-http';

export const clientDialect = '<%= it.CLIENT_DIALECT %>';

export function createClientDb<DB extends SyncClientDb>() {
  <%= it.CLIENT_DB_FACTORY_LINE %>
}

export async function createSyncularClient<DB extends SyncClientDb>(args: {
  actorId: string;
  token: string;
  baseUrl: string;
  tables: string[];
  scopes: string[];
}) {
  const db = createClientDb<DB>();
  const transport = createHttpTransport({
    baseUrl: args.baseUrl,
    getHeaders: () => ({ Authorization: `Bearer ${args.token}` }),
  });

  return createClient({
    db,
    actorId: args.actorId,
    transport,
    tables: args.tables,
    scopes: args.scopes,
  });
}
