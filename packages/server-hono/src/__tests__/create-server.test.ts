import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  createDatabase,
  decodeBinarySyncPack,
  isBinarySyncPackContentType,
} from '@syncular/core';
import { createPgliteDialect } from '@syncular/dialect-pglite';
import {
  createScopedSnapshotArtifactScopeCacheKey,
  createServerHandler,
  ensureSyncSchema,
  insertScopedSnapshotArtifact,
  type SnapshotArtifactStorage,
  SyncClientSchemaUnsupportedError,
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
import {
  getSyncWebSocketConnectionManager,
  normalizeSyncCorsConfig,
} from '../routes';
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
      sendSyncPack() {},
      sendHello() {},
      sendHeartbeat() {},
      sendPresence() {},
      sendError() {},
      close() {},
    };
  }

  function createUpstreamSocketHarness() {
    const messages: Array<Record<string, unknown>> = [];
    const binaryMessages: Uint8Array[] = [];
    const closes: Array<{ code?: number; reason?: string }> = [];

    const ws = new WSContext({
      readyState: 1,
      send(data) {
        if (typeof data !== 'string') {
          if (data instanceof ArrayBuffer) {
            binaryMessages.push(new Uint8Array(data));
          }
          return;
        }
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
      binaryMessages,
      closes,
    };
  }

  function createPushRequest(args?: {
    requestId?: string;
    clientCommitId?: string;
    rowId?: string;
    title?: string;
    clientId?: string;
    headers?: Record<string, string>;
  }): Request {
    const rowId = args?.rowId ?? 'task-1';
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
              clientCommitId: args?.clientCommitId ?? 'commit-1',
              schemaVersion: 1,
              operations: [
                {
                  table: 'tasks',
                  row_id: rowId,
                  op: 'upsert',
                  payload: {
                    id: rowId,
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
    requestId?: string;
    schemaVersion?: number;
  }): Request {
    return new Request('http://localhost/sync', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-user-id': args.userId,
        ...(args.requestId ? { 'x-request-id': args.requestId } : {}),
      },
      body: JSON.stringify({
        clientId: args.clientId,
        pull: {
          schemaVersion: args.schemaVersion ?? 1,
          limitCommits: 10,
          subscriptions: [
            {
              id: 'tasks-sub',
              table: 'tasks',
              scopes: { user_id: args.subscriptionUserId },
              cursor: -1,
              crdtStateVectors: [],
            },
          ],
        },
      }),
    });
  }

  function createEmptyPullRequest(args: {
    clientId: string;
    userId: string;
    requestId?: string;
  }): Request {
    return new Request('http://localhost/sync', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-user-id': args.userId,
        ...(args.requestId ? { 'x-request-id': args.requestId } : {}),
      },
      body: JSON.stringify({
        clientId: args.clientId,
        pull: {
          schemaVersion: 1,
          limitCommits: 10,
          subscriptions: [],
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

  async function readSyncResponse(response: Response): Promise<unknown> {
    if (isBinarySyncPackContentType(response.headers.get('content-type'))) {
      return decodeBinarySyncPack(new Uint8Array(await response.arrayBuffer()));
    }
    return response.json();
  }

  async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt++) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    throw new Error('Timed out waiting for condition');
  }

  async function waitForRequestEventRow(requestId: string): Promise<{
    payload_ref: string | null;
    trace_id: string | null;
    span_id: string | null;
    event_type: string;
    client_id: string;
    status_code: number;
    outcome: string;
    response_status: string;
    error_code: string | null;
    error_message: string | null;
    row_count: number | string | null;
    subscription_count: number | string | null;
    response_summary: unknown | null;
  }> {
    for (let attempt = 0; attempt < 40; attempt++) {
      const result = await sql<{
        payload_ref: string | null;
        trace_id: string | null;
        span_id: string | null;
        event_type: string;
        client_id: string;
        status_code: number;
        outcome: string;
        response_status: string;
        error_code: string | null;
        error_message: string | null;
        row_count: number | string | null;
        subscription_count: number | string | null;
        response_summary: unknown | null;
      }>`
        SELECT
          payload_ref,
          trace_id,
          span_id,
          event_type,
          client_id,
          status_code,
          outcome,
          response_status,
          error_code,
          error_message,
          row_count,
          subscription_count,
          response_summary
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

  async function waitForRealtimeEventRows(clientId: string): Promise<
    Array<{
      event_type: string;
      reason: string | null;
      cursor: number | string | null;
      latest_cursor: number | string | null;
    }>
  > {
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        const result = await sql<{
          event_type: string;
          reason: string | null;
          cursor: number | string | null;
          latest_cursor: number | string | null;
        }>`
          SELECT event_type, reason, cursor, latest_cursor
          FROM sync_realtime_events
          WHERE client_id = ${clientId}
          ORDER BY event_id ASC
        `.execute(db);

        if (result.rows.length > 0) {
          return result.rows;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes('sync_realtime_events')) {
          throw error;
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    throw new Error(`Timed out waiting for realtime events: ${clientId}`);
  }

  it('rejects oversized sync JSON request bodies with a stable limit envelope', async () => {
    const options = createOptions();
    const server = createSyncServer({
      ...options,
      routes: {
        maxSyncRequestJsonBytes: 96,
      },
    });
    const app = new Hono();
    app.route('/sync', server.syncRoutes);

    const response = await app.request('http://localhost/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clientId: `client-${'x'.repeat(200)}`,
        pull: {
          schemaVersion: 1,
          limitCommits: 10,
          subscriptions: [],
        },
      }),
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      error: 'runtime.limit_exceeded',
      code: 'runtime.limit_exceeded',
      category: 'limit-exceeded',
      retryable: false,
      recommendedAction: 'reduceInput',
      details: {
        limit: 'maxSyncRequestJsonBytes',
        max: 96,
      },
    });
  });

  it('maps unsupported client schema snapshots to a stable upgrade response', async () => {
    const server = createSyncServer({
      ...createOptions(),
      sync: {
        handlers: [
          createServerHandler<ServerDb, ClientDb, 'tasks'>({
            table: 'tasks',
            scopes: ['user:{user_id}'],
            resolveScopes: async (ctx) => ({ user_id: [ctx.actorId] }),
            snapshot: async (ctx) => {
              throw new SyncClientSchemaUnsupportedError({
                schemaVersion: ctx.schemaVersion,
                supportedSchemaVersions: [6, 7],
              });
            },
          }),
        ],
        authenticate: async () => ({ actorId: 'u1' }),
      },
    });
    const app = new Hono();
    app.route('/sync', server.syncRoutes);

    const response = await app.request(
      createPullRequest({
        clientId: 'schema-too-old',
        userId: 'u1',
        subscriptionUserId: 'u1',
        schemaVersion: 5,
      })
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: 'sync.client_schema_unsupported',
      code: 'sync.client_schema_unsupported',
      category: 'schema-mismatch',
      recommendedAction: 'upgradeClient',
      retryable: false,
    });
  });

  it('records oversized sync JSON request bodies as console limit events', async () => {
    process.env.SYNC_CONSOLE_TOKEN = 'env-token';
    const options = createOptions();
    const server = createSyncServer({
      ...options,
      console: {},
      routes: {
        maxSyncRequestJsonBytes: 96,
      },
    });
    const app = new Hono();
    app.route('/sync', server.syncRoutes);

    const requestId = 'req-json-body-limit';
    const response = await app.request('http://localhost/sync', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-request-id': requestId,
        'x-syncular-client-id': 'client-json-body-limit',
      },
      body: JSON.stringify({
        clientId: `client-${'x'.repeat(200)}`,
        pull: {
          schemaVersion: 1,
          limitCommits: 10,
          subscriptions: [],
        },
      }),
    });

    expect(response.status).toBe(413);
    const eventRow = await waitForRequestEventRow(requestId);
    expect(eventRow).toMatchObject({
      event_type: 'sync',
      client_id: 'client-json-body-limit',
      status_code: 413,
      outcome: 'rejected',
      response_status: 'client_error',
      error_code: 'runtime.limit_exceeded',
    });
    expect(eventRow.error_message).toContain('maxSyncRequestJsonBytes');
  });

  it('records oversized binary sync-pack responses as rejected console events', async () => {
    process.env.SYNC_CONSOLE_TOKEN = 'env-token';
    const options = createOptions();
    const server = createSyncServer({
      ...options,
      console: {},
      routes: {
        maxSyncBinaryPackBytes: 1,
      },
    });
    const app = new Hono();
    app.route('/sync', server.syncRoutes);

    const requestId = 'req-binary-response-limit';
    const response = await app.request(
      createEmptyPullRequest({
        clientId: 'client-binary-response-limit',
        userId: 'u1',
        requestId,
      })
    );

    expect(response.status).toBe(413);
    const eventRow = await waitForRequestEventRow(requestId);
    expect(eventRow).toMatchObject({
      event_type: 'pull',
      client_id: 'client-binary-response-limit',
      status_code: 413,
      outcome: 'rejected',
      response_status: 'client_error',
      error_code: 'runtime.limit_exceeded',
    });
    expect(eventRow.error_message).toContain('maxSyncBinaryPackBytes');
    expect(Number(eventRow.row_count ?? 0)).toBe(0);
    expect(Number(eventRow.subscription_count ?? 0)).toBe(0);

    const successCountResult = await sql<{ total: number | string }>`
      SELECT COUNT(*)::int AS total
      FROM sync_request_events
      WHERE request_id = ${requestId}
        AND status_code = 200
    `.execute(db);
    expect(Number(successCountResult.rows[0]?.total ?? 0)).toBe(0);

    const cursorCountResult = await sql<{ total: number | string }>`
      SELECT COUNT(*)::int AS total
      FROM sync_client_cursors
      WHERE client_id = ${'client-binary-response-limit'}
    `.execute(db);
    expect(Number(cursorCountResult.rows[0]?.total ?? 0)).toBe(0);
  });

  it('rejects oversized binary sync-pack responses with a stable limit envelope', async () => {
    const options = createOptions();
    const server = createSyncServer({
      ...options,
      routes: {
        maxSyncBinaryPackBytes: 1,
      },
    });
    const app = new Hono();
    app.route('/sync', server.syncRoutes);

    const response = await app.request('http://localhost/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clientId: 'client-binary-limit',
        pull: {
          schemaVersion: 1,
          limitCommits: 10,
          subscriptions: [],
        },
      }),
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      error: 'runtime.limit_exceeded',
      details: {
        limit: 'maxSyncBinaryPackBytes',
        max: 1,
      },
    });
  });

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
      expect(await response.json()).toMatchObject({
        error: 'blob.storage_not_configured',
        code: 'blob.storage_not_configured',
        category: 'blob',
        retryable: false,
        recommendedAction: 'inspectServer',
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
    expect(await response.json()).toMatchObject({
      error: 'blob.storage_not_configured',
      code: 'blob.storage_not_configured',
      category: 'blob',
      retryable: false,
      recommendedAction: 'inspectServer',
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
    expect(await response.json()).toMatchObject({
      error: 'sync.websocket_connection_limit',
      code: 'sync.websocket_connection_limit',
      category: 'rate-limited',
      retryable: true,
      recommendedAction: 'retryLater',
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
      'http://localhost/sync/realtime?clientId=client-3',
      {
        headers: {
          Origin: 'https://evil.syncular.test',
        },
      }
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: 'sync.forbidden',
      code: 'sync.forbidden',
      category: 'forbidden',
      retryable: false,
      recommendedAction: 'checkPermissions',
    });
  });

  it('accepts simple sync CORS allowlists without a custom resolver', async () => {
    const options = createOptions();
    const server = createSyncServer({
      ...options,
      routes: {
        cors: 'https://allowed.syncular.test',
      },
    });

    const app = new Hono();
    app.route('/sync', server.syncRoutes);

    const allowedPreflight = await app.request('http://localhost/sync', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://allowed.syncular.test',
        'access-control-request-method': 'POST',
      },
    });
    expect(allowedPreflight.status).toBe(204);
    expect(allowedPreflight.headers.has('Access-Control-Allow-Origin')).toBe(
      true
    );
    expect(
      allowedPreflight.headers.get('Access-Control-Allow-Headers')
    ).toContain('x-syncular-snapshot-scopes');
  });

  it('defaults websocket allowedOrigins from sync CORS allowlists', async () => {
    expect(
      resolveDefaultWebSocketAllowedOrigins({
        cors: 'https://allowed.syncular.test',
      })
    ).toEqual(['https://allowed.syncular.test']);
  });

  it('accepts Hono-style CORS options and appends custom headers to defaults', async () => {
    const options = createOptions();
    const server = createSyncServer({
      ...options,
      routes: {
        cors: {
          origin: ['https://preview-123.pages.dev'],
          allowHeaders: ['x-custom-header'],
          exposeHeaders: ['etag'],
        },
      },
    });

    const app = new Hono();
    app.route('/sync', server.syncRoutes);

    const allowedPreflight = await app.request('http://localhost/sync', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://preview-123.pages.dev',
        'access-control-request-method': 'POST',
      },
    });

    expect(allowedPreflight.status).toBe(204);
    expect(
      allowedPreflight.headers.get('Access-Control-Allow-Headers')
    ).toContain('x-syncular-client-id');
    expect(
      allowedPreflight.headers.get('Access-Control-Allow-Headers')
    ).toContain('x-syncular-sync-attempt-id');
    expect(
      allowedPreflight.headers.get('Access-Control-Allow-Headers')
    ).toContain('x-custom-header');
    expect(
      allowedPreflight.headers.get('Access-Control-Expose-Headers')
    ).toContain('etag');
  });

  it('supports wildcard origins in sync CORS allowlists', async () => {
    const options = createOptions();
    const server = createSyncServer({
      ...options,
      routes: {
        cors: {
          origin: ['https://*.pages.dev'],
        },
      },
    });

    const app = new Hono();
    app.route('/sync', server.syncRoutes);

    const allowedPreflight = await app.request('http://localhost/sync', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://preview-123.pages.dev',
        'access-control-request-method': 'POST',
      },
    });

    expect(allowedPreflight.status).toBe(204);
    expect(allowedPreflight.headers.has('Access-Control-Allow-Origin')).toBe(
      true
    );
  });

  it('resolves exact and wildcard sync CORS origins deterministically', async () => {
    const exactCors = normalizeSyncCorsConfig('https://allowed.syncular.test');
    expect(exactCors).not.toBeNull();
    expect(
      await exactCors?.resolveOrigin(
        'https://allowed.syncular.test',
        {} as never
      )
    ).toBe('https://allowed.syncular.test');

    const wildcardCors = normalizeSyncCorsConfig({
      origin: ['https://*.pages.dev'],
    });
    expect(wildcardCors).not.toBeNull();
    expect(
      await wildcardCors?.resolveOrigin(
        'https://preview-123.pages.dev',
        {} as never
      )
    ).toBe('https://preview-123.pages.dev');
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

  it('allows origin-less realtime websocket upgrades when allowedOrigins is derived from CORS', async () => {
    const options = createOptions();
    let capturedEvents: WSEvents | null = null;
    const upgradeWebSocket = defineWebSocketHelper(async (_c, events) => {
      capturedEvents = events;
      return new Response(null, { status: 200 });
    });

    const server = createSyncServer({
      ...options,
      routes: {
        cors: {
          origin: ['http://127.0.0.1:*', 'http://localhost:*'],
        },
      },
      upgradeWebSocket,
    });

    const app = new Hono();
    app.route('/sync', server.syncRoutes);

    const response = await app.request(
      'http://localhost/sync/realtime?clientId=client-originless-configured'
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
    expect(await hijackResponse.json()).toMatchObject({
      error: 'sync.invalid_client_id',
      code: 'sync.invalid_client_id',
      category: 'invalid-request',
      retryable: false,
      recommendedAction: 'resetClientId',
      message: 'clientId is already bound to a different actor',
    });
    expect(capturedEvents).toBeNull();
  });

  it('allows stale-scope rebinding after a fully revoked pull', async () => {
    process.env.SYNC_CONSOLE_TOKEN = 'env-token';
    const options = createOptions();
    const server = createSyncServer({
      ...options,
      console: {},
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
        requestId: 'req-revoked-pull-summary',
      })
    );
    expect(revokedPull.status).toBe(200);
    expect(await readSyncResponse(revokedPull)).toMatchObject({
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
    const revokedPullEvent = await waitForRequestEventRow(
      'req-revoked-pull-summary'
    );
    expect(parseSnapshotValue(revokedPullEvent.response_summary)).toMatchObject(
      {
        subscriptionCount: 1,
        activeSubscriptionCount: 0,
        revokedSubscriptionCount: 1,
        bootstrapSubscriptionCount: 0,
        commitCount: 0,
        changeCount: 0,
        snapshotPageCount: 0,
        snapshotInlineRowCount: 0,
        snapshotChunkCount: 0,
        snapshotChunkBytes: 0,
        snapshotArtifactCount: 0,
        snapshotArtifactBytes: 0,
      }
    );

    const reboundPull = await app.request(
      createPullRequest({
        clientId: 'shared-client',
        userId: 'u2',
        subscriptionUserId: 'u2',
      })
    );
    expect(reboundPull.status).toBe(200);
    expect(await readSyncResponse(reboundPull)).toMatchObject({
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

  it('keeps unauthorized scopes denied across pull, realtime, and artifacts', async () => {
    const artifactBody = new Uint8Array([1, 2, 3, 4]);
    const artifactBodies = new Map<string, Uint8Array>();
    const scopeKey = await createScopedSnapshotArtifactScopeCacheKey({
      partitionId: 'default',
      subscriptionId: 'tasks-sub',
      scopes: { user_id: 'u1' },
      schemaVersion: 1,
      features: [],
    });
    const artifact = await insertScopedSnapshotArtifact(db, {
      artifactId: 'artifact-auth-boundary',
      partitionId: 'default',
      scopeKey,
      subscriptionId: 'tasks-sub',
      table: 'tasks',
      schemaVersion: 1,
      asOfCommitSeq: 0,
      rowCursor: null,
      rowLimit: 100,
      rowCount: 1,
      nextRowCursor: null,
      isFirstPage: true,
      isLastPage: true,
      sha256: 'a'.repeat(64),
      byteLength: artifactBody.length,
      featureSet: [],
      blobHash: 'sha256:artifact-auth-boundary',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    artifactBodies.set(artifact.id, artifactBody);

    let readArtifactCalls = 0;
    const artifactStorage: SnapshotArtifactStorage = {
      name: 'memory-artifacts',
      async readArtifact(row) {
        readArtifactCalls += 1;
        return artifactBodies.get(row.id) ?? null;
      },
    };
    let capturedEvents: WSEvents | null = null;
    const upgradeWebSocket = defineWebSocketHelper(async (_c, events) => {
      capturedEvents = events;
      return new Response(null, { status: 200 });
    });
    const options = createOptions();
    const server = createSyncServer({
      ...options,
      snapshotArtifactStorage: artifactStorage,
      upgradeWebSocket,
      sync: {
        ...options.sync,
        authenticate: async (request) => {
          const actorId = request.headers.get('x-user-id');
          return actorId ? { actorId } : null;
        },
      },
    });
    const manager = getSyncWebSocketConnectionManager(server.syncRoutes);
    if (!manager) {
      throw new Error('Expected websocket manager to be enabled.');
    }
    const app = new Hono();
    app.route('/sync', server.syncRoutes);

    const deniedPull = await app.request(
      createPullRequest({
        clientId: 'client-auth-boundary',
        userId: 'u2',
        subscriptionUserId: 'u1',
      })
    );
    expect(deniedPull.status).toBe(200);
    const deniedPullBody = await readSyncResponse(deniedPull);
    expect(deniedPullBody).toMatchObject({
      ok: true,
      pull: {
        subscriptions: [
          {
            id: 'tasks-sub',
            status: 'revoked',
            scopes: {},
            commits: [],
          },
        ],
      },
    });
    expect(deniedPullBody.pull.subscriptions[0].snapshots).toBeUndefined();

    const deniedArtifact = await app.request(
      `http://localhost/sync/snapshot-artifacts/${artifact.id}`,
      {
        headers: {
          'x-user-id': 'u2',
          'x-syncular-snapshot-scopes': JSON.stringify({ user_id: 'u1' }),
        },
      }
    );
    expect(deniedArtifact.status).toBe(403);
    expect(await deniedArtifact.json()).toMatchObject({
      error: 'sync.forbidden',
    });
    expect(readArtifactCalls).toBe(0);

    const realtimeResponse = await app.request(
      'http://localhost/sync/realtime?clientId=client-auth-boundary',
      {
        headers: {
          'x-user-id': 'u2',
        },
      }
    );
    expect(realtimeResponse.status).toBe(200);
    const events = capturedEvents;
    if (!events?.onOpen) {
      throw new Error('Expected websocket handlers to be captured.');
    }

    const upstream = createUpstreamSocketHarness();
    events.onOpen(new Event('open'), upstream.ws);
    expect(upstream.messages).toContainEqual(
      expect.objectContaining({
        event: 'hello',
        data: expect.objectContaining({
          actorId: 'u2',
          clientId: 'client-auth-boundary',
          scopeCount: 0,
        }),
      })
    );

    manager.notifyScopeKeys(['default::user:u1'], 1);
    expect(
      upstream.messages.filter((message) => message.event === 'sync')
    ).toEqual([]);
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

    const response = await app.request('http://localhost/console/events/live', {
      headers: {
        Origin: 'https://evil.syncular.test',
      },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: 'console.forbidden_origin',
      code: 'console.forbidden_origin',
      category: 'forbidden',
      retryable: false,
      recommendedAction: 'checkPermissions',
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

  it('records realtime cursor acks without replacing effective scopes', async () => {
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

    const push = await app.request(
      createPushRequest({
        clientId: 'writer-client',
      })
    );
    expect(push.status).toBe(200);
    await sql`
      INSERT INTO sync_client_cursors (
        partition_id, client_id, actor_id, cursor, effective_scopes, updated_at
      )
      VALUES (
        'default', 'client-ack', 'u1', 0, ${JSON.stringify({ user_id: 'u1' })}, ${new Date().toISOString()}
      )
    `.execute(db);

    const response = await app.request(
      'http://localhost/sync/realtime?clientId=client-ack'
    );
    expect(response.status).toBe(200);

    const events = capturedEvents;
    if (!events?.onOpen || !events.onMessage) {
      throw new Error('Expected websocket handlers to be captured.');
    }

    const upstream = createUpstreamSocketHarness();
    events.onOpen(new Event('open'), upstream.ws);
    await events.onMessage(
      new MessageEvent('message', {
        data: JSON.stringify({ type: 'ack', cursor: 1 }),
      }),
      upstream.ws
    );

    await waitFor(async () => {
      const result = await sql<{ cursor: number | string }>`
        SELECT cursor
        FROM sync_client_cursors
        WHERE partition_id = 'default' AND client_id = 'client-ack'
      `.execute(db);
      return Number(result.rows[0]?.cursor) === 1;
    });

    const state = await sql<{
      cursor: number | string;
      effective_scopes: unknown;
    }>`
      SELECT cursor, effective_scopes
      FROM sync_client_cursors
      WHERE partition_id = 'default' AND client_id = 'client-ack'
    `.execute(db);
    expect(Number(state.rows[0]?.cursor)).toBe(1);
    expect(parseSnapshotValue(state.rows[0]?.effective_scopes)).toEqual({
      user_id: 'u1',
    });
  });

  it('sends a catch-up wakeup when a realtime reconnect lags the server cursor', async () => {
    process.env.SYNC_CONSOLE_TOKEN = 'env-token';
    const options = createOptions();
    const server = createSyncServer(options);
    const app = new Hono();
    app.route('/sync', server.syncRoutes);

    const push = await app.request(
      createPushRequest({
        clientId: 'writer-client',
      })
    );
    expect(push.status).toBe(200);
    await sql`
      INSERT INTO sync_client_cursors (
        partition_id, client_id, actor_id, cursor, effective_scopes, updated_at
      )
      VALUES (
        'default', 'client-catchup', 'u1', 0, ${JSON.stringify({ user_id: 'u1' })}, ${new Date().toISOString()}
      )
    `.execute(db);

    let capturedEvents: WSEvents | null = null;
    const upgradeWebSocket = defineWebSocketHelper(async (_c, events) => {
      capturedEvents = events;
      return new Response(null, { status: 200 });
    });
    const realtimeServer = createSyncServer({
      ...options,
      console: {},
      upgradeWebSocket,
    });
    const realtimeApp = new Hono();
    realtimeApp.route('/sync', realtimeServer.syncRoutes);

    const response = await realtimeApp.request(
      'http://localhost/sync/realtime?clientId=client-catchup'
    );
    expect(response.status).toBe(200);

    const events = capturedEvents;
    if (!events?.onOpen) {
      throw new Error('Expected websocket handlers to be captured.');
    }

    const upstream = createUpstreamSocketHarness();
    events.onOpen(new Event('open'), upstream.ws);

    const syncMessage = upstream.messages.find(
      (message) => message.event === 'sync'
    );
    expect(syncMessage).toMatchObject({
      event: 'sync',
      data: expect.objectContaining({
        cursor: 1,
        reason: 'reconnect-catchup',
        requiresPull: true,
      }),
    });
    const realtimeRows = (await waitForRealtimeEventRows('client-catchup')).map(
      (row) => ({
        ...row,
        cursor: row.cursor === null ? null : Number(row.cursor),
        latest_cursor:
          row.latest_cursor === null ? null : Number(row.latest_cursor),
      })
    );
    expect(realtimeRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event_type: 'connected',
          reason: 'requires_sync',
          cursor: 0,
          latest_cursor: 1,
        }),
        expect.objectContaining({
          event_type: 'pull_required',
          reason: 'reconnect-catchup',
          cursor: 0,
          latest_cursor: 1,
        }),
      ])
    );
  });

  it('requires pull on reconnect when no verified websocket delta pack exists', async () => {
    const options = createOptions();
    let capturedEvents: WSEvents | null = null;
    const upgradeWebSocket = defineWebSocketHelper(async (_c, events) => {
      capturedEvents = events;
      return new Response(null, { status: 200 });
    });
    const server = createSyncServer({
      ...options,
      routes: {
        websocket: {
          replayWindowSize: 4,
        },
      },
      upgradeWebSocket,
    });
    const app = new Hono();
    app.route('/sync', server.syncRoutes);

    const subscribed = await app.request(
      createPullRequest({
        clientId: 'client-replay',
        userId: 'u1',
        subscriptionUserId: 'u1',
      })
    );
    expect(subscribed.status).toBe(200);

    const push = await app.request(
      createPushRequest({
        clientId: 'writer-client',
      })
    );
    expect(push.status).toBe(200);

    const response = await app.request(
      'http://localhost/sync/realtime?clientId=client-replay&syncPackEncoding=binary-sync-pack-v1'
    );
    expect(response.status).toBe(200);

    const events = capturedEvents;
    if (!events?.onOpen) {
      throw new Error('Expected websocket handlers to be captured.');
    }

    const upstream = createUpstreamSocketHarness();
    events.onOpen(new Event('open'), upstream.ws);

    expect(upstream.binaryMessages).toHaveLength(0);
    expect(
      upstream.messages.some(
        (message) =>
          message.event === 'sync' &&
          isRecord(message.data) &&
          message.data.requiresPull === true
      )
    ).toBe(true);
  });

  it('enforces binary websocket backpressure through the realtime route', async () => {
    const options = createOptions();
    let capturedEvents: WSEvents | null = null;
    const upgradeWebSocket = defineWebSocketHelper(async (_c, events) => {
      capturedEvents = events;
      return new Response(null, { status: 200 });
    });
    const server = createSyncServer({
      ...options,
      routes: {
        websocket: {
          maxInFlightSyncsPerConnection: 1,
        },
      },
      upgradeWebSocket,
    });
    const app = new Hono();
    app.route('/sync', server.syncRoutes);

    const subscribed = await app.request(
      createPullRequest({
        clientId: 'client-binary-slow',
        userId: 'u1',
        subscriptionUserId: 'u1',
      })
    );
    expect(subscribed.status).toBe(200);

    const response = await app.request(
      'http://localhost/sync/realtime?clientId=client-binary-slow&syncPackEncoding=binary-sync-pack-v1'
    );
    expect(response.status).toBe(200);

    const events = capturedEvents;
    if (!events?.onOpen || !events.onMessage) {
      throw new Error('Expected websocket handlers to be captured.');
    }

    const upstream = createUpstreamSocketHarness();
    events.onOpen(new Event('open'), upstream.ws);

    const firstPush = await app.request(
      createPushRequest({
        clientCommitId: 'commit-backpressure-1',
        clientId: 'writer-client',
        rowId: 'task-backpressure-1',
      })
    );
    expect(firstPush.status).toBe(200);

    await waitFor(async () => upstream.binaryMessages.length === 1);
    const firstPack = decodeBinarySyncPack(upstream.binaryMessages[0]!);
    const firstSubscription = firstPack.pull?.subscriptions[0];
    expect(firstSubscription?.id).toBe('tasks-sub');
    expect(firstSubscription?.integrity).toMatchObject({
      commitSeq: 1,
      partitionId: 'default',
    });
    expect(firstSubscription?.commits[0]?.changes[0]?.row_id).toBe(
      'task-backpressure-1'
    );

    const secondPush = await app.request(
      createPushRequest({
        clientCommitId: 'commit-backpressure-2',
        clientId: 'writer-client',
        rowId: 'task-backpressure-2',
      })
    );
    expect(secondPush.status).toBe(200);

    await waitFor(async () =>
      upstream.messages.some(
        (message) =>
          message.event === 'sync' &&
          isRecord(message.data) &&
          message.data.reason === 'resync-required' &&
          message.data.cursor === 2 &&
          message.data.droppedCount === 1
      )
    );
    expect(upstream.binaryMessages).toHaveLength(1);

    await events.onMessage(
      new MessageEvent('message', {
        data: JSON.stringify({ type: 'ack', cursor: 2 }),
      }),
      upstream.ws
    );

    const thirdPush = await app.request(
      createPushRequest({
        clientCommitId: 'commit-backpressure-3',
        clientId: 'writer-client',
        rowId: 'task-backpressure-3',
      })
    );
    expect(thirdPush.status).toBe(200);

    await waitFor(async () => upstream.binaryMessages.length === 2);
  });

  it('chains verified roots across consecutive websocket binary deltas', async () => {
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

    const subscribed = await app.request(
      createPullRequest({
        clientId: 'client-root-chain',
        userId: 'u1',
        subscriptionUserId: 'u1',
      })
    );
    expect(subscribed.status).toBe(200);

    const response = await app.request(
      'http://localhost/sync/realtime?clientId=client-root-chain&syncPackEncoding=binary-sync-pack-v1'
    );
    expect(response.status).toBe(200);

    const events = capturedEvents;
    if (!events?.onOpen || !events.onMessage) {
      throw new Error('Expected websocket handlers to be captured.');
    }

    const upstream = createUpstreamSocketHarness();
    events.onOpen(new Event('open'), upstream.ws);

    const firstPush = await app.request(
      createPushRequest({
        clientCommitId: 'commit-root-chain-1',
        clientId: 'writer-client',
        rowId: 'task-root-chain-1',
      })
    );
    expect(firstPush.status).toBe(200);
    await waitFor(async () => upstream.binaryMessages.length === 1);

    const firstPack = decodeBinarySyncPack(upstream.binaryMessages[0]!);
    const firstIntegrity = firstPack.pull?.subscriptions[0]?.integrity;
    expect(firstIntegrity).toMatchObject({
      previousChainRoot: '0'.repeat(64),
      commitSeq: 1,
    });

    await events.onMessage(
      new MessageEvent('message', {
        data: JSON.stringify({ type: 'ack', cursor: 1 }),
      }),
      upstream.ws
    );

    const secondPush = await app.request(
      createPushRequest({
        clientCommitId: 'commit-root-chain-2',
        clientId: 'writer-client',
        rowId: 'task-root-chain-2',
      })
    );
    expect(secondPush.status).toBe(200);
    await waitFor(async () => upstream.binaryMessages.length === 2);

    const secondPack = decodeBinarySyncPack(upstream.binaryMessages[1]!);
    expect(secondPack.pull?.subscriptions[0]?.integrity).toMatchObject({
      previousChainRoot: firstIntegrity?.commitChainRoot,
      commitSeq: 2,
    });
  });

  it('hydrates persisted realtime subscriptions after server restart', async () => {
    const options = createOptions();
    const bootstrapServer = createSyncServer(options);
    const bootstrapApp = new Hono();
    bootstrapApp.route('/sync', bootstrapServer.syncRoutes);

    const subscribed = await bootstrapApp.request(
      createPullRequest({
        clientId: 'client-persisted-realtime',
        userId: 'u1',
        subscriptionUserId: 'u1',
      })
    );
    expect(subscribed.status).toBe(200);

    const persistedBeforeConnect = await sql<{
      realtime_subscriptions: unknown;
    }>`
      SELECT realtime_subscriptions
      FROM sync_client_cursors
      WHERE partition_id = 'default'
        AND client_id = 'client-persisted-realtime'
    `.execute(db);
    expect(
      parseSnapshotValue(persistedBeforeConnect.rows[0]?.realtime_subscriptions)
    ).toEqual([
      expect.objectContaining({
        id: 'tasks-sub',
        table: 'tasks',
        cursor: 0,
        verifiedRoot: null,
      }),
    ]);

    let capturedEvents: WSEvents | null = null;
    const upgradeWebSocket = defineWebSocketHelper(async (_c, events) => {
      capturedEvents = events;
      return new Response(null, { status: 200 });
    });
    const restartedServer = createSyncServer({
      ...options,
      upgradeWebSocket,
    });
    const restartedApp = new Hono();
    restartedApp.route('/sync', restartedServer.syncRoutes);

    const response = await restartedApp.request(
      'http://localhost/sync/realtime?clientId=client-persisted-realtime&syncPackEncoding=binary-sync-pack-v1'
    );
    expect(response.status).toBe(200);

    const events = capturedEvents;
    if (!events?.onOpen || !events.onMessage) {
      throw new Error('Expected websocket handlers to be captured.');
    }

    const upstream = createUpstreamSocketHarness();
    events.onOpen(new Event('open'), upstream.ws);

    const firstPush = await restartedApp.request(
      createPushRequest({
        clientCommitId: 'commit-persisted-realtime-1',
        clientId: 'writer-client',
        rowId: 'task-persisted-realtime-1',
      })
    );
    expect(firstPush.status).toBe(200);
    await waitFor(async () => upstream.binaryMessages.length === 1);

    const firstPack = decodeBinarySyncPack(upstream.binaryMessages[0]!);
    const firstIntegrity = firstPack.pull?.subscriptions[0]?.integrity;
    expect(firstIntegrity).toMatchObject({
      previousChainRoot: '0'.repeat(64),
      commitSeq: 1,
    });

    await events.onMessage(
      new MessageEvent('message', {
        data: JSON.stringify({ type: 'ack', cursor: 1 }),
      }),
      upstream.ws
    );

    await waitFor(async () => {
      const stored = await sql<{ realtime_subscriptions: unknown }>`
        SELECT realtime_subscriptions
        FROM sync_client_cursors
        WHERE partition_id = 'default'
          AND client_id = 'client-persisted-realtime'
      `.execute(db);
      const subscriptions = parseSnapshotValue(
        stored.rows[0]?.realtime_subscriptions
      );
      return (
        Array.isArray(subscriptions) &&
        Number(subscriptions[0]?.cursor) === 1 &&
        subscriptions[0]?.verifiedRoot === firstIntegrity?.commitChainRoot
      );
    });

    capturedEvents = null;
    const restartedAgainServer = createSyncServer({
      ...options,
      upgradeWebSocket,
    });
    const restartedAgainApp = new Hono();
    restartedAgainApp.route('/sync', restartedAgainServer.syncRoutes);

    const responseAfterAck = await restartedAgainApp.request(
      'http://localhost/sync/realtime?clientId=client-persisted-realtime&syncPackEncoding=binary-sync-pack-v1'
    );
    expect(responseAfterAck.status).toBe(200);

    const eventsAfterAck = capturedEvents;
    if (!eventsAfterAck?.onOpen) {
      throw new Error('Expected websocket handlers to be captured.');
    }

    const upstreamAfterAck = createUpstreamSocketHarness();
    eventsAfterAck.onOpen(new Event('open'), upstreamAfterAck.ws);

    const secondPush = await restartedAgainApp.request(
      createPushRequest({
        clientCommitId: 'commit-persisted-realtime-2',
        clientId: 'writer-client',
        rowId: 'task-persisted-realtime-2',
      })
    );
    expect(secondPush.status).toBe(200);
    await waitFor(async () => upstreamAfterAck.binaryMessages.length === 1);

    const secondPack = decodeBinarySyncPack(
      upstreamAfterAck.binaryMessages[0]!
    );
    expect(secondPack.pull?.subscriptions[0]?.integrity).toMatchObject({
      previousChainRoot: firstIntegrity?.commitChainRoot,
      commitSeq: 2,
    });
  });

  it('accepts refreshed realtime auth tokens for the same actor', async () => {
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
          const token = request.headers
            .get('authorization')
            ?.replace(/^Bearer\s+/i, '');
          return token === 'old-token' || token === 'new-token'
            ? { actorId: 'u1' }
            : null;
        },
      },
    });
    const app = new Hono();
    app.route('/sync', server.syncRoutes);

    await sql`
      INSERT INTO sync_client_cursors (
        partition_id, client_id, actor_id, cursor, effective_scopes, updated_at
      )
      VALUES (
        'default', 'client-auth-refresh', 'u1', 0, ${JSON.stringify({ user_id: 'u1' })}, ${new Date().toISOString()}
      )
    `.execute(db);

    const refreshed = await app.request(
      'http://localhost/sync/realtime?clientId=client-auth-refresh&syncPackEncoding=binary-sync-pack-v1',
      {
        headers: {
          Authorization: 'Bearer new-token',
        },
      }
    );
    expect(refreshed.status).toBe(200);

    const events = capturedEvents;
    if (!events?.onOpen) {
      throw new Error('Expected websocket handlers to be captured.');
    }

    const upstream = createUpstreamSocketHarness();
    events.onOpen(new Event('open'), upstream.ws);

    const helloMessage = upstream.messages.find(
      (message) => message.event === 'hello'
    );
    expect(helloMessage).toMatchObject({
      event: 'hello',
      data: expect.objectContaining({
        actorId: 'u1',
        clientId: 'client-auth-refresh',
        syncPackEncoding: 'binary-sync-pack-v1',
      }),
    });

    capturedEvents = null;
    const expired = await app.request(
      'http://localhost/sync/realtime?clientId=client-auth-refresh&syncPackEncoding=binary-sync-pack-v1',
      {
        headers: {
          Authorization: 'Bearer expired-token',
        },
      }
    );
    expect(expired.status).toBe(401);
    expect(capturedEvents).toBeNull();
  });

  it('sends a websocket hello frame with session capabilities', async () => {
    const options = createOptions();
    const server = createSyncServer(options);
    const app = new Hono();
    app.route('/sync', server.syncRoutes);

    const push = await app.request(
      createPushRequest({
        clientId: 'writer-client',
      })
    );
    expect(push.status).toBe(200);
    await sql`
      INSERT INTO sync_client_cursors (
        partition_id, client_id, actor_id, cursor, effective_scopes, updated_at
      )
      VALUES (
        'default', 'client-hello', 'u1', 0, ${JSON.stringify({ user_id: 'u1' })}, ${new Date().toISOString()}
      )
    `.execute(db);

    let capturedEvents: WSEvents | null = null;
    const upgradeWebSocket = defineWebSocketHelper(async (_c, events) => {
      capturedEvents = events;
      return new Response(null, { status: 200 });
    });
    const realtimeServer = createSyncServer({
      ...options,
      upgradeWebSocket,
    });
    const realtimeApp = new Hono();
    realtimeApp.route('/sync', realtimeServer.syncRoutes);

    const response = await realtimeApp.request(
      'http://localhost/sync/realtime?clientId=client-hello&syncPackEncoding=binary-sync-pack-v1'
    );
    expect(response.status).toBe(200);

    const events = capturedEvents;
    if (!events?.onOpen) {
      throw new Error('Expected websocket handlers to be captured.');
    }

    const upstream = createUpstreamSocketHarness();
    events.onOpen(new Event('open'), upstream.ws);

    const helloMessage = upstream.messages.find(
      (message) => message.event === 'hello'
    );
    if (!isRecord(helloMessage?.data)) {
      throw new Error('Expected websocket hello data.');
    }
    expect(typeof helloMessage.data.sessionId).toBe('string');
    expect(helloMessage).toMatchObject({
      event: 'hello',
      data: expect.objectContaining({
        protocolVersion: 1,
        actorId: 'u1',
        clientId: 'client-hello',
        shardKey: 'sync-realtime-v1:default:default:default',
        transportPath: 'direct',
        syncPackEncoding: 'binary-sync-pack-v1',
        cursor: 0,
        latestCursor: 1,
        scopeCount: 1,
        requiresSync: true,
      }),
    });
  });

  it('updates active realtime scope membership after pull subscription changes', async () => {
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
    const manager = getSyncWebSocketConnectionManager(server.syncRoutes);
    if (!manager) {
      throw new Error('Expected websocket manager to be enabled.');
    }
    const app = new Hono();
    app.route('/sync', server.syncRoutes);

    const response = await app.request(
      'http://localhost/sync/realtime?clientId=client-scope-update'
    );
    expect(response.status).toBe(200);

    const events = capturedEvents;
    if (!events?.onOpen) {
      throw new Error('Expected websocket handlers to be captured.');
    }

    const upstream = createUpstreamSocketHarness();
    events.onOpen(new Event('open'), upstream.ws);

    manager.notifyScopeKeys(['default::user:u1'], 1);
    expect(
      upstream.messages.filter((message) => message.event === 'sync')
    ).toEqual([]);

    const subscribed = await app.request(
      createPullRequest({
        clientId: 'client-scope-update',
        userId: 'u1',
        subscriptionUserId: 'u1',
      })
    );
    expect(subscribed.status).toBe(200);

    manager.notifyScopeKeys(['default::user:u1'], 2);
    expect(
      upstream.messages
        .filter((message) => message.event === 'sync')
        .map((message) =>
          isRecord(message.data) ? message.data.cursor : undefined
        )
    ).toEqual([2]);

    const cleared = await app.request(
      createEmptyPullRequest({
        clientId: 'client-scope-update',
        userId: 'u1',
      })
    );
    expect(cleared.status).toBe(200);

    manager.notifyScopeKeys(['default::user:u1'], 3);
    expect(
      upstream.messages
        .filter((message) => message.event === 'sync')
        .map((message) =>
          isRecord(message.data) ? message.data.cursor : undefined
        )
    ).toEqual([2]);
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

  it('records W3C trace context on sync request events', async () => {
    process.env.SYNC_CONSOLE_TOKEN = 'env-token';
    const options = createOptions();
    const server = createSyncServer({
      ...options,
      console: {},
    });

    const app = new Hono();
    app.route('/sync', server.syncRoutes);

    const requestId = 'req-traceparent';
    const traceId = '0123456789abcdef0123456789abcdef';
    const spanId = '0123456789abcdef';
    const response = await app.request(
      createPushRequest({
        requestId,
        headers: {
          traceparent: `00-${traceId}-${spanId}-01`,
          'x-syncular-sync-attempt-id': traceId,
        },
      })
    );
    expect(response.status).toBe(200);

    const eventRow = await waitForRequestEventRow(requestId);
    expect(eventRow.trace_id).toBe(traceId);
    expect(eventRow.span_id).toBe(spanId);
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

  it('redacts sensitive fields in stored payload snapshots', async () => {
    process.env.SYNC_CONSOLE_TOKEN = 'env-token';
    await db.schema
      .alterTable('tasks')
      .addColumn('access_token', 'text')
      .addColumn('password', 'text')
      .addColumn('private_key', 'text')
      .execute();

    const options = createOptions();
    const server = createSyncServer({
      ...options,
      console: {},
      routes: {
        requestPayloadSnapshots: {
          enabled: true,
        },
      },
    });

    const app = new Hono();
    app.route('/sync', server.syncRoutes);

    const requestId = 'req-redacted-payload-snapshot';
    const response = await app.request(
      new Request('http://localhost/sync', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-request-id': requestId,
          authorization: 'Bearer header-token-not-captured',
        },
        body: JSON.stringify({
          clientId: 'client-redacted-payload',
          push: {
            commits: [
              {
                clientCommitId: 'commit-redacted-payload',
                schemaVersion: 1,
                operations: [
                  {
                    table: 'tasks',
                    row_id: 'task-redacted-payload',
                    op: 'upsert',
                    payload: {
                      id: 'task-redacted-payload',
                      user_id: 'u1',
                      title: 'Visible payload title',
                      server_version: 0,
                      access_token: 'payload-access-token',
                      password: 'payload-password',
                      private_key: 'payload-private-key',
                    },
                  },
                ],
              },
            ],
          },
        }),
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
    const storedJson = JSON.stringify(storedPayload);
    expect(storedJson).toContain('Visible payload title');
    expect(storedJson).toContain('[redacted]');
    expect(storedJson).not.toContain('payload-access-token');
    expect(storedJson).not.toContain('payload-password');
    expect(storedJson).not.toContain('payload-private-key');
    expect(storedJson).not.toContain('header-token-not-captured');
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
    expect(await response.json()).toMatchObject({
      error: 'sync.websocket_connection_limit',
      code: 'sync.websocket_connection_limit',
      category: 'rate-limited',
      retryable: true,
      recommendedAction: 'retryLater',
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
      type: 'sync' | 'push' | 'pull' | 'commit' | 'client_update';
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
