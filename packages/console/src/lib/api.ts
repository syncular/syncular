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

export async function testConnection(client: SyncClient): Promise<void> {
  try {
    const { error, response } = await client.GET('/console/stats');
    if (!error) return;

    const statusCode = response.status;
    let detail: string | null = null;
    if (typeof error === 'string') {
      detail = error;
    } else if (error && typeof error === 'object') {
      const errorRecord = error as Record<string, unknown>;
      const nestedError = errorRecord.error;
      const nestedMessage = errorRecord.message;
      if (typeof nestedError === 'string' && nestedError.length > 0) {
        detail = nestedError;
      } else if (
        typeof nestedMessage === 'string' &&
        nestedMessage.length > 0
      ) {
        detail = nestedMessage;
      } else {
        try {
          detail = JSON.stringify(errorRecord);
        } catch {
          detail = null;
        }
      }
    }

    throw new Error(
      detail && detail.length > 0
        ? `Console API /console/stats returned ${statusCode}: ${detail}`
        : `Console API /console/stats returned ${statusCode}`
    );
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error('Failed to connect to console API');
  }
}
