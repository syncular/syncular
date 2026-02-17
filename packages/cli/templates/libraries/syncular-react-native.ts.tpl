/**
 * Syncular React Native module scaffold (Nitro SQLite).
 */

import { createClient } from '@syncular/client';
import type { SyncClientDb } from '@syncular/client';
import { createNitroSqliteDb } from '@syncular/dialect-react-native-nitro-sqlite';
import { createHttpTransport } from '@syncular/transport-http';

export function createClientDb<DB extends SyncClientDb>() {
  return createNitroSqliteDb<DB>({ name: 'app.sqlite' });
}

export async function createSyncularReactNativeClient<DB extends SyncClientDb>(args: {
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
