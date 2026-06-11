import { afterEach, describe, expect, it } from 'bun:test';
import { createDatabase } from '@syncular/core';
import { createBunSqliteDialect } from '@syncular/dialects/bun-sqlite';
import { Hono } from 'hono';
import { upgradeWebSocket, websocket } from 'hono/bun';
import { type Kysely, sql } from 'kysely';
import {
  createSyncularAppDatabase,
  newTaskOperation,
  syncularGeneratedCodecs,
  taskSubscription,
} from '../../../../rust/examples/todo-app/generated/typescript/syncular.generated';
import { createServerHandler, ensureSyncSchema } from '../../../server/src';
import { createSqliteServerDialect } from '../../../server-dialect-sqlite/src';
import {
  createSyncRoutes,
  getSyncWebSocketConnectionManager,
} from '../../../server-hono/src/routes';
import type {
  SyncularDiagnosticEvent,
  SyncularLiveQueryEvent,
  SyncularRuntimeClient,
} from '../types';
import {
  ensureHonoSyncTasksTable,
  type HonoAuthContext,
  type HonoSyncClientDb,
  type HonoSyncServerDb,
} from './fixtures/hono-sync-harness';
import { syncConformance } from './fixtures/sync-conformance';

const ACTOR_ID = syncConformance.actors.rust.actorId;
const AUTHORIZATION = syncConformance.actors.rust.token;
const REALTIME_TOKEN = syncConformance.realtime.websocketToken;
const MULTI_SCOPE_ACTOR_ID = 'multi-scope-writer';
const MULTI_SCOPE_TOKEN = 'Bearer multi-scope-writer';

describe('Syncular worker realtime against Hono websocket routes', () => {
  const clients: Array<{ close(): Promise<void> }> = [];
  const servers: Array<ReturnType<typeof Bun.serve>> = [];
  const dbs: Array<Kysely<HonoSyncServerDb>> = [];

  afterEach(async () => {
    while (clients.length > 0) await clients.pop()!.close();
    while (servers.length > 0) servers.pop()!.stop(true);
    while (dbs.length > 0) await dbs.pop()!.destroy();
  });

  it('applies websocket delta changes and emits live-query updates', async () => {
    const scenario = syncConformance.realtime;
    const {
      baseUrl,
      connectionCount,
      httpPullCount,
      websocketSyncPackEncodings,
    } = await openRealtimeServer();
    const clientA = await openClient({
      baseUrl,
      clientId: scenario.clientAId,
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
    await waitFor(() => connectionCount() === scenario.expectedConnectionCount);
    expect(websocketSyncPackEncodings).toContain('binary-sync-pack-v1');
    const pullCountBeforeRealtimePush = httpPullCount();
    const liveEvent = waitForLiveEvent(clientA, snapshot.id);

    const clientB = await openClient({
      baseUrl,
      clientId: scenario.clientBId,
    });
    await clientB.applyMutation(
      newTaskOperation({
        id: scenario.task.id,
        title: scenario.task.title,
        user_id: ACTOR_ID,
      }),
      {
        id: scenario.task.id,
        title: scenario.task.title,
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
          id: scenario.task.id,
          title: scenario.task.title,
          user_id: ACTOR_ID,
        },
      ],
    });
    expect(httpPullCount()).toBe(pullCountBeforeRealtimePush);
  });

  it('filters mixed-scope websocket binary deltas per subscribed client', async () => {
    const actorA = syncConformance.actors.ownerA;
    const actorB = syncConformance.actors.ownerB;
    const { baseUrl, connectionCount, httpPullCount } =
      await openRealtimeServer();
    const clientA = await openClient({
      baseUrl,
      clientId: 'mixed-scope-client-a',
      actorId: actorA.actorId,
      authorization: actorA.token,
    });
    const clientB = await openClient({
      baseUrl,
      clientId: 'mixed-scope-client-b',
      actorId: actorB.actorId,
      authorization: actorB.token,
    });
    await clientA.setSubscriptions([
      taskSubscription({ actorId: actorA.actorId }),
    ]);
    await clientB.setSubscriptions([
      taskSubscription({ actorId: actorB.actorId }),
    ]);
    await clientA.syncOnce();
    await clientB.syncOnce();

    const snapshotA = await clientA.subscribeQuery<{
      id: string;
      user_id: string;
    }>('select id, user_id from tasks order by id', [], ['tasks']);
    const snapshotB = await clientB.subscribeQuery<{
      id: string;
      user_id: string;
    }>('select id, user_id from tasks order by id', [], ['tasks']);
    expect(snapshotA.rows).toEqual([]);
    expect(snapshotB.rows).toEqual([]);

    await clientA.startRealtime({
      wsUrl: `${baseUrl.replace(/^http:/, 'ws:')}/realtime`,
      params: { token: actorA.token },
      heartbeatTimeoutMs: 0,
      initialReconnectDelayMs: 50,
    });
    await clientB.startRealtime({
      wsUrl: `${baseUrl.replace(/^http:/, 'ws:')}/realtime`,
      params: { token: actorB.token },
      heartbeatTimeoutMs: 0,
      initialReconnectDelayMs: 50,
    });
    await waitFor(() => connectionCount() === 2);
    const pullCountBeforeRealtimePush = httpPullCount();
    const liveEventA = waitForLiveEvent(clientA, snapshotA.id);
    const liveEventB = waitForLiveEvent(clientB, snapshotB.id);

    const writer = await openClient({
      baseUrl,
      clientId: 'mixed-scope-writer',
      actorId: MULTI_SCOPE_ACTOR_ID,
      authorization: MULTI_SCOPE_TOKEN,
    });
    await writer.applyMutationsCommit([
      {
        operation: newTaskOperation({
          id: 'mixed-scope-a',
          title: 'Mixed Scope A',
          user_id: actorA.actorId,
        }),
        localRow: {
          id: 'mixed-scope-a',
          title: 'Mixed Scope A',
          completed: 0,
          user_id: actorA.actorId,
          project_id: null,
          server_version: 0,
          image: null,
          title_yjs_state: null,
        },
      },
      {
        operation: newTaskOperation({
          id: 'mixed-scope-b',
          title: 'Mixed Scope B',
          user_id: actorB.actorId,
        }),
        localRow: {
          id: 'mixed-scope-b',
          title: 'Mixed Scope B',
          completed: 0,
          user_id: actorB.actorId,
          project_id: null,
          server_version: 0,
          image: null,
          title_yjs_state: null,
        },
      },
    ]);
    await expect(writer.syncPush()).resolves.toMatchObject({
      pushedCommits: 1,
    });

    await expect(liveEventA).resolves.toMatchObject({
      queryId: snapshotA.id,
      rows: [{ id: 'mixed-scope-a', user_id: actorA.actorId }],
    });
    await expect(liveEventB).resolves.toMatchObject({
      queryId: snapshotB.id,
      rows: [{ id: 'mixed-scope-b', user_id: actorB.actorId }],
    });
    expect(httpPullCount()).toBe(pullCountBeforeRealtimePush);
  });

  it('recovers through HTTP pull when websocket delta payloads are too large', async () => {
    const { baseUrl, connectionCount, db, httpPullCount } =
      await openRealtimeServer({ recordRequestEvents: true });
    const clientA = await openClient({
      baseUrl,
      clientId: 'large-delta-client-a',
    });
    await clientA.setSubscriptions([taskSubscription({ actorId: ACTOR_ID })]);
    await clientA.syncOnce();

    const snapshot = await clientA.subscribeQuery<{
      id: string;
      title: string;
    }>('select id, title from tasks order by id', [], ['tasks']);
    expect(snapshot.rows).toEqual([]);

    await clientA.startRealtime({
      wsUrl: `${baseUrl.replace(/^http:/, 'ws:')}/realtime`,
      params: { token: REALTIME_TOKEN },
      heartbeatTimeoutMs: 0,
      initialReconnectDelayMs: 50,
    });
    await waitFor(() => connectionCount() === 1);
    const pullCountBeforeRealtimePush = httpPullCount();
    const liveEvent = waitForLiveEvent(clientA, snapshot.id);
    const diagnostics: SyncularDiagnosticEvent[] = [];
    const removeDiagnostics = clientA.addDiagnosticListener((event) => {
      diagnostics.push(event);
    });

    const largeTitle = 'Large websocket pull recovery '.repeat(4096);
    const clientB = await openClient({
      baseUrl,
      clientId: 'large-delta-client-b',
    });
    await clientB.applyMutation(
      newTaskOperation({
        id: 'large-delta-task',
        title: largeTitle,
        user_id: ACTOR_ID,
      }),
      {
        id: 'large-delta-task',
        title: largeTitle,
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

    const event = await liveEvent;
    expect(event.queryId).toBe(snapshot.id);
    expect(event.rows).toHaveLength(1);
    expect(event.rows[0]?.id).toBe('large-delta-task');
    expect(event.rows[0]?.title).toHaveLength(largeTitle.length);
    expect(httpPullCount()).toBeGreaterThan(pullCountBeforeRealtimePush);

    const pullRequired = await waitForDiagnostic(
      clientA,
      diagnostics,
      (item) => item.code === 'realtime.pull_required'
    );
    expect(pullRequired?.syncAttemptId).toMatch(/^[0-9a-f]{32}$/);
    expect(pullRequired?.traceId).toBe(pullRequired?.syncAttemptId);
    removeDiagnostics();

    const requestEvent = await waitForSyncRequestEventByTrace(
      db,
      pullRequired!.traceId!,
      'pull'
    );
    expect(requestEvent).toMatchObject({
      trace_id: pullRequired!.traceId,
      span_id: pullRequired!.spanId,
      event_type: 'pull',
      client_id: 'large-delta-client-a',
      actor_id: ACTOR_ID,
      outcome: 'applied',
    });
  });

  it('reconnects websocket with fresh params after auth headers change', async () => {
    const scenario = syncConformance.realtime;
    const { baseUrl, connectionCount, websocketAuthTokens } =
      await openRealtimeServer({
        realtimeTokens: [
          scenario.websocketToken,
          scenario.refreshedWebsocketToken,
        ],
      });
    let realtimeToken = scenario.websocketToken;
    const client = await openClient({
      baseUrl,
      clientId: scenario.authRefreshClientId,
    });

    await client.startRealtime({
      wsUrl: `${baseUrl.replace(/^http:/, 'ws:')}/realtime`,
      getParams: () => ({ token: realtimeToken }),
      heartbeatTimeoutMs: 0,
      initialReconnectDelayMs: 50,
    });
    await waitFor(
      () =>
        websocketAuthTokens.length === 1 &&
        connectionCount() === scenario.expectedConnectionCount
    );

    realtimeToken = scenario.refreshedWebsocketToken;
    await client.setAuthHeaders({ authorization: AUTHORIZATION });
    await waitFor(
      () =>
        websocketAuthTokens.length === scenario.expectedAuthTokens.length &&
        connectionCount() === scenario.expectedConnectionCount
    );

    expect(websocketAuthTokens).toEqual(scenario.expectedAuthTokens);
  });

  it('round-trips presence through Hono websocket routes', async () => {
    const { baseUrl, connectionCount } = await openRealtimeServer();
    const scopeKey = `user:${ACTOR_ID}`;
    const clientA = await openClient({
      baseUrl,
      clientId: 'presence-client-a',
    });
    const clientB = await openClient({
      baseUrl,
      clientId: 'presence-client-b',
    });
    await clientA.setSubscriptions([taskSubscription({ actorId: ACTOR_ID })]);
    await clientB.setSubscriptions([taskSubscription({ actorId: ACTOR_ID })]);
    await clientA.syncOnce();
    await clientB.syncOnce();

    await clientA.startRealtime({
      wsUrl: `${baseUrl.replace(/^http:/, 'ws:')}/realtime`,
      params: { token: REALTIME_TOKEN },
      heartbeatTimeoutMs: 0,
      initialReconnectDelayMs: 50,
    });
    await clientB.startRealtime({
      wsUrl: `${baseUrl.replace(/^http:/, 'ws:')}/realtime`,
      params: { token: REALTIME_TOKEN },
      heartbeatTimeoutMs: 0,
      initialReconnectDelayMs: 50,
    });
    await waitFor(() => connectionCount() === 2);

    const joinEvent = waitForPresenceEvent(
      clientB,
      (event) =>
        event.scopeKey === scopeKey &&
        event.presence.some(
          (entry) =>
            entry.clientId === 'presence-client-a' &&
            entry.metadata?.editing === 'task-1'
        )
    );
    clientA.joinPresence(scopeKey, { editing: 'task-1' });
    await expect(joinEvent).resolves.toMatchObject({
      scopeKey,
      presence: [
        {
          clientId: 'presence-client-a',
          actorId: ACTOR_ID,
          metadata: { editing: 'task-1' },
        },
      ],
    });
    await waitFor(() =>
      clientA
        .getPresence(scopeKey)
        .some((entry) => entry.clientId === 'presence-client-a')
    );

    const updateEvent = waitForPresenceEvent(
      clientB,
      (event) =>
        event.scopeKey === scopeKey &&
        event.presence.some(
          (entry) =>
            entry.clientId === 'presence-client-a' &&
            entry.metadata?.editing === 'task-2'
        )
    );
    clientA.updatePresenceMetadata(scopeKey, { editing: 'task-2' });
    await expect(updateEvent).resolves.toMatchObject({
      scopeKey,
      presence: [
        {
          clientId: 'presence-client-a',
          actorId: ACTOR_ID,
          metadata: { editing: 'task-2' },
        },
      ],
    });

    const leaveEvent = waitForPresenceEvent(
      clientB,
      (event) => event.scopeKey === scopeKey && event.presence.length === 0
    );
    clientA.leavePresence(scopeKey);
    await expect(leaveEvent).resolves.toEqual({
      scopeKey,
      presence: [],
    });
  });

  async function openRealtimeServer(
    options: {
      realtimeTokens?: readonly string[];
      recordRequestEvents?: boolean;
    } = {}
  ): Promise<RealtimeServerHarness> {
    const dialect = createSqliteServerDialect();
    const db = createDatabase<HonoSyncServerDb>({
      dialect: createBunSqliteDialect({ path: ':memory:' }),
      family: 'sqlite',
    });
    dbs.push(db);
    await ensureSyncSchema(db, dialect);
    if (options.recordRequestEvents) {
      await dialect.ensureConsoleSchema(db);
    }
    await ensureHonoSyncTasksTable(db);
    const realtimeTokens = new Set(options.realtimeTokens ?? [REALTIME_TOKEN]);
    const tokenActors = new Map<string, string>([
      [AUTHORIZATION, ACTOR_ID],
      [REALTIME_TOKEN, ACTOR_ID],
      [MULTI_SCOPE_TOKEN, MULTI_SCOPE_ACTOR_ID],
      [
        syncConformance.actors.ownerA.token,
        syncConformance.actors.ownerA.actorId,
      ],
      [
        syncConformance.actors.ownerB.token,
        syncConformance.actors.ownerB.actorId,
      ],
    ]);
    for (const token of realtimeTokens) {
      if (!tokenActors.has(token)) tokenActors.set(token, ACTOR_ID);
    }
    const websocketAuthTokens: string[] = [];
    const websocketSyncPackEncodings: string[] = [];
    let httpPullCount = 0;

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
          resolveScopes: async (ctx) => ({
            user_id:
              ctx.actorId === MULTI_SCOPE_ACTOR_ID
                ? [
                    syncConformance.actors.ownerA.actorId,
                    syncConformance.actors.ownerB.actorId,
                  ]
                : [ctx.actorId],
          }),
        }),
      ],
      authenticate: async (c) => {
        const authorization = c.req.header('authorization');
        const token = c.req.query('token');
        const syncPackEncoding = c.req.query('syncPackEncoding');
        if (token) websocketAuthTokens.push(token);
        if (token && syncPackEncoding) {
          websocketSyncPackEncodings.push(syncPackEncoding);
        }
        const actorId =
          tokenActors.get(authorization ?? '') ?? tokenActors.get(token ?? '');
        if (actorId) {
          return { actorId };
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
      consoleLiveEmitter: options.recordRequestEvents
        ? { emit() {} }
        : undefined,
      consoleSchemaReady: options.recordRequestEvents
        ? Promise.resolve()
        : undefined,
    });
    const connectionManager = getSyncWebSocketConnectionManager(routes);
    if (!connectionManager) {
      throw new Error('Expected Hono sync websocket manager');
    }

    const app = new Hono().route('/sync', routes);
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: async (request, server) => {
        if (
          request.method === 'POST' &&
          new URL(request.url).pathname === '/sync'
        ) {
          try {
            const body = await request.clone().json();
            if (body && typeof body === 'object' && 'pull' in body) {
              httpPullCount += 1;
            }
          } catch {
            // Ignore malformed request bodies; route validation covers them.
          }
        }
        const response = await app.fetch(request, server);
        if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
          return response;
        }
        return toNativeBunResponse(response);
      },
      websocket,
      idleTimeout: 0,
    });
    servers.push(server);

    return {
      baseUrl: `http://127.0.0.1:${server.port}/sync`,
      db,
      connectionCount: () => connectionManager.getTotalConnections(),
      httpPullCount: () => httpPullCount,
      websocketAuthTokens,
      websocketSyncPackEncodings,
    };
  }

  async function openClient(options: {
    baseUrl: string;
    clientId: string;
    actorId?: string;
    authorization?: string;
  }): Promise<SyncularRuntimeClient> {
    const database = await createSyncularAppDatabase({
      requestTimeoutMs: 10_000,
      getHeaders: () => ({
        authorization: options.authorization ?? AUTHORIZATION,
      }),
      config: {
        baseUrl: options.baseUrl,
        clientId: options.clientId,
        actorId: options.actorId ?? ACTOR_ID,
        fileName: `${options.clientId}.sqlite`,
        storage: 'memory',
        clearOnInit: true,
      },
    });
    clients.push(database);
    return database.client;
  }
});

interface RealtimeServerHarness {
  baseUrl: string;
  db: Kysely<HonoSyncServerDb>;
  connectionCount(): number;
  httpPullCount(): number;
  websocketAuthTokens: string[];
  websocketSyncPackEncodings: string[];
}

function waitForLiveEvent(
  client: SyncularRuntimeClient,
  queryId: string
): Promise<SyncularLiveQueryEvent<Record<string, unknown>>> {
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

async function waitForSyncRequestEventByTrace(
  db: Kysely<HonoSyncServerDb>,
  traceId: string,
  eventType: 'pull' | 'push'
): Promise<{
  trace_id: string | null;
  span_id: string | null;
  event_type: string;
  client_id: string;
  actor_id: string;
  outcome: string;
}> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = await sql<{
      trace_id: string | null;
      span_id: string | null;
      event_type: string;
      client_id: string;
      actor_id: string;
      outcome: string;
    }>`
      SELECT trace_id, span_id, event_type, client_id, actor_id, outcome
      FROM sync_request_events
      WHERE trace_id = ${traceId}
        AND event_type = ${eventType}
      ORDER BY event_id DESC
      LIMIT 1
    `.execute(db);
    const row = result.rows[0];
    if (row) return row;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for sync_request_events trace ${traceId}`);
}

async function waitForDiagnostic(
  client: SyncularRuntimeClient,
  observed: SyncularDiagnosticEvent[],
  predicate: (event: SyncularDiagnosticEvent) => boolean
): Promise<SyncularDiagnosticEvent> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const snapshot = await client.diagnosticSnapshot();
    const event = [...observed, ...snapshot.recentDiagnostics].find(predicate);
    if (event) return event;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for diagnostic event');
}

async function toNativeBunResponse(response: Response): Promise<Response> {
  const NativeResponse = (globalThis as Record<string, unknown>)
    .__nativeResponse as typeof Response | undefined;
  if (!NativeResponse || response instanceof NativeResponse) return response;

  const headers: [string, string][] = [];
  response.headers.forEach((value, key) => {
    headers.push([key, value]);
  });
  const body =
    response.status === 204 || response.status === 304
      ? null
      : await response.arrayBuffer();
  return new NativeResponse(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function waitForPresenceEvent(
  client: SyncularRuntimeClient,
  predicate: (event: {
    scopeKey: string;
    presence: Array<{
      clientId: string;
      actorId: string;
      metadata?: Record<string, unknown>;
    }>;
  }) => boolean
): Promise<{
  scopeKey: string;
  presence: Array<{
    clientId: string;
    actorId: string;
    metadata?: Record<string, unknown>;
  }>;
}> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error('Timed out waiting for realtime presence event'));
    }, 5_000);
    const unsubscribe = client.addPresenceListener((event) => {
      if (!predicate(event)) return;
      clearTimeout(timeout);
      unsubscribe();
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
