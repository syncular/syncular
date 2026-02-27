import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createDatabase } from '@syncular/core';
import { createPgliteDialect } from '@syncular/dialect-pglite';
import { ensureSyncSchema, type SyncCoreDb } from '@syncular/server';
import { createPostgresServerDialect } from '@syncular/server-dialect-postgres';
import { Hono } from 'hono';
import type { Generated, Kysely } from 'kysely';
import {
  type CreateConsoleRoutesOptions,
  createConsoleRoutes,
} from '../console';

interface SyncRequestEventsTable {
  event_id: Generated<number>;
  partition_id: string;
  request_id: string | null;
  trace_id: string | null;
  span_id: string | null;
  event_type: 'push' | 'pull';
  sync_path: 'http-combined' | 'ws-push';
  actor_id: string;
  client_id: string;
  transport_path: 'direct' | 'relay';
  status_code: number;
  outcome: string;
  response_status: string;
  error_code: string | null;
  duration_ms: number;
  commit_seq: number | null;
  operation_count: number | null;
  row_count: number | null;
  subscription_count: number | null;
  scopes_summary: unknown | null;
  tables: string[];
  error_message: string | null;
  payload_ref: string | null;
  created_at: Generated<string>;
}

interface SyncRequestPayloadsTable {
  payload_ref: string;
  partition_id: string;
  request_payload: unknown;
  response_payload: unknown | null;
  created_at: Generated<string>;
}

interface SyncOperationEventsTable {
  operation_id: Generated<number>;
  operation_type: string;
  console_user_id: string | null;
  partition_id: string | null;
  target_client_id: string | null;
  request_payload: unknown | null;
  result_payload: unknown | null;
  created_at: Generated<string>;
}

interface SyncApiKeysTable {
  key_id: string;
  key_hash: string;
  key_prefix: string;
  name: string;
  key_type: 'relay' | 'proxy' | 'admin';
  scope_keys: unknown | null;
  actor_id: string | null;
  created_at: Generated<string>;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
}

interface TestDb extends SyncCoreDb {
  sync_request_events: SyncRequestEventsTable;
  sync_request_payloads: SyncRequestPayloadsTable;
  sync_operation_events: SyncOperationEventsTable;
  sync_api_keys: SyncApiKeysTable;
}

type TimelineResponse = {
  items: Array<{
    type: 'commit' | 'event';
    timestamp: string;
    commit: {
      commitSeq: number;
      actorId: string;
      clientId: string;
      affectedTables: string[];
    } | null;
    event: {
      eventId: number;
      actorId: string;
      clientId: string;
      eventType: 'push' | 'pull';
      outcome: string;
      tables: string[];
    } | null;
  }>;
  total: number;
  offset: number;
  limit: number;
};

type OperationsResponse = {
  items: Array<{
    operationId: number;
    operationType: 'prune' | 'compact' | 'notify_data_change' | 'evict_client';
    consoleUserId: string | null;
    partitionId: string | null;
    targetClientId: string | null;
    requestPayload: unknown;
    resultPayload: unknown;
    createdAt: string;
  }>;
  total: number;
  offset: number;
  limit: number;
};

type ApiKeysResponse = {
  items: Array<{
    keyId: string;
    keyPrefix: string;
    name: string;
    keyType: 'relay' | 'proxy' | 'admin';
    scopeKeys: string[];
    actorId: string | null;
    createdAt: string;
    expiresAt: string | null;
    lastUsedAt: string | null;
    revokedAt: string | null;
  }>;
  total: number;
  offset: number;
  limit: number;
};

function timelineItemKey(item: TimelineResponse['items'][number]): string {
  if (item.type === 'commit') {
    return `C${item.commit?.commitSeq ?? 'unknown'}`;
  }
  return `E${item.event?.eventId ?? 'unknown'}`;
}

const CONSOLE_TOKEN = 'console-test-token';

describe('console timeline route filters', () => {
  let db: Kysely<TestDb>;
  let dialect: ReturnType<typeof createPostgresServerDialect>;
  let app: Hono;
  let baseTimeMs: number;

  function atIso(minutes: number): string {
    return new Date(baseTimeMs + minutes * 60_000).toISOString();
  }

  async function requestTimeline(args: {
    query?: Record<string, string | number | undefined>;
    authenticated?: boolean;
  }): Promise<Response> {
    const params = new URLSearchParams({ limit: '50', offset: '0' });
    for (const [key, value] of Object.entries(args.query ?? {})) {
      if (value === undefined) continue;
      params.set(key, String(value));
    }

    return app.request(
      `http://localhost/console/timeline?${params.toString()}`,
      {
        headers:
          args.authenticated === false
            ? undefined
            : { Authorization: `Bearer ${CONSOLE_TOKEN}` },
      }
    );
  }

  async function readTimeline(
    query: Record<string, string | number | undefined> = {}
  ): Promise<TimelineResponse> {
    const response = await requestTimeline({ query });
    expect(response.status).toBe(200);
    return (await response.json()) as TimelineResponse;
  }

  async function requestEventPayload(
    eventId: number,
    query: Record<string, string | number | undefined> = {}
  ): Promise<Response> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      params.set(key, String(value));
    }
    const queryString = params.toString();

    return app.request(
      `http://localhost/console/events/${eventId}/payload${queryString ? `?${queryString}` : ''}`,
      {
        headers: { Authorization: `Bearer ${CONSOLE_TOKEN}` },
      }
    );
  }

  async function requestNotifyDataChange(body: {
    tables: string[];
    partitionId?: string;
  }): Promise<Response> {
    return app.request('http://localhost/console/notify-data-change', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${CONSOLE_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  }

  async function readOperations(
    query: Record<string, string | number | undefined> = {}
  ): Promise<OperationsResponse> {
    const params = new URLSearchParams({ limit: '50', offset: '0' });
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      params.set(key, String(value));
    }

    const response = await app.request(
      `http://localhost/console/operations?${params.toString()}`,
      {
        headers: { Authorization: `Bearer ${CONSOLE_TOKEN}` },
      }
    );
    expect(response.status).toBe(200);
    return (await response.json()) as OperationsResponse;
  }

  async function requestCommits(
    query: Record<string, string | number | undefined> = {}
  ): Promise<Response> {
    const params = new URLSearchParams({ limit: '50', offset: '0' });
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      params.set(key, String(value));
    }

    return app.request(
      `http://localhost/console/commits?${params.toString()}`,
      {
        headers: { Authorization: `Bearer ${CONSOLE_TOKEN}` },
      }
    );
  }

  async function requestClients(
    query: Record<string, string | number | undefined> = {}
  ): Promise<Response> {
    const params = new URLSearchParams({ limit: '50', offset: '0' });
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      params.set(key, String(value));
    }

    return app.request(
      `http://localhost/console/clients?${params.toString()}`,
      {
        headers: { Authorization: `Bearer ${CONSOLE_TOKEN}` },
      }
    );
  }

  async function requestEvents(
    args: {
      query?: Record<string, string | number | undefined>;
      targetApp?: Hono;
    } = {}
  ): Promise<Response> {
    const params = new URLSearchParams({ limit: '50', offset: '0' });
    for (const [key, value] of Object.entries(args.query ?? {})) {
      if (value === undefined) continue;
      params.set(key, String(value));
    }

    return (args.targetApp ?? app).request(
      `http://localhost/console/events?${params.toString()}`,
      {
        headers: { Authorization: `Bearer ${CONSOLE_TOKEN}` },
      }
    );
  }

  async function requestClearEvents(): Promise<Response> {
    return app.request('http://localhost/console/events', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${CONSOLE_TOKEN}` },
    });
  }

  async function requestPruneEvents(targetApp: Hono = app): Promise<Response> {
    return targetApp.request('http://localhost/console/events/prune', {
      method: 'POST',
      headers: { Authorization: `Bearer ${CONSOLE_TOKEN}` },
    });
  }

  async function requestApiKeys(
    query: Record<string, string | number | undefined> = {}
  ): Promise<Response> {
    const params = new URLSearchParams({ limit: '50', offset: '0' });
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      params.set(key, String(value));
    }

    return app.request(
      `http://localhost/console/api-keys?${params.toString()}`,
      {
        headers: { Authorization: `Bearer ${CONSOLE_TOKEN}` },
      }
    );
  }

  async function readApiKeys(
    query: Record<string, string | number | undefined> = {}
  ): Promise<ApiKeysResponse> {
    const response = await requestApiKeys(query);
    expect(response.status).toBe(200);
    return (await response.json()) as ApiKeysResponse;
  }

  async function requestBulkRevokeApiKeys(keyIds: string[]): Promise<Response> {
    return app.request('http://localhost/console/api-keys/bulk-revoke', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${CONSOLE_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ keyIds }),
    });
  }

  async function requestStageRotateApiKey(keyId: string): Promise<Response> {
    return app.request(
      `http://localhost/console/api-keys/${keyId}/rotate/stage`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${CONSOLE_TOKEN}`,
        },
      }
    );
  }

  async function requestCommitDetail(
    seq: number,
    query: Record<string, string | number | undefined> = {}
  ): Promise<Response> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      params.set(key, String(value));
    }
    const queryString = params.toString();

    return app.request(
      `http://localhost/console/commits/${seq}${queryString ? `?${queryString}` : ''}`,
      {
        headers: { Authorization: `Bearer ${CONSOLE_TOKEN}` },
      }
    );
  }

  async function requestEventDetail(
    eventId: number,
    query: Record<string, string | number | undefined> = {}
  ): Promise<Response> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      params.set(key, String(value));
    }
    const queryString = params.toString();

    return app.request(
      `http://localhost/console/events/${eventId}${queryString ? `?${queryString}` : ''}`,
      {
        headers: { Authorization: `Bearer ${CONSOLE_TOKEN}` },
      }
    );
  }

  async function requestEvictClient(
    clientId: string,
    query: Record<string, string | number | undefined> = {}
  ): Promise<Response> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      params.set(key, String(value));
    }
    const queryString = params.toString();

    return app.request(
      `http://localhost/console/clients/${clientId}${queryString ? `?${queryString}` : ''}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${CONSOLE_TOKEN}` },
      }
    );
  }

  async function requestTimeseriesStats(args: {
    query?: Record<string, string | number | undefined>;
    targetApp?: Hono;
  }): Promise<Response> {
    const params = new URLSearchParams({ interval: 'hour', range: '24h' });
    for (const [key, value] of Object.entries(args.query ?? {})) {
      if (value === undefined) continue;
      params.set(key, String(value));
    }

    return (args.targetApp ?? app).request(
      `http://localhost/console/stats/timeseries?${params.toString()}`,
      {
        headers: { Authorization: `Bearer ${CONSOLE_TOKEN}` },
      }
    );
  }

  async function requestLatencyStats(args: {
    query?: Record<string, string | number | undefined>;
    targetApp?: Hono;
  }): Promise<Response> {
    const params = new URLSearchParams({ range: '24h' });
    for (const [key, value] of Object.entries(args.query ?? {})) {
      if (value === undefined) continue;
      params.set(key, String(value));
    }

    return (args.targetApp ?? app).request(
      `http://localhost/console/stats/latency?${params.toString()}`,
      {
        headers: { Authorization: `Bearer ${CONSOLE_TOKEN}` },
      }
    );
  }

  function createTestApp(
    overrides: Partial<
      Pick<CreateConsoleRoutesOptions<TestDb>, 'metrics' | 'maintenance'>
    > = {}
  ): Hono {
    const routes = createConsoleRoutes({
      db,
      dialect,
      handlers: [],
      authenticate: async (c) =>
        c.req.header('Authorization') === `Bearer ${CONSOLE_TOKEN}`
          ? { consoleUserId: 'console-test' }
          : null,
      corsOrigins: '*',
      ...overrides,
    });
    const nextApp = new Hono();
    nextApp.route('/console', routes);
    return nextApp;
  }

  async function waitForCondition(
    evaluate: () => Promise<boolean>
  ): Promise<void> {
    for (let attempt = 0; attempt < 40; attempt++) {
      if (await evaluate()) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('Condition was not met within timeout.');
  }

  beforeEach(async () => {
    // Keep fixture events within the current metrics windows (for example 24h).
    baseTimeMs =
      Math.floor(Date.now() / (60 * 60 * 1000)) * (60 * 60 * 1000) -
      60 * 60 * 1000;

    dialect = createPostgresServerDialect();
    db = createDatabase<TestDb>({
      dialect: createPgliteDialect(),
      family: 'postgres',
    });
    await ensureSyncSchema(db, dialect);
    await dialect.ensureConsoleSchema?.(db);

    await db
      .insertInto('sync_commits')
      .values([
        {
          partition_id: 'default',
          actor_id: 'actor-a',
          client_id: 'client-a',
          client_commit_id: 'commit-a',
          created_at: atIso(10),
          meta: null,
          result_json: null,
          change_count: 2,
          affected_tables: ['tasks'],
        },
        {
          partition_id: 'default',
          actor_id: 'actor-b',
          client_id: 'client-b',
          client_commit_id: 'commit-b',
          created_at: atIso(20),
          meta: null,
          result_json: null,
          change_count: 1,
          affected_tables: ['notes'],
        },
      ])
      .execute();

    const commitRows = await db
      .selectFrom('sync_commits')
      .select(['commit_seq', 'client_commit_id'])
      .execute();

    const commitSeqByClientCommitId = new Map(
      commitRows.map((row) => [row.client_commit_id, Number(row.commit_seq)])
    );

    await db
      .insertInto('sync_request_events')
      .values([
        {
          partition_id: 'default',
          request_id: 'req-1',
          trace_id: 'trace-1',
          span_id: 'span-1',
          event_type: 'push',
          sync_path: 'http-combined',
          actor_id: 'actor-a',
          client_id: 'client-a',
          transport_path: 'direct',
          status_code: 200,
          outcome: 'applied',
          response_status: 'success',
          error_code: null,
          duration_ms: 18,
          commit_seq: commitSeqByClientCommitId.get('commit-a') ?? null,
          operation_count: 2,
          row_count: 2,
          subscription_count: null,
          scopes_summary: null,
          tables: ['tasks'],
          error_message: null,
          payload_ref: 'payload-1',
          created_at: atIso(30),
        },
        {
          partition_id: 'default',
          request_id: 'req-2',
          trace_id: 'trace-2',
          span_id: 'span-2',
          event_type: 'pull',
          sync_path: 'http-combined',
          actor_id: 'actor-c',
          client_id: 'client-c',
          transport_path: 'direct',
          status_code: 500,
          outcome: 'error',
          response_status: 'server_error',
          error_code: 'INTERNAL_SERVER_ERROR',
          duration_ms: 44,
          commit_seq: null,
          operation_count: null,
          row_count: null,
          subscription_count: 2,
          scopes_summary: JSON.stringify({ org_id: 'org-1' }),
          tables: ['notes'],
          error_message: 'pull failed',
          payload_ref: null,
          created_at: atIso(40),
        },
        {
          partition_id: 'default',
          request_id: 'req-3',
          trace_id: null,
          span_id: null,
          event_type: 'pull',
          sync_path: 'http-combined',
          actor_id: 'actor-a',
          client_id: 'client-d',
          transport_path: 'relay',
          status_code: 409,
          outcome: 'rejected',
          response_status: 'client_error',
          error_code: 'CONFLICT',
          duration_ms: 22,
          commit_seq: null,
          operation_count: 1,
          row_count: 1,
          subscription_count: 1,
          scopes_summary: JSON.stringify({ org_id: ['org-1', 'org-2'] }),
          tables: ['tasks', 'notes'],
          error_message: null,
          payload_ref: null,
          created_at: atIso(50),
        },
      ])
      .execute();

    await db
      .insertInto('sync_request_payloads')
      .values({
        payload_ref: 'payload-1',
        partition_id: 'default',
        request_payload: JSON.stringify({
          clientCommitId: 'commit-a',
          operations: [{ table: 'tasks', op: 'upsert' }],
        }),
        response_payload: JSON.stringify({
          status: 'applied',
          commitSeq: commitSeqByClientCommitId.get('commit-a') ?? null,
        }),
        created_at: atIso(31),
      })
      .execute();

    await db
      .insertInto('sync_operation_events')
      .values([
        {
          operation_type: 'prune',
          console_user_id: 'console-test',
          partition_id: null,
          target_client_id: null,
          request_payload: JSON.stringify({ watermarkCommitSeq: 2 }),
          result_payload: JSON.stringify({ deletedCommits: 1 }),
          created_at: atIso(32),
        },
        {
          operation_type: 'evict_client',
          console_user_id: 'console-test',
          partition_id: null,
          target_client_id: 'client-d',
          request_payload: JSON.stringify({ clientId: 'client-d' }),
          result_payload: JSON.stringify({ evicted: true }),
          created_at: atIso(52),
        },
      ])
      .execute();

    app = createTestApp();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('filters by actor, client, and table across merged timeline rows', async () => {
    const actorFiltered = await readTimeline({ actorId: 'actor-a' });
    expect(actorFiltered.total).toBe(3);
    expect(
      actorFiltered.items.every(
        (item) =>
          item.commit?.actorId === 'actor-a' ||
          item.event?.actorId === 'actor-a'
      )
    ).toBe(true);

    const clientFiltered = await readTimeline({ clientId: 'client-d' });
    expect(clientFiltered.total).toBe(1);
    expect(clientFiltered.items[0]?.event?.clientId).toBe('client-d');

    const tableFiltered = await readTimeline({ table: 'tasks' });
    expect(tableFiltered.total).toBe(3);
    expect(
      tableFiltered.items.every((item) =>
        item.type === 'commit'
          ? (item.commit?.affectedTables ?? []).includes('tasks')
          : (item.event?.tables ?? []).includes('tasks')
      )
    ).toBe(true);
  });

  it('applies outcome and event-type filters to event rows in all-view mode', async () => {
    const outcomeFiltered = await readTimeline({ outcome: 'error' });
    expect(outcomeFiltered.total).toBe(1);
    expect(outcomeFiltered.items[0]?.type).toBe('event');
    expect(outcomeFiltered.items[0]?.event?.outcome).toBe('error');

    const eventTypeFiltered = await readTimeline({ eventType: 'push' });
    expect(eventTypeFiltered.total).toBe(1);
    expect(eventTypeFiltered.items[0]?.type).toBe('event');
    expect(eventTypeFiltered.items[0]?.event?.eventType).toBe('push');
  });

  it('applies request-id and trace-id filters to event rows', async () => {
    const requestIdFiltered = await readTimeline({ requestId: 'req-2' });
    expect(requestIdFiltered.total).toBe(1);
    expect(requestIdFiltered.items[0]?.type).toBe('event');
    expect(requestIdFiltered.items[0]?.event?.eventId).toBeDefined();

    const traceIdFiltered = await readTimeline({ traceId: 'trace-1' });
    expect(traceIdFiltered.total).toBe(1);
    expect(traceIdFiltered.items[0]?.type).toBe('event');
    expect(traceIdFiltered.items[0]?.event?.eventType).toBe('push');
  });

  it('applies time-window and search filtering', async () => {
    const fromFiltered = await readTimeline({ from: atIso(35) });
    expect(fromFiltered.total).toBe(2);
    expect(fromFiltered.items[0]?.timestamp >= atIso(35)).toBe(true);
    expect(fromFiltered.items[1]?.timestamp >= atIso(35)).toBe(true);

    const searchFiltered = await readTimeline({ search: 'client-d' });
    expect(searchFiltered.total).toBe(1);
    expect(searchFiltered.items[0]?.event?.clientId).toBe('client-d');
  });

  it('returns deterministic pagination slices for merged timeline rows', async () => {
    const pageOne = await readTimeline({ limit: 2, offset: 0 });
    const pageTwo = await readTimeline({ limit: 2, offset: 2 });

    expect(pageOne.total).toBe(5);
    expect(pageTwo.total).toBe(5);
    expect(pageOne.items.length).toBe(2);
    expect(pageTwo.items.length).toBe(2);

    const pageOneKeys = pageOne.items.map(timelineItemKey);
    const pageTwoKeys = pageTwo.items.map(timelineItemKey);

    expect(pageOneKeys[0]).not.toBe(pageTwoKeys[0]);
    expect(pageOneKeys.some((key) => pageTwoKeys.includes(key))).toBe(false);
  });

  it('lists operation audit events and filters by operation type', async () => {
    const allOps = await readOperations();
    expect(allOps.total).toBe(2);
    expect(allOps.items[0]?.operationType).toBe('evict_client');
    expect(allOps.items[1]?.operationType).toBe('prune');

    const pruneOps = await readOperations({ operationType: 'prune' });
    expect(pruneOps.total).toBe(1);
    expect(pruneOps.items[0]?.operationType).toBe('prune');
    expect(pruneOps.items[0]?.consoleUserId).toBe('console-test');
  });

  it('supports notify-data-change and records an operation audit event', async () => {
    const response = await requestNotifyDataChange({
      tables: ['tasks', 'notes'],
      partitionId: 'default',
    });

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      commitSeq: number;
      tables: string[];
      deletedChunks: number;
    };

    expect(payload.commitSeq).toBeGreaterThan(0);
    expect(payload.tables).toEqual(['tasks', 'notes']);
    expect(payload.deletedChunks).toBeGreaterThanOrEqual(0);

    const notifyOps = await readOperations({
      operationType: 'notify_data_change',
    });
    expect(notifyOps.total).toBe(1);
    expect(notifyOps.items[0]?.consoleUserId).toBe('console-test');
    expect(notifyOps.items[0]?.requestPayload).toEqual({
      tables: ['tasks', 'notes'],
      partitionId: 'default',
    });
    expect(notifyOps.items[0]?.resultPayload).toEqual(payload);
  });

  it('returns stats from aggregated metrics mode with partition filtering', async () => {
    const aggregatedApp = createTestApp({
      metrics: {
        aggregationMode: 'aggregated',
      },
    });

    const timeseriesResponse = await requestTimeseriesStats({
      query: { partitionId: 'default' },
      targetApp: aggregatedApp,
    });
    expect(timeseriesResponse.status).toBe(200);
    const timeseriesPayload = (await timeseriesResponse.json()) as {
      buckets: Array<{
        pushCount: number;
        pullCount: number;
        errorCount: number;
      }>;
    };

    const totals = timeseriesPayload.buckets.reduce(
      (acc, bucket) => ({
        pushCount: acc.pushCount + bucket.pushCount,
        pullCount: acc.pullCount + bucket.pullCount,
        errorCount: acc.errorCount + bucket.errorCount,
      }),
      { pushCount: 0, pullCount: 0, errorCount: 0 }
    );
    expect(totals.pushCount).toBe(1);
    expect(totals.pullCount).toBe(2);
    expect(totals.errorCount).toBe(1);

    const latencyResponse = await requestLatencyStats({
      query: { partitionId: 'default' },
      targetApp: aggregatedApp,
    });
    expect(latencyResponse.status).toBe(200);
    const latencyPayload = (await latencyResponse.json()) as {
      push: { p50: number; p90: number; p99: number };
      pull: { p50: number; p90: number; p99: number };
    };

    expect(latencyPayload.push.p50).toBe(18);
    expect(latencyPayload.push.p90).toBe(18);
    expect(latencyPayload.push.p99).toBe(18);
    expect(latencyPayload.pull.p50).toBe(22);
    expect(latencyPayload.pull.p90).toBe(44);
    expect(latencyPayload.pull.p99).toBe(44);
  });

  it('applies partition filters across timeline, list, and operation endpoints', async () => {
    await db
      .insertInto('sync_commits')
      .values({
        partition_id: 'tenant-b',
        actor_id: 'actor-z',
        client_id: 'shared-client',
        client_commit_id: 'commit-z',
        created_at: atIso(55),
        meta: null,
        result_json: null,
        change_count: 1,
        affected_tables: ['tasks'],
      })
      .execute();

    const tenantCommitRow = await db
      .selectFrom('sync_commits')
      .select(['commit_seq'])
      .where('partition_id', '=', 'tenant-b')
      .where('client_commit_id', '=', 'commit-z')
      .executeTakeFirst();

    const tenantCommitSeq = Number(tenantCommitRow?.commit_seq);
    expect(Number.isFinite(tenantCommitSeq)).toBe(true);

    await db
      .insertInto('sync_changes')
      .values({
        partition_id: 'tenant-b',
        commit_seq: tenantCommitSeq,
        table: 'tasks',
        row_id: 'row-z',
        op: 'upsert',
        row_json: JSON.stringify({ id: 'row-z', title: 'tenant row' }),
        row_version: 1,
        scopes: JSON.stringify({ org_id: 'tenant-b' }),
      })
      .execute();

    await db
      .insertInto('sync_request_events')
      .values({
        partition_id: 'tenant-b',
        request_id: 'req-z',
        trace_id: 'trace-z',
        span_id: 'span-z',
        event_type: 'push',
        sync_path: 'http-combined',
        actor_id: 'actor-z',
        client_id: 'shared-client',
        transport_path: 'direct',
        status_code: 200,
        outcome: 'applied',
        response_status: 'success',
        error_code: null,
        duration_ms: 12,
        commit_seq: tenantCommitSeq,
        operation_count: 1,
        row_count: 1,
        subscription_count: null,
        scopes_summary: null,
        tables: ['tasks'],
        error_message: null,
        payload_ref: 'payload-z',
        created_at: atIso(56),
      })
      .execute();

    await db
      .insertInto('sync_request_payloads')
      .values({
        payload_ref: 'payload-z',
        partition_id: 'tenant-b',
        request_payload: JSON.stringify({
          clientCommitId: 'commit-z',
          operations: [{ table: 'tasks', op: 'upsert' }],
        }),
        response_payload: JSON.stringify({
          status: 'applied',
          commitSeq: tenantCommitSeq,
        }),
        created_at: atIso(56),
      })
      .execute();

    await db
      .insertInto('sync_client_cursors')
      .values([
        {
          partition_id: 'default',
          client_id: 'shared-client',
          actor_id: 'actor-a',
          cursor: 1,
          effective_scopes: JSON.stringify({ org_id: 'default' }),
          updated_at: atIso(57),
        },
        {
          partition_id: 'tenant-b',
          client_id: 'shared-client',
          actor_id: 'actor-z',
          cursor: tenantCommitSeq,
          effective_scopes: JSON.stringify({ org_id: 'tenant-b' }),
          updated_at: atIso(58),
        },
      ])
      .execute();

    await db
      .insertInto('sync_operation_events')
      .values({
        operation_type: 'notify_data_change',
        console_user_id: 'console-test',
        partition_id: 'tenant-b',
        target_client_id: null,
        request_payload: JSON.stringify({
          tables: ['tasks'],
          partitionId: 'tenant-b',
        }),
        result_payload: JSON.stringify({ commitSeq: tenantCommitSeq }),
        created_at: atIso(59),
      })
      .execute();

    const tenantTimeline = await readTimeline({ partitionId: 'tenant-b' });
    expect(tenantTimeline.total).toBe(2);
    expect(
      tenantTimeline.items.every((item) =>
        item.type === 'commit'
          ? item.commit?.clientId === 'shared-client'
          : item.event?.partitionId === 'tenant-b'
      )
    ).toBe(true);

    const commitsResponse = await requestCommits({ partitionId: 'tenant-b' });
    expect(commitsResponse.status).toBe(200);
    const commitsPayload = (await commitsResponse.json()) as {
      items: Array<{ clientId: string }>;
      total: number;
    };
    expect(commitsPayload.total).toBe(1);
    expect(commitsPayload.items[0]?.clientId).toBe('shared-client');

    const clientsResponse = await requestClients({ partitionId: 'tenant-b' });
    expect(clientsResponse.status).toBe(200);
    const clientsPayload = (await clientsResponse.json()) as {
      items: Array<{ actorId: string }>;
      total: number;
    };
    expect(clientsPayload.total).toBe(1);
    expect(clientsPayload.items[0]?.actorId).toBe('actor-z');

    const eventsResponse = await requestEvents({
      query: { partitionId: 'tenant-b' },
    });
    expect(eventsResponse.status).toBe(200);
    const eventsPayload = (await eventsResponse.json()) as {
      items: Array<{ partitionId: string }>;
      total: number;
    };
    expect(eventsPayload.total).toBe(1);
    expect(eventsPayload.items[0]?.partitionId).toBe('tenant-b');

    const tenantOps = await readOperations({ partitionId: 'tenant-b' });
    expect(tenantOps.total).toBe(1);
    expect(tenantOps.items[0]?.partitionId).toBe('tenant-b');
    expect(tenantOps.items[0]?.operationType).toBe('notify_data_change');
  });

  it('guards detail endpoints and client eviction with partition filters', async () => {
    await db
      .insertInto('sync_commits')
      .values({
        partition_id: 'tenant-b',
        actor_id: 'actor-z',
        client_id: 'shared-client',
        client_commit_id: 'commit-z-detail',
        created_at: atIso(55),
        meta: null,
        result_json: null,
        change_count: 1,
        affected_tables: ['tasks'],
      })
      .execute();

    const tenantCommitRow = await db
      .selectFrom('sync_commits')
      .select(['commit_seq'])
      .where('partition_id', '=', 'tenant-b')
      .where('client_commit_id', '=', 'commit-z-detail')
      .executeTakeFirst();
    const tenantCommitSeq = Number(tenantCommitRow?.commit_seq);
    expect(Number.isFinite(tenantCommitSeq)).toBe(true);

    await db
      .insertInto('sync_changes')
      .values({
        partition_id: 'tenant-b',
        commit_seq: tenantCommitSeq,
        table: 'tasks',
        row_id: 'row-z-detail',
        op: 'upsert',
        row_json: JSON.stringify({ id: 'row-z-detail' }),
        row_version: 1,
        scopes: JSON.stringify({ org_id: 'tenant-b' }),
      })
      .execute();

    await db
      .insertInto('sync_request_events')
      .values({
        partition_id: 'tenant-b',
        request_id: 'req-z-detail',
        trace_id: 'trace-z-detail',
        span_id: 'span-z-detail',
        event_type: 'push',
        sync_path: 'http-combined',
        actor_id: 'actor-z',
        client_id: 'shared-client',
        transport_path: 'direct',
        status_code: 200,
        outcome: 'applied',
        response_status: 'success',
        error_code: null,
        duration_ms: 15,
        commit_seq: tenantCommitSeq,
        operation_count: 1,
        row_count: 1,
        subscription_count: null,
        scopes_summary: null,
        tables: ['tasks'],
        error_message: null,
        payload_ref: 'payload-z-detail',
        created_at: atIso(56),
      })
      .execute();

    await db
      .insertInto('sync_request_payloads')
      .values({
        payload_ref: 'payload-z-detail',
        partition_id: 'tenant-b',
        request_payload: JSON.stringify({ clientCommitId: 'commit-z-detail' }),
        response_payload: JSON.stringify({ status: 'applied' }),
        created_at: atIso(56),
      })
      .execute();

    await db
      .insertInto('sync_client_cursors')
      .values([
        {
          partition_id: 'default',
          client_id: 'shared-client',
          actor_id: 'actor-a',
          cursor: 1,
          effective_scopes: JSON.stringify({ org_id: 'default' }),
          updated_at: atIso(57),
        },
        {
          partition_id: 'tenant-b',
          client_id: 'shared-client',
          actor_id: 'actor-z',
          cursor: tenantCommitSeq,
          effective_scopes: JSON.stringify({ org_id: 'tenant-b' }),
          updated_at: atIso(58),
        },
      ])
      .execute();

    const tenantEventRow = await db
      .selectFrom('sync_request_events')
      .select(['event_id'])
      .where('request_id', '=', 'req-z-detail')
      .executeTakeFirst();
    const tenantEventId = Number(tenantEventRow?.event_id);
    expect(Number.isFinite(tenantEventId)).toBe(true);

    const commitDetailOk = await requestCommitDetail(tenantCommitSeq, {
      partitionId: 'tenant-b',
    });
    expect(commitDetailOk.status).toBe(200);

    const commitDetailWrongPartition = await requestCommitDetail(
      tenantCommitSeq,
      {
        partitionId: 'default',
      }
    );
    expect(commitDetailWrongPartition.status).toBe(404);

    const eventDetailOk = await requestEventDetail(tenantEventId, {
      partitionId: 'tenant-b',
    });
    expect(eventDetailOk.status).toBe(200);

    const eventDetailWrongPartition = await requestEventDetail(tenantEventId, {
      partitionId: 'default',
    });
    expect(eventDetailWrongPartition.status).toBe(404);

    const payloadOk = await requestEventPayload(tenantEventId, {
      partitionId: 'tenant-b',
    });
    expect(payloadOk.status).toBe(200);

    const payloadWrongPartition = await requestEventPayload(tenantEventId, {
      partitionId: 'default',
    });
    expect(payloadWrongPartition.status).toBe(404);

    const evictDefault = await requestEvictClient('shared-client', {
      partitionId: 'default',
    });
    expect(evictDefault.status).toBe(200);
    expect((await evictDefault.json()) as { evicted: boolean }).toEqual({
      evicted: true,
    });

    const tenantCursorAfterDefaultEvict = await db
      .selectFrom('sync_client_cursors')
      .select(['client_id'])
      .where('partition_id', '=', 'tenant-b')
      .where('client_id', '=', 'shared-client')
      .executeTakeFirst();
    expect(tenantCursorAfterDefaultEvict).toBeDefined();

    const evictTenant = await requestEvictClient('shared-client', {
      partitionId: 'tenant-b',
    });
    expect(evictTenant.status).toBe(200);
    expect((await evictTenant.json()) as { evicted: boolean }).toEqual({
      evicted: true,
    });

    const tenantCursorAfterTenantEvict = await db
      .selectFrom('sync_client_cursors')
      .select(['client_id'])
      .where('partition_id', '=', 'tenant-b')
      .where('client_id', '=', 'shared-client')
      .executeTakeFirst();
    expect(tenantCursorAfterTenantEvict).toBeUndefined();
  });

  it('filters API keys by type and lifecycle status', async () => {
    const dayMs = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const isoAfter = (days: number): string =>
      new Date(now + days * dayMs).toISOString();

    await db
      .insertInto('sync_api_keys')
      .values([
        {
          key_id: 'key-relay-active',
          key_hash: 'hash-1',
          key_prefix: 'srly_active_',
          name: 'relay-active',
          key_type: 'relay',
          scope_keys: ['scope-a'],
          actor_id: 'actor-a',
          created_at: atIso(11),
          expires_at: null,
          last_used_at: null,
          revoked_at: null,
        },
        {
          key_id: 'key-relay-expiring',
          key_hash: 'hash-2',
          key_prefix: 'srly_expire_',
          name: 'relay-expiring',
          key_type: 'relay',
          scope_keys: ['scope-a', 'scope-b'],
          actor_id: null,
          created_at: atIso(12),
          expires_at: isoAfter(3),
          last_used_at: null,
          revoked_at: null,
        },
        {
          key_id: 'key-relay-expired',
          key_hash: 'hash-3',
          key_prefix: 'srly_expired',
          name: 'relay-expired',
          key_type: 'relay',
          scope_keys: [],
          actor_id: null,
          created_at: atIso(13),
          expires_at: isoAfter(-1),
          last_used_at: null,
          revoked_at: null,
        },
        {
          key_id: 'key-relay-revoked',
          key_hash: 'hash-4',
          key_prefix: 'srly_revoked',
          name: 'relay-revoked',
          key_type: 'relay',
          scope_keys: [],
          actor_id: null,
          created_at: atIso(14),
          expires_at: isoAfter(10),
          last_used_at: null,
          revoked_at: isoAfter(0),
        },
        {
          key_id: 'key-admin-future',
          key_hash: 'hash-5',
          key_prefix: 'sadm_future_',
          name: 'admin-future',
          key_type: 'admin',
          scope_keys: ['org:1'],
          actor_id: 'actor-admin',
          created_at: atIso(15),
          expires_at: isoAfter(60),
          last_used_at: null,
          revoked_at: null,
        },
      ])
      .execute();

    const relayOnly = await readApiKeys({ type: 'relay' });
    expect(relayOnly.total).toBe(4);
    expect(relayOnly.items.every((item) => item.keyType === 'relay')).toBe(
      true
    );

    const revokedOnly = await readApiKeys({ status: 'revoked' });
    expect(revokedOnly.total).toBe(1);
    expect(revokedOnly.items[0]?.name).toBe('relay-revoked');

    const activeOnly = await readApiKeys({ status: 'active' });
    expect(activeOnly.total).toBe(3);
    expect(activeOnly.items.some((item) => item.name === 'relay-active')).toBe(
      true
    );
    expect(
      activeOnly.items.some((item) => item.name === 'relay-expiring')
    ).toBe(true);
    expect(activeOnly.items.some((item) => item.name === 'admin-future')).toBe(
      true
    );
    expect(activeOnly.items.some((item) => item.name === 'relay-expired')).toBe(
      false
    );
    expect(activeOnly.items.some((item) => item.name === 'relay-revoked')).toBe(
      false
    );

    const expiringDefault = await readApiKeys({ status: 'expiring' });
    expect(expiringDefault.total).toBe(1);
    expect(expiringDefault.items[0]?.name).toBe('relay-expiring');
  });

  it('applies custom expiring-window filters for API keys', async () => {
    const dayMs = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const isoAfter = (days: number): string =>
      new Date(now + days * dayMs).toISOString();

    await db
      .insertInto('sync_api_keys')
      .values([
        {
          key_id: 'key-expiring-3',
          key_hash: 'hash-e3',
          key_prefix: 'srel_exp_03',
          name: 'expiring-3',
          key_type: 'relay',
          scope_keys: [],
          actor_id: null,
          created_at: atIso(16),
          expires_at: isoAfter(3),
          last_used_at: null,
          revoked_at: null,
        },
        {
          key_id: 'key-expiring-10',
          key_hash: 'hash-e10',
          key_prefix: 'srel_exp_10',
          name: 'expiring-10',
          key_type: 'relay',
          scope_keys: [],
          actor_id: null,
          created_at: atIso(17),
          expires_at: isoAfter(10),
          last_used_at: null,
          revoked_at: null,
        },
      ])
      .execute();

    const expiringInSevenDays = await readApiKeys({
      status: 'expiring',
      expiresWithinDays: 7,
    });
    expect(expiringInSevenDays.total).toBe(1);
    expect(expiringInSevenDays.items[0]?.name).toBe('expiring-3');

    const expiringInFourteenDays = await readApiKeys({
      status: 'expiring',
      expiresWithinDays: 14,
    });
    expect(expiringInFourteenDays.total).toBe(2);
    const expiringNames = expiringInFourteenDays.items
      .map((item) => item.name)
      .sort();
    expect(expiringNames).toEqual(['expiring-10', 'expiring-3']);
  });

  it('bulk revokes active keys and reports already-revoked/not-found ids', async () => {
    const nowIso = atIso(18);

    await db
      .insertInto('sync_api_keys')
      .values([
        {
          key_id: 'bulk-active-1',
          key_hash: 'bulk-hash-1',
          key_prefix: 'bulk_active1',
          name: 'bulk-active-1',
          key_type: 'relay',
          scope_keys: [],
          actor_id: null,
          created_at: nowIso,
          expires_at: null,
          last_used_at: null,
          revoked_at: null,
        },
        {
          key_id: 'bulk-active-2',
          key_hash: 'bulk-hash-2',
          key_prefix: 'bulk_active2',
          name: 'bulk-active-2',
          key_type: 'proxy',
          scope_keys: [],
          actor_id: null,
          created_at: nowIso,
          expires_at: null,
          last_used_at: null,
          revoked_at: null,
        },
        {
          key_id: 'bulk-revoked-1',
          key_hash: 'bulk-hash-3',
          key_prefix: 'bulk_revoked',
          name: 'bulk-revoked-1',
          key_type: 'admin',
          scope_keys: [],
          actor_id: null,
          created_at: nowIso,
          expires_at: null,
          last_used_at: null,
          revoked_at: nowIso,
        },
      ])
      .execute();

    const response = await requestBulkRevokeApiKeys([
      'bulk-active-1',
      'bulk-active-2',
      'bulk-revoked-1',
      'bulk-missing-1',
    ]);
    expect(response.status).toBe(200);

    const payload = (await response.json()) as {
      requestedCount: number;
      revokedCount: number;
      alreadyRevokedCount: number;
      notFoundCount: number;
      revokedKeyIds: string[];
      alreadyRevokedKeyIds: string[];
      notFoundKeyIds: string[];
    };

    expect(payload.requestedCount).toBe(4);
    expect(payload.revokedCount).toBe(2);
    expect(payload.alreadyRevokedCount).toBe(1);
    expect(payload.notFoundCount).toBe(1);
    expect(payload.revokedKeyIds.sort()).toEqual([
      'bulk-active-1',
      'bulk-active-2',
    ]);
    expect(payload.alreadyRevokedKeyIds).toEqual(['bulk-revoked-1']);
    expect(payload.notFoundKeyIds).toEqual(['bulk-missing-1']);

    const revokedRows = await db
      .selectFrom('sync_api_keys')
      .select(['key_id', 'revoked_at'])
      .where('key_id', 'in', ['bulk-active-1', 'bulk-active-2'])
      .execute();
    expect(revokedRows.every((row) => row.revoked_at !== null)).toBe(true);
  });

  it('stages key rotation without revoking the original key', async () => {
    const nowIso = atIso(19);

    await db
      .insertInto('sync_api_keys')
      .values({
        key_id: 'stage-old-key',
        key_hash: 'stage-hash-1',
        key_prefix: 'stage_old__',
        name: 'stage-old',
        key_type: 'relay',
        scope_keys: ['scope-x'],
        actor_id: 'actor-stage',
        created_at: nowIso,
        expires_at: null,
        last_used_at: null,
        revoked_at: null,
      })
      .execute();

    const response = await requestStageRotateApiKey('stage-old-key');
    expect(response.status).toBe(200);

    const payload = (await response.json()) as {
      key: {
        keyId: string;
        keyPrefix: string;
        name: string;
        keyType: 'relay' | 'proxy' | 'admin';
        scopeKeys: string[];
        actorId: string | null;
      };
      secretKey: string;
    };

    expect(payload.key.keyId).not.toBe('stage-old-key');
    expect(payload.key.name).toBe('stage-old');
    expect(payload.key.keyType).toBe('relay');
    expect(payload.key.scopeKeys).toEqual(['scope-x']);
    expect(payload.key.actorId).toBe('actor-stage');
    expect(payload.secretKey.startsWith(payload.key.keyPrefix)).toBe(true);

    const oldRow = await db
      .selectFrom('sync_api_keys')
      .select(['revoked_at'])
      .where('key_id', '=', 'stage-old-key')
      .executeTakeFirst();
    expect(oldRow?.revoked_at).toBeNull();

    const newRow = await db
      .selectFrom('sync_api_keys')
      .select(['key_id', 'revoked_at'])
      .where('key_id', '=', payload.key.keyId)
      .executeTakeFirst();
    expect(newRow?.key_id).toBe(payload.key.keyId);
    expect(newRow?.revoked_at).toBeNull();
  });

  it('rejects unauthenticated timeline requests', async () => {
    const response = await requestTimeline({ authenticated: false });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'UNAUTHENTICATED' });
  });

  it('returns payload snapshots for events with payload refs', async () => {
    const row = await db
      .selectFrom('sync_request_events')
      .select(['event_id'])
      .where('request_id', '=', 'req-1')
      .executeTakeFirst();

    expect(row).toBeDefined();
    const eventId = Number(row?.event_id);
    const response = await requestEventPayload(eventId);

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      payloadRef: string;
      partitionId: string;
      requestPayload: { clientCommitId: string };
      responsePayload: { status: string };
    };

    expect(payload.payloadRef).toBe('payload-1');
    expect(payload.partitionId).toBe('default');
    expect(payload.requestPayload.clientCommitId).toBe('commit-a');
    expect(payload.responsePayload.status).toBe('applied');
  });

  it('deletes payload snapshots when clearing events', async () => {
    const response = await requestClearEvents();
    expect(response.status).toBe(200);

    const eventCountRow = await db
      .selectFrom('sync_request_events')
      .select(({ fn }) => fn.countAll().as('total'))
      .executeTakeFirst();
    expect(Number(eventCountRow?.total ?? 0)).toBe(0);

    const payloadCountRow = await db
      .selectFrom('sync_request_payloads')
      .select(({ fn }) => fn.countAll().as('total'))
      .executeTakeFirst();
    expect(Number(payloadCountRow?.total ?? 0)).toBe(0);
  });

  it('prunes orphaned payload snapshots during event pruning', async () => {
    await db
      .insertInto('sync_request_payloads')
      .values({
        payload_ref: 'payload-orphan',
        partition_id: 'default',
        request_payload: JSON.stringify({ orphan: true }),
        response_payload: JSON.stringify({ ok: true }),
        created_at: atIso(33),
      })
      .execute();

    const response = await requestPruneEvents();
    expect(response.status).toBe(200);

    const orphan = await db
      .selectFrom('sync_request_payloads')
      .select(['payload_ref'])
      .where('payload_ref', '=', 'payload-orphan')
      .executeTakeFirst();
    expect(orphan).toBeUndefined();
  });

  it('prunes operation audit events during /events/prune retention', async () => {
    await db
      .insertInto('sync_operation_events')
      .values({
        operation_type: 'compact',
        console_user_id: 'console-old',
        partition_id: null,
        target_client_id: null,
        request_payload: JSON.stringify({ fullHistoryHours: 12 }),
        result_payload: JSON.stringify({ deletedChanges: 22 }),
        created_at: '2000-01-01T00:00:00.000Z',
      })
      .execute();

    const response = await requestPruneEvents();
    expect(response.status).toBe(200);

    const oldOperation = await db
      .selectFrom('sync_operation_events')
      .select(['operation_id'])
      .where('console_user_id', '=', 'console-old')
      .executeTakeFirst();
    expect(oldOperation).toBeUndefined();

    const operationCountRow = await db
      .selectFrom('sync_operation_events')
      .select(({ fn }) => fn.countAll().as('total'))
      .executeTakeFirst();
    expect(Number(operationCountRow?.total ?? 0)).toBe(2);
  });

  it('runs automatic event pruning cadence using maintenance config', async () => {
    const autoPruneApp = createTestApp({
      maintenance: {
        autoPruneIntervalMs: 1,
        requestEventsMaxAgeMs: 0,
        requestEventsMaxRows: 2,
        operationEventsMaxAgeMs: 0,
        operationEventsMaxRows: 1,
      },
    });

    const trigger = await requestEvents({ targetApp: autoPruneApp });
    expect(trigger.status).toBe(200);

    await waitForCondition(async () => {
      const requestCountRow = await db
        .selectFrom('sync_request_events')
        .select(({ fn }) => fn.countAll().as('total'))
        .executeTakeFirst();
      const operationCountRow = await db
        .selectFrom('sync_operation_events')
        .select(({ fn }) => fn.countAll().as('total'))
        .executeTakeFirst();

      const requestCount = Number(requestCountRow?.total ?? 0);
      const operationCount = Number(operationCountRow?.total ?? 0);
      return requestCount === 2 && operationCount === 1;
    });
  });

  it('disables credentialed CORS headers when wildcard origin is configured', async () => {
    const response = await app.request('http://localhost/console/events', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://example.com',
        'Access-Control-Request-Method': 'GET',
      },
    });

    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('Access-Control-Allow-Credentials')).toBeNull();
  });
});
