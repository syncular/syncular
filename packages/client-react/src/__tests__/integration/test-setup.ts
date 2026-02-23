/**
 * Integration test setup for @syncular/client-react.
 *
 * Reuses the shared @syncular/testkit fixtures to keep a single
 * implementation of server/client setup logic.
 */

import type { SyncClientPlugin } from '@syncular/client';
import {
  createEngineTestClient,
  createTestServer as createFixtureServer,
  type EngineTestClient,
  type TestServer,
} from '@syncular/testkit';

export type TestClient = EngineTestClient;
export type { TestServer };

export async function createTestServer(): Promise<TestServer> {
  return createFixtureServer('pglite');
}

export async function createTestClient(
  server: TestServer,
  options: {
    actorId: string;
    clientId: string;
    plugins?: SyncClientPlugin[];
  }
): Promise<TestClient> {
  return createEngineTestClient(server, {
    actorId: options.actorId,
    clientId: options.clientId,
    plugins: options.plugins,
    subscriptions: [
      {
        id: 'my-tasks',
        table: 'tasks',
        scopes: { user_id: options.actorId },
      },
    ],
    pollIntervalMs: 999999,
    realtimeEnabled: false,
  });
}

export async function destroyTestClient(client: TestClient): Promise<void> {
  await client.destroy();
}

export async function destroyTestServer(server: TestServer): Promise<void> {
  await server.destroy();
}
