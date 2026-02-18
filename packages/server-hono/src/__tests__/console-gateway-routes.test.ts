import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import type {
  ConsoleApiKey,
  ConsoleClient,
  ConsoleCommitListItem,
  ConsoleHandler,
  ConsoleOperationEvent,
  ConsolePaginatedResponse,
  ConsoleRequestEvent,
  ConsoleRequestPayload,
  ConsoleTimelineItem,
  LatencyStatsResponse,
  SyncStats,
  TimeseriesStatsResponse,
} from '../console';
import { createConsoleGatewayRoutes } from '../console';

const CONSOLE_TOKEN = 'gateway-token';

interface MockInstanceData {
  stats: SyncStats;
  timeseries: TimeseriesStatsResponse;
  latency: LatencyStatsResponse;
  handlers: ConsoleHandler[];
  apiKeys: ConsoleApiKey[];
  commits: ConsoleCommitListItem[];
  clients: ConsoleClient[];
  timeline: ConsoleTimelineItem[];
  operations: ConsoleOperationEvent[];
  events: ConsoleRequestEvent[];
  payloadsByEventId: Record<number, ConsoleRequestPayload>;
}

function readAuthorization(headers: HeadersInit | undefined): string | null {
  if (!headers) return null;
  if (headers instanceof Headers) {
    return headers.get('Authorization');
  }
  if (Array.isArray(headers)) {
    const header = headers.find(
      ([name]) => name.toLowerCase() === 'authorization'
    );
    return header?.[1] ?? null;
  }
  return headers.Authorization ?? headers.authorization ?? null;
}

function createPaginatedResponse<T>(args: {
  items: T[];
  offset: number;
  limit: number;
}): ConsolePaginatedResponse<T> {
  const total = args.items.length;
  return {
    items: args.items.slice(args.offset, args.offset + args.limit),
    total,
    offset: args.offset,
    limit: args.limit,
  };
}

function parseJsonBody(init: RequestInit | undefined): unknown {
  if (!init?.body || typeof init.body !== 'string') {
    return null;
  }
  try {
    return JSON.parse(init.body) as unknown;
  } catch {
    return null;
  }
}

function createMockGatewayApp(args: {
  instances: Record<string, MockInstanceData>;
  failingInstances?: Set<string>;
}) {
  const downstreamCalls: string[] = [];
  const failingInstances = args.failingInstances ?? new Set<string>();
  const instanceByHost = new Map<string, MockInstanceData>();
  for (const [instanceId, data] of Object.entries(args.instances)) {
    instanceByHost.set(`${instanceId}.example.test`, data);
  }

  const app = new Hono();
  app.route(
    '/console',
    createConsoleGatewayRoutes({
      instances: Object.keys(args.instances).map((instanceId) => ({
        instanceId,
        label: instanceId.toUpperCase(),
        baseUrl: `https://${instanceId}.example.test/api/${instanceId}`,
      })),
      authenticate: async (c) => {
        const authHeader = c.req.header('Authorization');
        if (authHeader === `Bearer ${CONSOLE_TOKEN}`) {
          return { consoleUserId: 'gateway-user' };
        }
        return null;
      },
      fetchImpl: async (input, init) => {
        const url =
          typeof input === 'string'
            ? new URL(input)
            : input instanceof URL
              ? input
              : new URL(input.url);
        downstreamCalls.push(url.toString());

        const instanceId = url.hostname.replace('.example.test', '');
        if (!instanceId || failingInstances.has(instanceId)) {
          return new Response(
            JSON.stringify({ error: 'DOWNSTREAM_UNAVAILABLE' }),
            { status: 503 }
          );
        }

        const expectedAuthorization = `Bearer ${CONSOLE_TOKEN}`;
        if (readAuthorization(init?.headers) !== expectedAuthorization) {
          return new Response(JSON.stringify({ error: 'UNAUTHORIZED' }), {
            status: 401,
          });
        }

        const data = instanceByHost.get(url.hostname);
        if (!data) {
          return new Response(JSON.stringify({ error: 'NOT_FOUND' }), {
            status: 404,
          });
        }

        const method = (init?.method ?? 'GET').toUpperCase();
        const pathname = url.pathname;
        if (pathname.endsWith('/console/stats')) {
          return new Response(JSON.stringify(data.stats), { status: 200 });
        }
        if (pathname.endsWith('/console/stats/timeseries')) {
          return new Response(JSON.stringify(data.timeseries), { status: 200 });
        }
        if (pathname.endsWith('/console/stats/latency')) {
          return new Response(JSON.stringify(data.latency), { status: 200 });
        }
        if (pathname.endsWith('/console/handlers') && method === 'GET') {
          return new Response(JSON.stringify({ items: data.handlers }), {
            status: 200,
          });
        }
        if (pathname.endsWith('/console/prune/preview') && method === 'POST') {
          return new Response(
            JSON.stringify({
              watermarkCommitSeq: data.stats.maxCommitSeq,
              commitsToDelete: data.commits.length,
            }),
            { status: 200 }
          );
        }
        if (pathname.endsWith('/console/prune') && method === 'POST') {
          return new Response(
            JSON.stringify({ deletedCommits: data.commits.length }),
            { status: 200 }
          );
        }
        if (pathname.endsWith('/console/compact') && method === 'POST') {
          return new Response(
            JSON.stringify({ deletedChanges: data.stats.changeCount }),
            { status: 200 }
          );
        }
        if (
          pathname.endsWith('/console/notify-data-change') &&
          method === 'POST'
        ) {
          const body = parseJsonBody(init) as {
            tables?: string[];
          } | null;
          const tables = body?.tables ?? [];
          return new Response(
            JSON.stringify({
              commitSeq: data.stats.maxCommitSeq + 1,
              tables,
              deletedChunks: 0,
            }),
            { status: 200 }
          );
        }
        if (pathname.endsWith('/console/events') && method === 'DELETE') {
          return new Response(
            JSON.stringify({ deletedCount: data.events.length }),
            { status: 200 }
          );
        }
        if (pathname.endsWith('/console/events/prune') && method === 'POST') {
          return new Response(JSON.stringify({ deletedCount: 1 }), {
            status: 200,
          });
        }
        if (pathname.endsWith('/console/api-keys') && method === 'GET') {
          return new Response(
            JSON.stringify(
              createPaginatedResponse({
                items: data.apiKeys,
                offset: Number(url.searchParams.get('offset') ?? '0'),
                limit: Number(url.searchParams.get('limit') ?? '50'),
              })
            ),
            { status: 200 }
          );
        }
        if (pathname.endsWith('/console/api-keys') && method === 'POST') {
          const createdAt = '2026-02-17T10:10:00.000Z';
          return new Response(
            JSON.stringify({
              key: {
                keyId: `${instanceId}-new-key`,
                keyPrefix: `${instanceId}-new`,
                name: `${instanceId} created key`,
                keyType: 'admin',
                scopeKeys: ['*'],
                actorId: null,
                createdAt,
                expiresAt: null,
                lastUsedAt: null,
                revokedAt: null,
              },
              secretKey: `${instanceId}_secret_key`,
            }),
            { status: 201 }
          );
        }

        const limit = Number(url.searchParams.get('limit') ?? '50');
        const offset = Number(url.searchParams.get('offset') ?? '0');
        if (pathname.endsWith('/console/commits')) {
          return new Response(
            JSON.stringify(
              createPaginatedResponse({
                items: data.commits,
                offset,
                limit,
              })
            ),
            { status: 200 }
          );
        }
        const commitDetailMatch = pathname.match(/\/console\/commits\/(.+)$/);
        if (commitDetailMatch) {
          const commitSeq = Number(commitDetailMatch[1]);
          const commit = data.commits.find(
            (item) => item.commitSeq === commitSeq
          );
          if (!commit) {
            return new Response(JSON.stringify({ error: 'NOT_FOUND' }), {
              status: 404,
            });
          }
          return new Response(
            JSON.stringify({
              ...commit,
              changes: [],
            }),
            { status: 200 }
          );
        }
        if (pathname.endsWith('/console/clients')) {
          return new Response(
            JSON.stringify(
              createPaginatedResponse({
                items: data.clients,
                offset,
                limit,
              })
            ),
            { status: 200 }
          );
        }
        if (pathname.endsWith('/console/timeline')) {
          return new Response(
            JSON.stringify(
              createPaginatedResponse({
                items: data.timeline,
                offset,
                limit,
              })
            ),
            { status: 200 }
          );
        }
        if (pathname.endsWith('/console/operations')) {
          return new Response(
            JSON.stringify(
              createPaginatedResponse({
                items: data.operations,
                offset,
                limit,
              })
            ),
            { status: 200 }
          );
        }
        if (pathname.endsWith('/console/events')) {
          return new Response(
            JSON.stringify(
              createPaginatedResponse({
                items: data.events,
                offset,
                limit,
              })
            ),
            { status: 200 }
          );
        }
        const evictClientMatch = pathname.match(/\/console\/clients\/(.+)$/);
        if (evictClientMatch && method === 'DELETE') {
          return new Response(JSON.stringify({ evicted: true }), {
            status: 200,
          });
        }

        const eventDetailMatch = pathname.match(/\/console\/events\/(\d+)$/);
        if (eventDetailMatch) {
          const eventId = Number(eventDetailMatch[1]);
          const event = data.events.find((item) => item.eventId === eventId);
          if (!event) {
            return new Response(JSON.stringify({ error: 'NOT_FOUND' }), {
              status: 404,
            });
          }
          return new Response(JSON.stringify(event), { status: 200 });
        }

        const eventPayloadMatch = pathname.match(
          /\/console\/events\/(\d+)\/payload$/
        );
        if (eventPayloadMatch) {
          const eventId = Number(eventPayloadMatch[1]);
          const payload = data.payloadsByEventId[eventId];
          if (!payload) {
            return new Response(JSON.stringify({ error: 'NOT_FOUND' }), {
              status: 404,
            });
          }
          return new Response(JSON.stringify(payload), { status: 200 });
        }

        const apiKeyStageRotateMatch = pathname.match(
          /\/console\/api-keys\/([^/]+)\/rotate\/stage$/
        );
        if (apiKeyStageRotateMatch && method === 'POST') {
          const keyId = apiKeyStageRotateMatch[1] ?? 'unknown';
          return new Response(
            JSON.stringify({
              key: {
                keyId: `${keyId}-staged`,
                keyPrefix: `${keyId}-stg`,
                name: `${instanceId} staged key`,
                keyType: 'admin',
                scopeKeys: ['*'],
                actorId: null,
                createdAt: '2026-02-17T10:11:00.000Z',
                expiresAt: null,
                lastUsedAt: null,
                revokedAt: null,
              },
              secretKey: `${instanceId}_staged_secret`,
            }),
            { status: 200 }
          );
        }

        const apiKeyRotateMatch = pathname.match(
          /\/console\/api-keys\/([^/]+)\/rotate$/
        );
        if (apiKeyRotateMatch && method === 'POST') {
          const keyId = apiKeyRotateMatch[1] ?? 'unknown';
          return new Response(
            JSON.stringify({
              key: {
                keyId: `${keyId}-rotated`,
                keyPrefix: `${keyId}-rot`,
                name: `${instanceId} rotated key`,
                keyType: 'admin',
                scopeKeys: ['*'],
                actorId: null,
                createdAt: '2026-02-17T10:12:00.000Z',
                expiresAt: null,
                lastUsedAt: null,
                revokedAt: null,
              },
              secretKey: `${instanceId}_rotated_secret`,
            }),
            { status: 200 }
          );
        }

        const apiKeyMatch = pathname.match(/\/console\/api-keys\/([^/]+)$/);
        if (apiKeyMatch && method === 'GET') {
          const keyId = apiKeyMatch[1] ?? '';
          const key = data.apiKeys.find((item) => item.keyId === keyId);
          if (!key) {
            return new Response(JSON.stringify({ error: 'NOT_FOUND' }), {
              status: 404,
            });
          }
          return new Response(JSON.stringify(key), { status: 200 });
        }
        if (apiKeyMatch && method === 'DELETE') {
          return new Response(JSON.stringify({ revoked: true }), {
            status: 200,
          });
        }
        if (pathname.endsWith('/console/api-keys/bulk-revoke')) {
          const body = parseJsonBody(init) as { keyIds?: string[] } | null;
          const keyIds = body?.keyIds ?? [];
          return new Response(
            JSON.stringify({
              requestedCount: keyIds.length,
              revokedCount: keyIds.length,
              alreadyRevokedCount: 0,
              notFoundCount: 0,
              revokedKeyIds: keyIds,
              alreadyRevokedKeyIds: [],
              notFoundKeyIds: [],
            }),
            { status: 200 }
          );
        }

        return new Response(JSON.stringify({ error: 'NOT_IMPLEMENTED' }), {
          status: 404,
        });
      },
    })
  );

  return { app, downstreamCalls };
}

describe('createConsoleGatewayRoutes', () => {
  const alphaStats: SyncStats = {
    commitCount: 10,
    changeCount: 30,
    minCommitSeq: 1,
    maxCommitSeq: 40,
    clientCount: 2,
    activeClientCount: 1,
    minActiveClientCursor: 35,
    maxActiveClientCursor: 35,
  };

  const betaStats: SyncStats = {
    commitCount: 4,
    changeCount: 9,
    minCommitSeq: 3,
    maxCommitSeq: 18,
    clientCount: 1,
    activeClientCount: 1,
    minActiveClientCursor: 18,
    maxActiveClientCursor: 18,
  };

  const alphaTimeseries: TimeseriesStatsResponse = {
    interval: 'hour',
    range: '24h',
    buckets: [
      {
        timestamp: '2026-02-17T09:00:00.000Z',
        pushCount: 1,
        pullCount: 1,
        errorCount: 0,
        avgLatencyMs: 20,
      },
      {
        timestamp: '2026-02-17T10:00:00.000Z',
        pushCount: 0,
        pullCount: 1,
        errorCount: 1,
        avgLatencyMs: 40,
      },
    ],
  };

  const betaTimeseries: TimeseriesStatsResponse = {
    interval: 'hour',
    range: '24h',
    buckets: [
      {
        timestamp: '2026-02-17T09:00:00.000Z',
        pushCount: 2,
        pullCount: 0,
        errorCount: 1,
        avgLatencyMs: 50,
      },
      {
        timestamp: '2026-02-17T10:00:00.000Z',
        pushCount: 1,
        pullCount: 1,
        errorCount: 0,
        avgLatencyMs: 10,
      },
    ],
  };

  const alphaLatency: LatencyStatsResponse = {
    push: { p50: 10, p90: 20, p99: 30 },
    pull: { p50: 12, p90: 22, p99: 32 },
    range: '24h',
  };

  const betaLatency: LatencyStatsResponse = {
    push: { p50: 20, p90: 40, p99: 60 },
    pull: { p50: 14, p90: 24, p99: 34 },
    range: '24h',
  };

  const alphaHandlers: ConsoleHandler[] = [
    { table: 'tasks', dependsOn: ['projects'], snapshotChunkTtlMs: 60000 },
  ];
  const betaHandlers: ConsoleHandler[] = [
    { table: 'orders', dependsOn: ['customers'], snapshotChunkTtlMs: 60000 },
  ];

  const alphaApiKeys: ConsoleApiKey[] = [
    {
      keyId: 'alpha-key-1',
      keyPrefix: 'alpha-key',
      name: 'Alpha admin key',
      keyType: 'admin',
      scopeKeys: ['*'],
      actorId: null,
      createdAt: '2026-02-17T10:00:00.000Z',
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
    },
  ];
  const betaApiKeys: ConsoleApiKey[] = [
    {
      keyId: 'beta-key-1',
      keyPrefix: 'beta-key',
      name: 'Beta relay key',
      keyType: 'relay',
      scopeKeys: ['tenant-b'],
      actorId: null,
      createdAt: '2026-02-17T10:00:00.000Z',
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
    },
  ];

  const alphaCommits: ConsoleCommitListItem[] = [
    {
      commitSeq: 40,
      actorId: 'a1',
      clientId: 'client-shared',
      clientCommitId: 'alpha-40',
      createdAt: '2026-02-17T10:04:00.000Z',
      changeCount: 2,
      affectedTables: ['tasks'],
    },
    {
      commitSeq: 39,
      actorId: 'a2',
      clientId: 'client-shared',
      clientCommitId: 'alpha-39',
      createdAt: '2026-02-17T10:03:00.000Z',
      changeCount: 1,
      affectedTables: ['tasks'],
    },
  ];

  const betaCommits: ConsoleCommitListItem[] = [
    {
      commitSeq: 18,
      actorId: 'b1',
      clientId: 'client-shared',
      clientCommitId: 'beta-18',
      createdAt: '2026-02-17T10:05:00.000Z',
      changeCount: 3,
      affectedTables: ['orders'],
    },
  ];

  const alphaClients: ConsoleClient[] = [
    {
      clientId: 'client-shared',
      actorId: 'a1',
      cursor: 35,
      lagCommitCount: 5,
      connectionPath: 'direct',
      connectionMode: 'realtime',
      realtimeConnectionCount: 1,
      isRealtimeConnected: true,
      activityState: 'active',
      lastRequestAt: '2026-02-17T10:06:00.000Z',
      lastRequestType: 'pull',
      lastRequestOutcome: 'ok',
      effectiveScopes: { org_id: 'alpha' },
      updatedAt: '2026-02-17T10:06:00.000Z',
    },
  ];

  const betaClients: ConsoleClient[] = [
    {
      clientId: 'client-shared',
      actorId: 'b1',
      cursor: 18,
      lagCommitCount: 0,
      connectionPath: 'relay',
      connectionMode: 'polling',
      realtimeConnectionCount: 0,
      isRealtimeConnected: false,
      activityState: 'idle',
      lastRequestAt: '2026-02-17T10:05:30.000Z',
      lastRequestType: 'pull',
      lastRequestOutcome: 'ok',
      effectiveScopes: { org_id: 'beta' },
      updatedAt: '2026-02-17T10:05:30.000Z',
    },
  ];

  const alphaEvents: ConsoleRequestEvent[] = [
    {
      eventId: 1001,
      partitionId: 'tenant-a',
      requestId: 'alpha-req-1',
      traceId: null,
      spanId: null,
      eventType: 'pull',
      syncPath: 'http-combined',
      transportPath: 'direct',
      actorId: 'a1',
      clientId: 'client-shared',
      statusCode: 200,
      outcome: 'success',
      responseStatus: 'ok',
      errorCode: null,
      durationMs: 23,
      commitSeq: 40,
      operationCount: 1,
      rowCount: 2,
      subscriptionCount: 0,
      scopesSummary: null,
      tables: ['tasks'],
      errorMessage: null,
      payloadRef: 'payload-alpha-1001',
      createdAt: '2026-02-17T10:03:30.000Z',
    },
  ];

  const betaEvents: ConsoleRequestEvent[] = [
    {
      eventId: 2001,
      partitionId: 'tenant-b',
      requestId: 'beta-req-1',
      traceId: null,
      spanId: null,
      eventType: 'push',
      syncPath: 'http-combined',
      transportPath: 'relay',
      actorId: 'b1',
      clientId: 'client-shared',
      statusCode: 200,
      outcome: 'success',
      responseStatus: 'ok',
      errorCode: null,
      durationMs: 30,
      commitSeq: 18,
      operationCount: 1,
      rowCount: 3,
      subscriptionCount: 0,
      scopesSummary: null,
      tables: ['orders'],
      errorMessage: null,
      payloadRef: 'payload-beta-2001',
      createdAt: '2026-02-17T10:05:00.000Z',
    },
  ];

  const alphaOperations: ConsoleOperationEvent[] = [
    {
      operationId: 101,
      operationType: 'notify_data_change',
      consoleUserId: 'console-a',
      partitionId: 'tenant-a',
      targetClientId: null,
      requestPayload: { tables: ['tasks'] },
      resultPayload: { commitSeq: 40 },
      createdAt: '2026-02-17T10:06:30.000Z',
    },
  ];

  const betaOperations: ConsoleOperationEvent[] = [
    {
      operationId: 201,
      operationType: 'evict_client',
      consoleUserId: 'console-b',
      partitionId: 'tenant-b',
      targetClientId: 'client-shared',
      requestPayload: { clientId: 'client-shared' },
      resultPayload: { evicted: true },
      createdAt: '2026-02-17T10:06:00.000Z',
    },
  ];

  const alphaTimeline: ConsoleTimelineItem[] = [
    {
      type: 'commit',
      timestamp: '2026-02-17T10:04:00.000Z',
      commit: alphaCommits[0],
      event: null,
    },
    {
      type: 'event',
      timestamp: '2026-02-17T10:03:30.000Z',
      commit: null,
      event: alphaEvents[0] ?? null,
    },
  ];

  const betaTimeline: ConsoleTimelineItem[] = [
    {
      type: 'event',
      timestamp: '2026-02-17T10:05:00.000Z',
      commit: null,
      event: betaEvents[0] ?? null,
    },
  ];

  const instanceData: Record<string, MockInstanceData> = {
    alpha: {
      stats: alphaStats,
      timeseries: alphaTimeseries,
      latency: alphaLatency,
      handlers: alphaHandlers,
      apiKeys: alphaApiKeys,
      commits: alphaCommits,
      clients: alphaClients,
      timeline: alphaTimeline,
      operations: alphaOperations,
      events: alphaEvents,
      payloadsByEventId: {
        1001: {
          payloadRef: 'payload-alpha-1001',
          partitionId: 'tenant-a',
          requestPayload: {
            clientId: 'client-shared',
            pull: { cursor: 39 },
          },
          responsePayload: {
            pull: { commitSeq: 40 },
          },
          createdAt: '2026-02-17T10:03:30.000Z',
        },
      },
    },
    beta: {
      stats: betaStats,
      timeseries: betaTimeseries,
      latency: betaLatency,
      handlers: betaHandlers,
      apiKeys: betaApiKeys,
      commits: betaCommits,
      clients: betaClients,
      timeline: betaTimeline,
      operations: betaOperations,
      events: betaEvents,
      payloadsByEventId: {
        2001: {
          payloadRef: 'payload-beta-2001',
          partitionId: 'tenant-b',
          requestPayload: {
            clientId: 'client-shared',
            push: { clientCommitId: 'beta-18' },
          },
          responsePayload: {
            push: { commitSeq: 18 },
          },
          createdAt: '2026-02-17T10:05:00.000Z',
        },
      },
    },
  };

  it('requires auth and lists configured instances', async () => {
    const { app } = createMockGatewayApp({ instances: instanceData });

    const unauthorized = await app.request(
      'http://localhost/console/instances'
    );
    expect(unauthorized.status).toBe(401);

    const response = await app.request('http://localhost/console/instances', {
      headers: { Authorization: `Bearer ${CONSOLE_TOKEN}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: Array<{ instanceId: string; enabled: boolean }>;
    };

    expect(body.items.map((item) => item.instanceId).sort()).toEqual([
      'alpha',
      'beta',
    ]);
    expect(body.items.every((item) => item.enabled)).toBe(true);
  });

  it('reports downstream instance health and supports instance filters', async () => {
    const { app } = createMockGatewayApp({
      instances: instanceData,
      failingInstances: new Set(['beta']),
    });

    const response = await app.request(
      'http://localhost/console/instances/health',
      {
        headers: { Authorization: `Bearer ${CONSOLE_TOKEN}` },
      }
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: Array<{
        instanceId: string;
        healthy: boolean;
        status?: number;
        reason?: string;
        responseTimeMs: number;
        checkedAt: string;
      }>;
      partial: boolean;
      failedInstances: Array<{
        instanceId: string;
        reason: string;
        status?: number;
      }>;
    };

    expect(body.items).toHaveLength(2);
    const alpha = body.items.find((item) => item.instanceId === 'alpha');
    const beta = body.items.find((item) => item.instanceId === 'beta');

    expect(alpha?.healthy).toBe(true);
    expect(alpha?.status).toBe(200);
    expect(typeof alpha?.responseTimeMs).toBe('number');
    expect(typeof alpha?.checkedAt).toBe('string');

    expect(beta?.healthy).toBe(false);
    expect(beta?.status).toBe(503);
    expect(beta?.reason).toBe('HTTP 503');
    expect(body.partial).toBe(true);
    expect(body.failedInstances).toEqual([
      { instanceId: 'beta', reason: 'HTTP 503', status: 503 },
    ]);

    const filteredResponse = await app.request(
      'http://localhost/console/instances/health?instanceId=alpha',
      {
        headers: { Authorization: `Bearer ${CONSOLE_TOKEN}` },
      }
    );
    expect(filteredResponse.status).toBe(200);
    const filteredBody = (await filteredResponse.json()) as {
      items: Array<{ instanceId: string; healthy: boolean }>;
      partial: boolean;
    };

    expect(filteredBody.items).toHaveLength(1);
    expect(filteredBody.items[0]?.instanceId).toBe('alpha');
    expect(filteredBody.items[0]?.healthy).toBe(true);
    expect(filteredBody.partial).toBe(false);

    const noMatchResponse = await app.request(
      'http://localhost/console/instances/health?instanceId=missing',
      {
        headers: { Authorization: `Bearer ${CONSOLE_TOKEN}` },
      }
    );
    expect(noMatchResponse.status).toBe(400);
    const noMatchBody = (await noMatchResponse.json()) as {
      error: string;
    };
    expect(noMatchBody.error).toBe('NO_INSTANCES_SELECTED');
  });

  it('merges stats and reports partial failures', async () => {
    const { app } = createMockGatewayApp({
      instances: instanceData,
      failingInstances: new Set(['beta']),
    });

    const response = await app.request('http://localhost/console/stats', {
      headers: { Authorization: `Bearer ${CONSOLE_TOKEN}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as SyncStats & {
      partial: boolean;
      failedInstances: Array<{ instanceId: string; reason: string }>;
      maxCommitSeqByInstance: Record<string, number>;
      minCommitSeqByInstance: Record<string, number>;
    };

    expect(body.commitCount).toBe(alphaStats.commitCount);
    expect(body.changeCount).toBe(alphaStats.changeCount);
    expect(body.maxCommitSeqByInstance.alpha).toBe(alphaStats.maxCommitSeq);
    expect(body.minCommitSeqByInstance.alpha).toBe(alphaStats.minCommitSeq);
    expect(body.partial).toBe(true);
    expect(body.failedInstances).toEqual([
      { instanceId: 'beta', reason: 'HTTP 503', status: 503 },
    ]);
  });

  it('merges timeseries and latency stats across instances', async () => {
    const { app } = createMockGatewayApp({ instances: instanceData });

    const timeseriesResponse = await app.request(
      'http://localhost/console/stats/timeseries?interval=hour&range=24h',
      {
        headers: { Authorization: `Bearer ${CONSOLE_TOKEN}` },
      }
    );
    expect(timeseriesResponse.status).toBe(200);
    const timeseriesBody = (await timeseriesResponse.json()) as {
      buckets: TimeseriesStatsResponse['buckets'];
      interval: 'hour' | 'minute' | 'day';
      range: '1h' | '6h' | '24h' | '7d' | '30d';
      partial: boolean;
    };

    expect(timeseriesBody.interval).toBe('hour');
    expect(timeseriesBody.range).toBe('24h');
    expect(timeseriesBody.partial).toBe(false);
    expect(timeseriesBody.buckets).toHaveLength(2);
    expect(timeseriesBody.buckets[0]).toMatchObject({
      timestamp: '2026-02-17T09:00:00.000Z',
      pushCount: 3,
      pullCount: 1,
      errorCount: 1,
    });
    expect(timeseriesBody.buckets[1]).toMatchObject({
      timestamp: '2026-02-17T10:00:00.000Z',
      pushCount: 1,
      pullCount: 2,
      errorCount: 1,
    });
    expect(timeseriesBody.buckets[0]?.avgLatencyMs).toBeCloseTo(35, 5);
    expect(timeseriesBody.buckets[1]?.avgLatencyMs).toBeCloseTo(20, 5);

    const latencyResponse = await app.request(
      'http://localhost/console/stats/latency?range=24h',
      {
        headers: { Authorization: `Bearer ${CONSOLE_TOKEN}` },
      }
    );
    expect(latencyResponse.status).toBe(200);
    const latencyBody =
      (await latencyResponse.json()) as LatencyStatsResponse & {
        partial: boolean;
      };

    expect(latencyBody.range).toBe('24h');
    expect(latencyBody.partial).toBe(false);
    expect(latencyBody.push.p50).toBe(15);
    expect(latencyBody.push.p90).toBe(30);
    expect(latencyBody.push.p99).toBe(45);
    expect(latencyBody.pull.p50).toBe(13);
    expect(latencyBody.pull.p90).toBe(23);
    expect(latencyBody.pull.p99).toBe(33);
  });

  it('merges timeline globally and supports instance filters', async () => {
    const { app, downstreamCalls } = createMockGatewayApp({
      instances: instanceData,
    });

    const response = await app.request(
      'http://localhost/console/timeline?offset=0&limit=2',
      {
        headers: { Authorization: `Bearer ${CONSOLE_TOKEN}` },
      }
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: Array<{
        instanceId: string;
        timestamp: string;
        federatedTimelineId: string;
      }>;
      total: number;
      partial: boolean;
    };

    expect(body.total).toBe(3);
    expect(body.partial).toBe(false);
    expect(body.items.map((item) => item.instanceId)).toEqual([
      'beta',
      'alpha',
    ]);
    expect(body.items[0]?.federatedTimelineId).toBe('beta:event:2001');
    expect(body.items[1]?.federatedTimelineId).toBe('alpha:commit:40');

    const filtered = await app.request(
      'http://localhost/console/timeline?instanceId=alpha&offset=0&limit=10',
      {
        headers: { Authorization: `Bearer ${CONSOLE_TOKEN}` },
      }
    );
    expect(filtered.status).toBe(200);
    const filteredBody = (await filtered.json()) as {
      items: Array<{ instanceId: string }>;
      total: number;
    };
    expect(
      filteredBody.items.every((item) => item.instanceId === 'alpha')
    ).toBe(true);
    expect(filteredBody.total).toBe(2);

    expect(
      downstreamCalls.some((url) => url.includes('alpha.example.test'))
    ).toBe(true);
    expect(
      downstreamCalls.some((url) => url.includes('beta.example.test'))
    ).toBe(true);
  });

  it('returns 502 when all selected instances fail', async () => {
    const { app } = createMockGatewayApp({
      instances: instanceData,
      failingInstances: new Set(['alpha', 'beta']),
    });

    const response = await app.request('http://localhost/console/stats', {
      headers: { Authorization: `Bearer ${CONSOLE_TOKEN}` },
    });
    expect(response.status).toBe(502);
    const body = (await response.json()) as {
      error: string;
      failedInstances: Array<{ instanceId: string; reason: string }>;
    };
    expect(body.error).toBe('DOWNSTREAM_UNAVAILABLE');
    expect(body.failedInstances).toEqual([
      { instanceId: 'alpha', reason: 'HTTP 503', status: 503 },
      { instanceId: 'beta', reason: 'HTTP 503', status: 503 },
    ]);
  });

  it('merges commits and clients with federated ids', async () => {
    const { app } = createMockGatewayApp({ instances: instanceData });

    const commitsResponse = await app.request(
      'http://localhost/console/commits?offset=0&limit=10',
      {
        headers: { Authorization: `Bearer ${CONSOLE_TOKEN}` },
      }
    );
    expect(commitsResponse.status).toBe(200);
    const commitsBody = (await commitsResponse.json()) as {
      items: Array<{ federatedCommitId: string; instanceId: string }>;
      total: number;
    };
    expect(commitsBody.total).toBe(3);
    expect(commitsBody.items[0]?.federatedCommitId).toBe('beta:18');
    expect(commitsBody.items[1]?.federatedCommitId).toBe('alpha:40');

    const clientsResponse = await app.request(
      'http://localhost/console/clients?offset=0&limit=10',
      {
        headers: { Authorization: `Bearer ${CONSOLE_TOKEN}` },
      }
    );
    expect(clientsResponse.status).toBe(200);
    const clientsBody = (await clientsResponse.json()) as {
      items: Array<{ federatedClientId: string; instanceId: string }>;
      total: number;
    };
    expect(clientsBody.total).toBe(2);
    expect(clientsBody.items[0]?.federatedClientId).toBe('alpha:client-shared');
    expect(clientsBody.items[1]?.federatedClientId).toBe('beta:client-shared');
  });

  it('resolves commit detail by federated id and local id with instance filter', async () => {
    const { app } = createMockGatewayApp({ instances: instanceData });

    const federatedResponse = await app.request(
      'http://localhost/console/commits/alpha:40',
      {
        headers: { Authorization: `Bearer ${CONSOLE_TOKEN}` },
      }
    );
    expect(federatedResponse.status).toBe(200);
    const federatedBody = (await federatedResponse.json()) as {
      instanceId: string;
      localCommitSeq: number;
      federatedCommitId: string;
      commitSeq: number;
    };
    expect(federatedBody.instanceId).toBe('alpha');
    expect(federatedBody.localCommitSeq).toBe(40);
    expect(federatedBody.federatedCommitId).toBe('alpha:40');
    expect(federatedBody.commitSeq).toBe(40);

    const localResponse = await app.request(
      'http://localhost/console/commits/40?instanceId=alpha',
      {
        headers: { Authorization: `Bearer ${CONSOLE_TOKEN}` },
      }
    );
    expect(localResponse.status).toBe(200);

    const ambiguousResponse = await app.request(
      'http://localhost/console/commits/40',
      {
        headers: { Authorization: `Bearer ${CONSOLE_TOKEN}` },
      }
    );
    expect(ambiguousResponse.status).toBe(400);
  });

  it('merges operations and events with federated ids', async () => {
    const { app } = createMockGatewayApp({ instances: instanceData });

    const operationsResponse = await app.request(
      'http://localhost/console/operations?offset=0&limit=10',
      {
        headers: { Authorization: `Bearer ${CONSOLE_TOKEN}` },
      }
    );
    expect(operationsResponse.status).toBe(200);
    const operationsBody = (await operationsResponse.json()) as {
      items: Array<{ federatedOperationId: string; instanceId: string }>;
      total: number;
      partial: boolean;
    };
    expect(operationsBody.total).toBe(2);
    expect(operationsBody.partial).toBe(false);
    expect(operationsBody.items[0]?.federatedOperationId).toBe('alpha:101');
    expect(operationsBody.items[1]?.federatedOperationId).toBe('beta:201');

    const eventsResponse = await app.request(
      'http://localhost/console/events?offset=0&limit=10',
      {
        headers: { Authorization: `Bearer ${CONSOLE_TOKEN}` },
      }
    );
    expect(eventsResponse.status).toBe(200);
    const eventsBody = (await eventsResponse.json()) as {
      items: Array<{ federatedEventId: string; instanceId: string }>;
      total: number;
      partial: boolean;
    };
    expect(eventsBody.total).toBe(2);
    expect(eventsBody.partial).toBe(false);
    expect(eventsBody.items[0]?.federatedEventId).toBe('beta:2001');
    expect(eventsBody.items[1]?.federatedEventId).toBe('alpha:1001');
  });

  it('resolves event detail and payload by federated id', async () => {
    const { app } = createMockGatewayApp({ instances: instanceData });

    const eventResponse = await app.request(
      'http://localhost/console/events/alpha:1001',
      {
        headers: { Authorization: `Bearer ${CONSOLE_TOKEN}` },
      }
    );
    expect(eventResponse.status).toBe(200);
    const eventBody = (await eventResponse.json()) as {
      instanceId: string;
      localEventId: number;
      federatedEventId: string;
      eventId: number;
      payloadRef: string | null;
    };
    expect(eventBody.instanceId).toBe('alpha');
    expect(eventBody.localEventId).toBe(1001);
    expect(eventBody.federatedEventId).toBe('alpha:1001');
    expect(eventBody.eventId).toBe(1001);
    expect(eventBody.payloadRef).toBe('payload-alpha-1001');

    const payloadResponse = await app.request(
      'http://localhost/console/events/alpha:1001/payload',
      {
        headers: { Authorization: `Bearer ${CONSOLE_TOKEN}` },
      }
    );
    expect(payloadResponse.status).toBe(200);
    const payloadBody = (await payloadResponse.json()) as {
      instanceId: string;
      localEventId: number;
      federatedEventId: string;
      payloadRef: string;
      partitionId: string;
    };
    expect(payloadBody.instanceId).toBe('alpha');
    expect(payloadBody.localEventId).toBe(1001);
    expect(payloadBody.federatedEventId).toBe('alpha:1001');
    expect(payloadBody.payloadRef).toBe('payload-alpha-1001');
    expect(payloadBody.partitionId).toBe('tenant-a');
  });

  it('validates federated event id and instance', async () => {
    const { app } = createMockGatewayApp({ instances: instanceData });

    const invalidFormat = await app.request(
      'http://localhost/console/events/not-a-federated-id',
      {
        headers: { Authorization: `Bearer ${CONSOLE_TOKEN}` },
      }
    );
    expect(invalidFormat.status).toBe(400);

    const missingInstance = await app.request(
      'http://localhost/console/events/unknown:1001',
      {
        headers: { Authorization: `Bearer ${CONSOLE_TOKEN}` },
      }
    );
    expect(missingInstance.status).toBe(404);

    const ambiguousLocalId = await app.request(
      'http://localhost/console/events/1001',
      {
        headers: { Authorization: `Bearer ${CONSOLE_TOKEN}` },
      }
    );
    expect(ambiguousLocalId.status).toBe(400);

    const resolvedLocalId = await app.request(
      'http://localhost/console/events/1001?instanceId=alpha',
      {
        headers: { Authorization: `Bearer ${CONSOLE_TOKEN}` },
      }
    );
    expect(resolvedLocalId.status).toBe(200);
  });

  it('requires explicit single instance for non-federated gateway endpoints', async () => {
    const { app } = createMockGatewayApp({ instances: instanceData });

    const pruneWithoutInstance = await app.request(
      'http://localhost/console/prune',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${CONSOLE_TOKEN}` },
      }
    );
    expect(pruneWithoutInstance.status).toBe(400);
    const pruneBody = (await pruneWithoutInstance.json()) as {
      error: string;
      message: string;
    };
    expect(pruneBody.error).toBe('INSTANCE_REQUIRED');

    const handlersWithoutInstance = await app.request(
      'http://localhost/console/handlers',
      {
        headers: { Authorization: `Bearer ${CONSOLE_TOKEN}` },
      }
    );
    expect(handlersWithoutInstance.status).toBe(400);
    const handlersBody = (await handlersWithoutInstance.json()) as {
      error: string;
    };
    expect(handlersBody.error).toBe('INSTANCE_REQUIRED');
  });

  it('proxies single-instance mutation and config endpoints', async () => {
    const { app } = createMockGatewayApp({ instances: instanceData });

    const handlersResponse = await app.request(
      'http://localhost/console/handlers?instanceId=alpha',
      {
        headers: { Authorization: `Bearer ${CONSOLE_TOKEN}` },
      }
    );
    expect(handlersResponse.status).toBe(200);
    const handlersBody = (await handlersResponse.json()) as {
      items: ConsoleHandler[];
    };
    expect(handlersBody.items[0]?.table).toBe('tasks');

    const pruneResponse = await app.request(
      'http://localhost/console/prune?instanceId=alpha',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${CONSOLE_TOKEN}` },
      }
    );
    expect(pruneResponse.status).toBe(200);
    const pruneBody = (await pruneResponse.json()) as {
      deletedCommits: number;
    };
    expect(pruneBody.deletedCommits).toBe(alphaCommits.length);

    const notifyResponse = await app.request(
      'http://localhost/console/notify-data-change?instanceId=alpha',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${CONSOLE_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ tables: ['tasks'], partitionId: 'tenant-a' }),
      }
    );
    expect(notifyResponse.status).toBe(200);
    const notifyBody = (await notifyResponse.json()) as {
      commitSeq: number;
      tables: string[];
      deletedChunks: number;
    };
    expect(notifyBody.tables).toEqual(['tasks']);
    expect(notifyBody.deletedChunks).toBe(0);

    const clearEventsResponse = await app.request(
      'http://localhost/console/events?instanceId=alpha',
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${CONSOLE_TOKEN}` },
      }
    );
    expect(clearEventsResponse.status).toBe(200);
    const clearEventsBody = (await clearEventsResponse.json()) as {
      deletedCount: number;
    };
    expect(clearEventsBody.deletedCount).toBe(alphaEvents.length);

    const apiKeysResponse = await app.request(
      'http://localhost/console/api-keys?instanceId=alpha&offset=0&limit=10',
      {
        headers: { Authorization: `Bearer ${CONSOLE_TOKEN}` },
      }
    );
    expect(apiKeysResponse.status).toBe(200);
    const apiKeysBody = (await apiKeysResponse.json()) as {
      total: number;
      items: ConsoleApiKey[];
    };
    expect(apiKeysBody.total).toBe(alphaApiKeys.length);
    expect(apiKeysBody.items[0]?.keyId).toBe('alpha-key-1');

    const createApiKeyResponse = await app.request(
      'http://localhost/console/api-keys?instanceId=alpha',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${CONSOLE_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Created key',
          keyType: 'admin',
          scopeKeys: ['*'],
        }),
      }
    );
    expect(createApiKeyResponse.status).toBe(201);
    const createApiKeyBody = (await createApiKeyResponse.json()) as {
      key: ConsoleApiKey;
      secretKey: string;
    };
    expect(createApiKeyBody.key.keyId).toBe('alpha-new-key');
    expect(createApiKeyBody.secretKey).toBe('alpha_secret_key');
  });
});
