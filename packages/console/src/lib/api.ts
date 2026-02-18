/**
 * Console API client - uses generated types from @syncular/transport-http
 */

import { createApiClient, type SyncClient } from '@syncular/transport-http';

export interface ConnectionConfig {
  serverUrl: string;
  token: string;
}

export function createConsoleClient(config: ConnectionConfig): SyncClient {
  return createApiClient({
    baseUrl: config.serverUrl,
    getHeaders: () => ({ Authorization: `Bearer ${config.token}` }),
  });
}

export async function testConnection(client: SyncClient): Promise<boolean> {
  try {
    const { error } = await client.GET('/console/stats');
    return !error;
  } catch {
    return false;
  }
}
