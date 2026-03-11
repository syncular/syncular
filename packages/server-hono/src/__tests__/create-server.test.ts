import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createDatabase } from '@syncular/core';
import { createPgliteDialect } from '@syncular/dialect-pglite';
import {
  createServerHandler,
  ensureSyncSchema,
  type SyncCoreDb,
} from '@syncular/server';
import { createPostgresServerDialect } from '@syncular/server-dialect-postgres';
import { Hono } from 'hono';
import { defineWebSocketHelper, WSContext, type WSEvents } from 'hono/ws';
import { type Kysely, sql } from 'kysely';
import {
  createSyncServer,
  resolveDefaultWebSocketAllowedOrigins,
} from '../create-server';
import { getSyncWebSocketConnectionManager } from '../routes';
import {
  createWebSocketConnectionOwnerKey,
  type WebSocketConnection,
} from '../ws';

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

describe('createSyncServer console configuration', () => {
  let db: Kysely<ServerDb>;
  let previousConsoleToken: string | undefined;

  beforeEach(async () => {
    db = createDatabase<ServerDb>({
      dialect: createPgliteDialect(),
      family: 'postgres',
    });
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
      ownerKey: createWebSocketConnectionOwnerKey({
        partitionId: 'default',
        actorId: args.actorId,
        clientId: args.clientId,
      }),
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

  function createUpstreamSocketHarness() {
    const messages: Array<Record<string, unknown>> = [];
    const closes: Array<{ code?: number; reason?: string }> = [];

    const ws = new WSContext({
      readyState: 1,
      send(data) {
        if (typeof data !== 'string') return;
        const parsed = JSON.parse(data);
        if (isRecord(parsed)) {
          messages.push(parsed);
        }
      },
      close(code, reason) {
        closes.push({ code, reason });
      },
    });

    return {
      ws,
      messages,
      closes,
    };
  }

  function createPushRequest(args?: {
    requestId?: string;
    title?: string;
    clientId?: string;
    headers?: Record<string, string>;
  }): Request {
    return new Request('http://localhost/sync', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(args?.requestId ? { 'x-request-id': args.requestId } : {}),
        ...args?.headers,
      },
      body: JSON.stringify({
        clientId: args?.clientId ?? 'client-1',
        push: {
          commits: [
            {
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
                    title: args?.title ?? 'Task 1',
                    server_version: 0,
                  },
                },
              ],
            },
          ],
        },
      }),
    });
  }

  function createPullRequest(args: {
    clientId: string;
    userId: string;
    subscriptionUserId: string;
  }): Request {
    return new Request('http://localhost/sync', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-user-id': args.userId,
      },
      body: JSON.stringify({
        clientId: args.clientId,
        pull: {
          limitCommits: 10,
          subscriptions: [
            {
              id: 'tasks-sub',
              table: 'tasks',
              scopes: { user_id: args.subscriptionUserId },
              cursor: -1,
            },
          ],
        },
      }),
    });
  }

  function parseSnapshotValue(value: unknown): unknown {
    if (typeof value !== 'string') {
      return value;
    }
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  async function waitForRequestEventRow(requestId: string): Promise<{
    payload_ref: string | null;
  }> {
    for (let attempt = 0; attempt < 40; attempt++) {
      const result = await sql<{ payload_ref: string | null }>`
        SELECT payload_ref
        FROM sync_request_events
        WHERE request_id = ${requestId}
        ORDER BY event_id DESC
        LIMIT 1
      `.execute(db);

      const row = result.rows[0];
      if (row) {
        return row;
      }

      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    throw new Error(`Timed out waiting for request event: ${requestId}`);
  }

  async function waitForRequestPayloadSnapshot(
    payloadRef: string
  ): Promise<unknown> {
    for (let attempt = 0; attempt < 40; attempt++) {
      const result = await sql<{ request_payload: unknown | null }>`
        SELECT request_payload
        FROM sync_request_payloads
        WHERE payload_ref = ${payloadRef}
        LIMIT 1
      `.execute(db);

      const row = result.rows[0];
      if (row && row.request_payload !== null) {
        return parseSnapshotValue(row.request_payload);
      }

      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    throw new Error(`Timed out waiting for payload snapshot: ${payloadRef}`);
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

  it('treats destroyed-driver console schema races as benign during startup', async () => {
    const options = createOptions();
    const dialect = createPostgresServerDialect();
    dialect.ensureConsoleSchema = async () => {
      throw new Error('driver has already been destroyed');
    };

    const server = createSyncServer({
      ...options,
      dialect,
      console: {
        token: 'console-token',
        maintenance: {
          autoPruneIntervalMs: Number.MAX_SAFE_INTEGER,
        },
      },
    });

    const app = new Hono();
    app.route('/console', server.consoleRoutes!);

    const originalConsoleError = console.error;
    const consoleErrorCalls: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      consoleErrorCalls.push(args);
    };

    try {
      const response = await app.request('http://localhost/console/storage', {
        headers: { Authorization: 'Bearer console-token' },
      });
      expect(response.status).toBe(501);
      expect(await response.json()).toEqual({
        error: 'BLOB_STORAGE_NOT_CONFIGURED',
      });
      expect(consoleErrorCalls).toEqual([]);
    } finally {
      console.error = originalConsoleError;
    }
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

  it('forwards websocket allowedOrigins from factory to realtime route', async () => {
    const options = createOptions();
    const upgradeWebSocket = defineWebSocketHelper(async () => {});

    const server = createSyncServer({
      ...options,
      upgradeWebSocket,
      routes: {
        websocket: {
          allowedOrigins: ['https://allowed.syncular.test'],
        },
      },
    });

    const app = new Hono();
    app.route('/sync', server.syncRoutes);

    const response = await app.request(
      'http://localhost/sync/realtime?clientId=client-3'
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'FORBIDDEN_ORIGIN',
    });
  });

  it('accepts simple sync CORS allowlists without a custom resolver', async () => {
    const options = createOptions();
    const server = createSyncServer({
      ...options,
      routes: {
        cors: {
          allowedOrigins: ['https://allowed.syncular.test'],
        },
      },
    });

    const app = new Hono();
    app.route('/sync', server.syncRoutes);

    const allowedPreflight = await app.request(
      new Request('http://localhost/sync', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://allowed.syncular.test',
          'Access-Control-Request-Method': 'POST',
        },
      })
    );
    expect(allowedPreflight.status).toBe(204);
    expect(allowedPreflight.headers.has('Access-Control-Allow-Origin')).toBe(
      true
    );
  });

  it('defaults websocket allowedOrigins from sync CORS allowlists', async () => {
    expect(
      resolveDefaultWebSocketAllowedOrigins({
        cors: {
          allowedOrigins: ['https://allowed.syncular.test'],
        },
      })
    ).toEqual(['https://allowed.syncular.test']);
  });

  it('allows same-origin realtime websocket upgrades when allowedOrigins is unset', async () => {
    const options = createOptions();
    let capturedEvents: WSEvents | null = null;
    const upgradeWebSocket = defineWebSocketHelper(async (_c, events) => {
      capturedEvents = events;
      return new Response(null, { status: 200 });
    });

    const server = createSyncServer({
      ...options,
      upgradeWebSocket,
    });

    const app = new Hono();
    app.route('/sync', server.syncRoutes);

    const response = await app.request(
      'http://localhost/sync/realtime?clientId=client-origin-default',
      {
        headers: {
          Origin: 'http://localhost',
        },
      }
    );

    expect(response.status).toBe(200);
    expect(capturedEvents).not.toBeNull();
  });

  it('rejects realtime hijack attempts before websocket upgrade', async () => {
    const options = createOptions();
    let capturedEvents: WSEvents | null = null;
    const upgradeWebSocket = defineWebSocketHelper(async (_c, events) => {
      capturedEvents = events;
      return new Response(null, { status: 200 });
    });

    const server = createSyncServer({
      ...options,
      upgradeWebSocket,
      sync: {
        ...options.sync,
        authenticate: async (request) => {
          const actorId = request.headers.get('x-user-id');
          return actorId ? { actorId } : null;
        },
      },
    });

    const app = new Hono();
    app.route('/sync', server.syncRoutes);

    const seedResponse = await app.request(
      createPushRequest({
        clientId: 'shared-client',
        headers: {
          'x-user-id': 'u1',
        },
      })
    );
    expect(seedResponse.status).toBe(200);

    const hijackResponse = await app.request(
      'http://localhost/sync/realtime?clientId=shared-client',
      {
        headers: {
          'x-user-id': 'u2',
          Origin: 'http://localhost',
        },
      }
    );

    expect(hijackResponse.status).toBe(400);
    expect(await hijackResponse.json()).toEqual({
      error: 'INVALID_CLIENT_ID',
      message: 'clientId is already bound to a different actor',
    });
    expect(capturedEvents).toBeNull();
  });

  it('allows stale-scope rebinding after a fully revoked pull', async () => {
    const options = createOptions();
    const server = createSyncServer({
      ...options,
      sync: {
        ...options.sync,
        authenticate: async (request) => {
          const actorId = request.headers.get('x-user-id');
          return actorId ? { actorId } : null;
        },
      },
    });

    const app = new Hono();
    app.route('/sync', server.syncRoutes);

    const initialPull = await app.request(
      createPullRequest({
        clientId: 'shared-client',
        userId: 'u1',
        subscriptionUserId: 'u1',
      })
    );
    expect(initialPull.status).toBe(200);

    const revokedPull = await app.request(
      createPullRequest({
        clientId: 'shared-client',
        userId: 'u2',
        subscriptionUserId: 'u1',
      })
    );
    expect(revokedPull.status).toBe(200);
    expect(await revokedPull.json()).toMatchObject({
      ok: true,
      pull: {
        subscriptions: [
          {
            id: 'tasks-sub',
            status: 'revoked',
          },
        ],
      },
    });

    const reboundPull = await app.request(
      createPullRequest({
        clientId: 'shared-client',
        userId: 'u2',
        subscriptionUserId: 'u2',
      })
    );
    expect(reboundPull.status).toBe(200);
    expect(await reboundPull.json()).toMatchObject({
      ok: true,
      pull: {
        subscriptions: [
          {
            id: 'tasks-sub',
            status: 'active',
          },
        ],
      },
    });
  });

  it('forwards websocket allowedOrigins from factory to console live route', async () => {
    const options = createOptions();
    const upgradeWebSocket = defineWebSocketHelper(async () => {});

    const server = createSyncServer({
      ...options,
      upgradeWebSocket,
      console: { token: 'console-token' },
      routes: {
        websocket: {
          allowedOrigins: ['https://allowed.syncular.test'],
        },
      },
    });

    const app = new Hono();
    app.route('/console', server.consoleRoutes!);

    const response = await app.request('http://localhost/console/events/live');
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'FORBIDDEN_ORIGIN',
    });
  });

  it('enforces inbound websocket message rate limits per connection', async () => {
    const options = createOptions();
    let capturedEvents: WSEvents | null = null;
    const upgradeWebSocket = defineWebSocketHelper(async (_c, events) => {
      capturedEvents = events;
      return new Response(null, { status: 200 });
    });

    const server = createSyncServer({
      ...options,
      upgradeWebSocket,
      routes: {
        websocket: {
          maxMessagesPerWindow: 2,
          messageRateWindowMs: 60000,
        },
      },
    });

    const app = new Hono();
    app.route('/sync', server.syncRoutes);

    const response = await app.request(
      'http://localhost/sync/realtime?clientId=client-rate-limit'
    );
    expect(response.status).toBe(200);

    const events = capturedEvents;
    if (!events?.onOpen || !events.onMessage) {
      throw new Error('Expected websocket handlers to be captured.');
    }

    const upstream = createUpstreamSocketHarness();
    events.onOpen(new Event('open'), upstream.ws);

    await events.onMessage(
      new MessageEvent('message', { data: '{}' }),
      upstream.ws
    );
    await events.onMessage(
      new MessageEvent('message', { data: '{}' }),
      upstream.ws
    );
    await events.onMessage(
      new MessageEvent('message', { data: '{}' }),
      upstream.ws
    );

    const latestClose = upstream.closes[upstream.closes.length - 1];
    expect(latestClose?.code).toBe(1011);
    expect(latestClose?.reason).toBe('server error');

    const errorMessage = upstream.messages.find(
      (message) => message.event === 'error'
    );
    expect(errorMessage).toBeDefined();
    if (!errorMessage || !isRecord(errorMessage.data)) {
      throw new Error('Expected websocket error payload.');
    }
    expect(typeof errorMessage.data.error).toBe('string');
    expect(String(errorMessage.data.error)).toContain(
      'WebSocket message rate exceeded'
    );
  });

  it('enforces inbound websocket message rate limits on console live route', async () => {
    const options = createOptions();
    let capturedEvents: WSEvents | null = null;
    const upgradeWebSocket = defineWebSocketHelper(async (_c, events) => {
      capturedEvents = events;
      return new Response(null, { status: 200 });
    });

    const server = createSyncServer({
      ...options,
      upgradeWebSocket,
      console: { token: 'console-token' },
      routes: {
        websocket: {
          maxMessagesPerWindow: 1,
          messageRateWindowMs: 60000,
        },
      },
    });

    const app = new Hono();
    app.route('/console', server.consoleRoutes!);

    const response = await app.request('http://localhost/console/events/live', {
      headers: { Authorization: 'Bearer console-token' },
    });
    expect(response.status).toBe(200);

    const events = capturedEvents;
    if (!events?.onOpen || !events.onMessage) {
      throw new Error('Expected websocket handlers to be captured.');
    }

    const upstream = createUpstreamSocketHarness();
    events.onOpen(new Event('open'), upstream.ws);

    await events.onMessage(
      new MessageEvent('message', { data: '{}' }),
      upstream.ws
    );
    await events.onMessage(
      new MessageEvent('message', { data: '{}' }),
      upstream.ws
    );

    const latestClose = upstream.closes[upstream.closes.length - 1];
    expect(latestClose?.code).toBe(1008);
    expect(latestClose?.reason).toBe('message rate exceeded');
  });

  it('allows disabling request payload snapshots for privacy-sensitive deployments', async () => {
    process.env.SYNC_CONSOLE_TOKEN = 'env-token';
    const options = createOptions();
    const server = createSyncServer({
      ...options,
      console: {},
      routes: {
        requestPayloadSnapshots: {
          enabled: false,
        },
      },
    });

    const app = new Hono();
    app.route('/sync', server.syncRoutes);

    const requestId = 'req-no-payload-snapshot';
    const response = await app.request(createPushRequest({ requestId }));
    expect(response.status).toBe(200);

    const eventRow = await waitForRequestEventRow(requestId);
    expect(eventRow.payload_ref).toBeNull();

    const payloadCountResult = await sql<{ total: number | string }>`
      SELECT COUNT(*)::int AS total
      FROM sync_request_payloads
    `.execute(db);
    const payloadCount = Number(payloadCountResult.rows[0]?.total ?? 0);
    expect(payloadCount).toBe(0);
  });

  it('keeps request payload snapshots disabled by default', async () => {
    process.env.SYNC_CONSOLE_TOKEN = 'env-token';
    const options = createOptions();
    const server = createSyncServer({
      ...options,
      console: {},
    });

    const app = new Hono();
    app.route('/sync', server.syncRoutes);

    const requestId = 'req-default-no-payload-snapshot';
    const response = await app.request(createPushRequest({ requestId }));
    expect(response.status).toBe(200);

    const eventRow = await waitForRequestEventRow(requestId);
    expect(eventRow.payload_ref).toBeNull();

    const payloadCountResult = await sql<{ total: number | string }>`
      SELECT COUNT(*)::int AS total
      FROM sync_request_payloads
    `.execute(db);
    const payloadCount = Number(payloadCountResult.rows[0]?.total ?? 0);
    expect(payloadCount).toBe(0);
  });

  it('supports aggressively reducing stored payload snapshot size', async () => {
    process.env.SYNC_CONSOLE_TOKEN = 'env-token';
    const options = createOptions();
    const server = createSyncServer({
      ...options,
      console: {},
      routes: {
        requestPayloadSnapshots: {
          maxBytes: 32,
        },
      },
    });

    const app = new Hono();
    app.route('/sync', server.syncRoutes);

    const requestId = 'req-small-payload-preview';
    const response = await app.request(
      createPushRequest({
        requestId,
        title: 'x'.repeat(1024),
      })
    );
    expect(response.status).toBe(200);

    const eventRow = await waitForRequestEventRow(requestId);
    expect(typeof eventRow.payload_ref).toBe('string');
    if (!eventRow.payload_ref) {
      throw new Error('Expected payload_ref to be present.');
    }

    const storedPayload = await waitForRequestPayloadSnapshot(
      eventRow.payload_ref
    );
    expect(typeof storedPayload).toBe('object');
    expect(Array.isArray(storedPayload)).toBe(false);
    if (!storedPayload || typeof storedPayload !== 'object') {
      throw new Error('Expected stored payload snapshot to be an object.');
    }

    const truncated = Reflect.get(storedPayload, 'truncated');
    const preview = Reflect.get(storedPayload, 'preview');

    expect(truncated).toBe(true);
    expect(typeof preview).toBe('string');
    if (typeof preview === 'string') {
      expect(preview.length).toBeLessThanOrEqual(32);
    }
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
