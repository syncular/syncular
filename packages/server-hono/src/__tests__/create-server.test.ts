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
      handlers: [createTestHandler()],
      authenticate: async () => ({ actorId: 'u1' }),
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

  it('forwards maxConnectionsPerClient from factory to realtime route', async () => {
    const options = createOptions();
    const upgradeWebSocket = defineWebSocketHelper(async () => {});

    const server = createSyncServer({
      ...options,
      upgradeWebSocket,
      sync: {
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
      sync: {
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
});
