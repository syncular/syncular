import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createPgliteDb } from '@syncular/dialect-pglite';
import {
  createServerHandler,
  ensureSyncSchema,
  type SyncCoreDb,
} from '@syncular/server';
import { createPostgresServerDialect } from '@syncular/server-dialect-postgres';
import { Hono } from 'hono';
import { defineWebSocketHelper } from 'hono/ws';
import type { Kysely } from 'kysely';
import { createSyncServer } from '../create-server';
import { getSyncWebSocketConnectionManager } from '../routes';
import type { WebSocketConnection } from '../ws';

interface TasksTable {
  id: string;
  user_id: string;
  title: string;
  server_version: number;
}

interface ServerDb extends SyncCoreDb {
  tasks: TasksTable;
}

interface ClientDb {
  tasks: TasksTable;
}

describe('createSyncServer console configuration', () => {
  let db: Kysely<ServerDb>;
  let previousConsoleToken: string | undefined;

  beforeEach(async () => {
    db = createPgliteDb<ServerDb>();
    await ensureSyncSchema(db, createPostgresServerDialect());
    await db.schema
      .createTable('tasks')
      .ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('user_id', 'text', (col) => col.notNull())
      .addColumn('title', 'text', (col) => col.notNull())
      .addColumn('server_version', 'integer', (col) =>
        col.notNull().defaultTo(0)
      )
      .execute();
    previousConsoleToken = process.env.SYNC_CONSOLE_TOKEN;
    delete process.env.SYNC_CONSOLE_TOKEN;
  });

  afterEach(async () => {
    if (previousConsoleToken === undefined) {
      delete process.env.SYNC_CONSOLE_TOKEN;
    } else {
      process.env.SYNC_CONSOLE_TOKEN = previousConsoleToken;
    }
    await db.destroy();
  });

  function createTestHandler() {
    return createServerHandler<ServerDb, ClientDb, 'tasks'>({
      table: 'tasks',
      scopes: ['user:{user_id}'],
      resolveScopes: async (ctx) => ({ user_id: [ctx.actorId] }),
    });
  }

  function createOptions() {
    return {
      db,
      dialect: createPostgresServerDialect(),
      sync: {
        handlers: [createTestHandler()],
        authenticate: async () => ({ actorId: 'u1' }),
      },
    };
  }

  function createConn(args: {
    actorId: string;
    clientId: string;
  }): WebSocketConnection {
    return {
      actorId: args.actorId,
      clientId: args.clientId,
      transportPath: 'direct',
      get isOpen() {
        return true;
      },
      sendSync() {},
      sendHeartbeat() {},
      sendPresence() {},
      sendError() {},
      close() {},
    };
  }

  function createPushRequest(): Request {
    return new Request('http://localhost/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clientId: 'client-1',
        push: {
          clientCommitId: 'commit-1',
          schemaVersion: 1,
          operations: [
            {
              table: 'tasks',
              row_id: 'task-1',
              op: 'upsert',
              payload: {
                id: 'task-1',
                user_id: 'u1',
                title: 'Task 1',
                server_version: 0,
              },
            },
          ],
        },
      }),
    });
  }

  it('keeps console routes disabled when console config is omitted', () => {
    const server = createSyncServer(createOptions());
    expect(server.consoleRoutes).toBeUndefined();
  });

  it('throws when console is enabled without a token', () => {
    const options = createOptions();
    expect(() =>
      createSyncServer({
        ...options,
        console: {},
      })
    ).toThrow(
      'Console is enabled but no token is configured. Set `console.token` or SYNC_CONSOLE_TOKEN.'
    );
  });

  it('accepts SYNC_CONSOLE_TOKEN when console token is omitted', () => {
    process.env.SYNC_CONSOLE_TOKEN = 'env-token';
    const options = createOptions();
    const server = createSyncServer({
      ...options,
      console: {},
    });
    expect(server.consoleRoutes).toBeDefined();
  });

  it('accepts an explicit console token', () => {
    process.env.SYNC_CONSOLE_TOKEN = 'env-token';
    const options = createOptions();
    const server = createSyncServer({
      ...options,
      console: { token: 'explicit-token' },
    });
    expect(server.consoleRoutes).toBeDefined();
  });

  it('returns not implemented when blobBucket is not configured', async () => {
    const options = createOptions();
    const server = createSyncServer({
      ...options,
      console: {
        token: 'console-token',
      },
    });

    const app = new Hono();
    app.route('/console', server.consoleRoutes!);

    const response = await app.request('http://localhost/console/storage', {
      headers: { Authorization: 'Bearer console-token' },
    });

    expect(response.status).toBe(501);
    expect(await response.json()).toEqual({
      error: 'BLOB_STORAGE_NOT_CONFIGURED',
    });
  });

  it('enables storage console routes when blobBucket is configured', async () => {
    const options = createOptions();
    const server = createSyncServer({
      ...options,
      console: {
        token: 'blob-token',
        blobBucket: {
          list: async () => ({
            objects: [
              {
                key: 'hello.txt',
                size: 12,
                uploaded: new Date('2025-01-01T00:00:00.000Z'),
                httpMetadata: { contentType: 'text/plain' },
              },
            ],
            truncated: false,
            cursor: undefined,
          }),
          get: async () => null,
          delete: async () => {},
          head: async () => null,
        },
      },
    });

    const app = new Hono();
    app.route('/console', server.consoleRoutes!);

    const unauthenticated = await app.request(
      'http://localhost/console/storage'
    );
    expect(unauthenticated.status).toBe(401);

    const response = await app.request('http://localhost/console/storage', {
      headers: { Authorization: 'Bearer blob-token' },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      items: [
        {
          key: 'hello.txt',
          size: 12,
          uploaded: '2025-01-01T00:00:00.000Z',
          httpMetadata: { contentType: 'text/plain' },
        },
      ],
      truncated: false,
      cursor: null,
    });
  });

  it('forwards maxConnectionsPerClient from factory to realtime route', async () => {
    const options = createOptions();
    const upgradeWebSocket = defineWebSocketHelper(async () => {});

    const server = createSyncServer({
      ...options,
      upgradeWebSocket,
      routes: {
        websocket: {
          maxConnectionsPerClient: 1,
        },
      },
    });

    const manager = getSyncWebSocketConnectionManager(server.syncRoutes);
    if (!manager) {
      throw new Error('Expected websocket manager to be enabled.');
    }
    manager.register(createConn({ actorId: 'u1', clientId: 'client-1' }), []);

    const app = new Hono();
    app.route('/sync', server.syncRoutes);

    const response = await app.request(
      'http://localhost/sync/realtime?clientId=client-1'
    );
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      error: 'WEBSOCKET_CONNECTION_LIMIT_CLIENT',
    });
  });

  it('forwards maxConnectionsTotal from factory to realtime route', async () => {
    const options = createOptions();
    const upgradeWebSocket = defineWebSocketHelper(async () => {});

    const server = createSyncServer({
      ...options,
      upgradeWebSocket,
      routes: {
        websocket: {
          maxConnectionsTotal: 1,
        },
      },
    });

    const manager = getSyncWebSocketConnectionManager(server.syncRoutes);
    if (!manager) {
      throw new Error('Expected websocket manager to be enabled.');
    }
    manager.register(createConn({ actorId: 'u1', clientId: 'client-1' }), []);

    const app = new Hono();
    app.route('/sync', server.syncRoutes);

    const response = await app.request(
      'http://localhost/sync/realtime?clientId=client-2'
    );
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      error: 'WEBSOCKET_CONNECTION_LIMIT_TOTAL',
    });
  });

  it('emits live console events from sync lifecycle when console is enabled', async () => {
    process.env.SYNC_CONSOLE_TOKEN = 'env-token';
    const options = createOptions();
    const server = createSyncServer({
      ...options,
      console: {},
    });

    const liveEvents: Array<{
      type: string;
      data: Record<string, unknown>;
    }> = [];
    const listener = (event: {
      type: 'push' | 'pull' | 'commit' | 'client_update';
      timestamp: string;
      data: Record<string, unknown>;
    }) => {
      liveEvents.push({ type: event.type, data: event.data });
    };

    server.consoleEventEmitter?.addListener(listener);
    const app = new Hono();
    app.route('/sync', server.syncRoutes);

    const response = await app.request(createPushRequest());
    expect(response.status).toBe(200);

    const emittedTypes = liveEvents.map((event) => event.type);
    expect(emittedTypes).toContain('push');
    expect(emittedTypes).toContain('commit');

    const pushEvent = liveEvents.find((event) => event.type === 'push');
    expect(pushEvent?.data.actorId).toBe('u1');
    expect(pushEvent?.data.clientId).toBe('client-1');

    server.consoleEventEmitter?.removeListener(listener);
  });
});
