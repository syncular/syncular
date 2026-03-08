import createClient from 'openapi-fetch';
import type { operations, paths } from './generated/api';
import type { ClientOptions } from './shared';

export type SyncClient = ReturnType<typeof createClient<paths>>;
export type { operations };

/**
 * Create a typed API client for the full Syncular API.
 *
 * Returns an openapi-fetch client with full type safety for all endpoints.
 */
export function createApiClient(options: ClientOptions): SyncClient {
  const client = createClient<paths>({
    baseUrl: options.baseUrl,
    ...(options.fetch && { fetch: options.fetch }),
  });

  const getHeaders = options.getHeaders;
  const transportPath = options.transportPath ?? 'direct';

  client.use({
    async onRequest({ request }) {
      if (getHeaders) {
        const headers = await getHeaders();
        for (const [key, value] of Object.entries(headers)) {
          request.headers.set(key, value);
        }
      }

      if (!request.headers.has('x-syncular-transport-path')) {
        request.headers.set('x-syncular-transport-path', transportPath);
      }

      return request;
    },
  });

  return client;
}
