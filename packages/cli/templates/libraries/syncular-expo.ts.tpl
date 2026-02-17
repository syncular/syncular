/**
 * Syncular Expo module scaffold.
 */

import { createClient } from '@syncular/client';
import type { SyncClientDb } from '@syncular/client';
import { createExpoSqliteDb } from '@syncular/dialect-expo-sqlite';
import { createHttpTransport } from '@syncular/transport-http';

export function createClientDb<DB extends SyncClientDb>() {
  return createExpoSqliteDb<DB>({ databaseName: 'app.sqlite' });
}

export async function createSyncularExpoClient<DB extends SyncClientDb>(args: {
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
