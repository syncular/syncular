import { afterEach, describe, expect, it } from 'bun:test';
import { createDatabase } from '@syncular/core';
import { Hono } from 'hono';
import { upgradeWebSocket, websocket } from 'hono/bun';
import type { Kysely } from 'kysely';
import { createBunSqliteDialect } from '../../../../../packages/dialect-bun-sqlite/src';
import {
  createServerHandler,
  ensureSyncSchema,
} from '../../../../../packages/server/src';
import { createSqliteServerDialect } from '../../../../../packages/server-dialect-sqlite/src';
import {
  createSyncRoutes,
  getSyncWebSocketConnectionManager,
} from '../../../../../packages/server-hono/src/routes';
import {
  newTaskOperation,
  syncularGeneratedCodecs,
  taskSubscription,
} from '../../../../examples/todo-app/generated/typescript/syncular.generated';
import type { SyncularV2Client, SyncularV2LiveQueryEvent } from '../types';
import { createSyncularV2WorkerClient } from '../worker-client';
import {
  ensureHonoSyncTasksTable,
  type HonoAuthContext,
  type HonoSyncClientDb,
  type HonoSyncServerDb,
} from './fixtures/hono-sync-harness';

const ACTOR_ID = 'user-realtime';
const AUTHORIZATION = 'Bearer realtime-token';
const REALTIME_TOKEN = 'realtime-token';

describe('Syncular v2 worker realtime against Hono websocket routes', () => {
  const clients: SyncularV2Client[] = [];
  const servers: Array<ReturnType<typeof Bun.serve>> = [];
  const dbs: Array<Kysely<HonoSyncServerDb>> = [];

  afterEach(async () => {
    while (clients.length > 0) await clients.pop()!.close();
    while (servers.length > 0) servers.pop()!.stop(true);
    while (dbs.length > 0) await dbs.pop()!.destroy();
  });

  it('pulls and emits live-query updates after server websocket wakeups', async () => {
    const { baseUrl, connectionCount } = await openRealtimeServer();
    const clientA = await openClient({
      baseUrl,
      clientId: 'client-rust-realtime-a',
    });
    await clientA.setSubscriptions([taskSubscription({ actorId: ACTOR_ID })]);
    await clientA.syncOnce();

    const snapshot = await clientA.subscribeQuery<{
      id: string;
      title: string;
      user_id: string;
    }>('select id, title, user_id from tasks order by id', [], ['tasks']);
    expect(snapshot.rows).toEqual([]);

    await clientA.startRealtime({
      wsUrl: `${baseUrl.replace(/^http:/, 'ws:')}/realtime`,
      params: { token: REALTIME_TOKEN },
      heartbeatTimeoutMs: 0,
      initialReconnectDelayMs: 50,
    });
    await waitFor(() => connectionCount() === 1);
    const liveEvent = waitForLiveEvent(clientA, snapshot.id);

    const clientB = await openClient({
      baseUrl,
      clientId: 'client-rust-realtime-b',
    });
    await clientB.applyLocalOperation(
      newTaskOperation({
        id: 'realtime-task',
        title: 'Realtime task',
        user_id: ACTOR_ID,
      }),
      {
        id: 'realtime-task',
        title: 'Realtime task',
        completed: 0,
        user_id: ACTOR_ID,
        project_id: null,
        server_version: 0,
        image: null,
        title_yjs_state: null,
      }
    );
    await expect(clientB.syncPush()).resolves.toMatchObject({
      pushedCommits: 1,
    });

    await expect(liveEvent).resolves.toMatchObject({
      queryId: snapshot.id,
      rows: [
        {
          id: 'realtime-task',
          title: 'Realtime task',
          user_id: ACTOR_ID,
        },
      ],
    });
  });

  async function openRealtimeServer(): Promise<RealtimeServerHarness> {
    const dialect = createSqliteServerDialect();
    const db = createDatabase<HonoSyncServerDb>({
      dialect: createBunSqliteDialect({ path: ':memory:' }),
      family: 'sqlite',
    });
    dbs.push(db);
    await ensureSyncSchema(db, dialect);
    await ensureHonoSyncTasksTable(db);

    const routes = createSyncRoutes<HonoSyncServerDb, HonoAuthContext>({
      db,
      dialect,
      handlers: [
        createServerHandler<
          HonoSyncServerDb,
          HonoSyncClientDb,
          'tasks',
          HonoAuthContext
        >({
          table: 'tasks',
          scopes: ['user:{user_id}'],
          codecs: syncularGeneratedCodecs,
          resolveScopes: async (ctx) => ({ user_id: [ctx.actorId] }),
        }),
      ],
      authenticate: async (c) => {
        const authorization = c.req.header('authorization');
        const token = c.req.query('token');
        if (authorization === AUTHORIZATION || token === REALTIME_TOKEN) {
          return { actorId: ACTOR_ID };
        }
        return null;
      },
      sync: {
        rateLimit: false,
        websocket: {
          enabled: true,
          upgradeWebSocket,
          heartbeatIntervalMs: 0,
          allowedOrigins: '*',
        },
      },
    });
    const connectionManager = getSyncWebSocketConnectionManager(routes);
    if (!connectionManager) {
      throw new Error('Expected Hono sync websocket manager');
    }

    const app = new Hono().route('/sync', routes);
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: app.fetch,
      websocket,
      idleTimeout: 0,
    });
    servers.push(server);

    return {
      baseUrl: `http://127.0.0.1:${server.port}/sync`,
      connectionCount: () => connectionManager.getTotalConnections(),
    };
  }

  async function openClient(options: {
    baseUrl: string;
    clientId: string;
  }): Promise<SyncularV2Client> {
    const client = await createSyncularV2WorkerClient({
      requestTimeoutMs: 10_000,
      getHeaders: () => ({ authorization: AUTHORIZATION }),
      config: {
        baseUrl: options.baseUrl,
        clientId: options.clientId,
        actorId: ACTOR_ID,
        fileName: `${options.clientId}.sqlite`,
        storage: 'memory',
        clearOnInit: true,
      },
    });
    clients.push(client);
    return client;
  }
});

interface RealtimeServerHarness {
  baseUrl: string;
  connectionCount(): number;
}

function waitForLiveEvent(
  client: SyncularV2Client,
  queryId: string
): Promise<SyncularV2LiveQueryEvent<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      client.removeLiveQueryListener(queryId);
      reject(new Error('Timed out waiting for realtime live query event'));
    }, 5_000);
    client.addLiveQueryListener(queryId, (event) => {
      clearTimeout(timeout);
      client.removeLiveQueryListener(queryId);
      resolve(event);
    });
  });
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for realtime condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
