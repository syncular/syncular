/**
 * Admin HTTP routes: auth-guard enforcement (mount refusal +
 * 401 path), JSON endpoints mirroring the read surface, and a smoke of the
 * static console page. Driven through Hono's in-process fetch dispatch (the
 * same allowance as index.test.ts — no socket).
 */
import { describe, expect, test } from 'bun:test';
import { encodeMessage, encodeSparseRow, type RowColumn } from '@syncular/core';
import {
  createRealtimeHub,
  MemorySegmentStore,
  RingBufferEvents,
  type ServerSchema,
  SqliteServerStorage,
  SSP2_CONTENT_TYPE,
  type SyncServerConfig,
  SyncularAdmin,
  SyncError,
} from '@syncular/server';
import { Window } from 'happy-dom';
import { Hono } from 'hono';
import { createSyncularAdminRoutes } from './admin';
import { ADMIN_CONSOLE_HTML } from './admin-page';
import { createSyncularHono } from './index';

const TEST_LOG_EPOCH = 'test-log-epoch';

const COLUMNS: readonly RowColumn[] = [
  { name: 'id', type: 'string', nullable: false },
  { name: 'project_id', type: 'string', nullable: false },
  { name: 'title', type: 'string', nullable: false },
];

const SCHEMA: ServerSchema = {
  version: 1,
  tables: [
    {
      name: 'tasks',
      columns: COLUMNS,
      primaryKey: 'id',
      scopes: ['project:{project_id}'],
    },
  ],
};

/** A configured server + admin over shared storage, plus a seed helper. */
async function harness(options: { actions?: boolean } = {}) {
  const storage = new SqliteServerStorage();
  const segments = new MemorySegmentStore();
  // Pin the partition log epoch so the seed push lands in one round (§2.1),
  // and so admin requests without `?partition=` resolve the only partition.
  await storage.touchPartition('part-1', 0, TEST_LOG_EPOCH);
  const config: SyncServerConfig = {
    schema: SCHEMA,
    storage,
    segments,
    resolveScopes: () => ({ project_id: ['p1'] }),
    reactionPlanner: ({ operations }) =>
      operations.map((operation) => ({
        key: `task:${operation.rowId}`,
        type: 'email.send',
        version: 1,
        payload: { taskId: operation.rowId },
      })),
  };
  const app = createSyncularHono({
    config,
    authenticate: async () => ({ actorId: 'actor-1', partition: 'part-1' }),
    admin: {
      authorize: ({ request }) =>
        request.headers.get('authorization') === 'Bearer admin',
      ...(options.actions === true ? { authorizeActions: () => true } : {}),
    },
  });

  async function seed(): Promise<void> {
    const bytes = encodeMessage({
      wireVersion: 3,
      msgKind: 'request',
      frames: [
        {
          type: 'REQ_HEADER',
          clientId: 'client-1',
          schemaVersion: 1,
          logEpoch: TEST_LOG_EPOCH,
        },
        {
          type: 'PUSH_COMMIT',
          clientCommitId: 'c1',
          operations: [
            {
              table: 'tasks',
              rowId: 't1',
              op: 'upsert',
              payload: encodeSparseRow(COLUMNS, 0, ['t1', 'p1', 'hello']),
            },
          ],
        },
        {
          type: 'PULL_HEADER',
          limitCommits: 0,
          limitSnapshotRows: 0,
          maxSnapshotPages: 0,
          accept: 0b0011,
        },
        {
          type: 'SUBSCRIPTION',
          id: 's1',
          table: 'tasks',
          scopes: { project_id: ['p1'] },
          cursor: -1,
        },
      ],
    });
    await app.request('/sync', {
      method: 'POST',
      headers: {
        'content-type': SSP2_CONTENT_TYPE,
        authorization: 'Bearer good',
      },
      body: bytes.slice().buffer as ArrayBuffer,
    });
  }

  const auth = { headers: { authorization: 'Bearer admin' } };
  return { app, seed, auth };
}

describe('mount refusal (no default-open admin)', () => {
  test('createSyncularAdminRoutes throws without an authorize guard', () => {
    const admin = new SyncularAdmin({
      storage: new SqliteServerStorage(),
      segments: new MemorySegmentStore(),
    });
    expect(() =>
      createSyncularAdminRoutes(
        admin,
        // oxlint-disable-next-line typescript/no-explicit-any -- intentionally omitting the required guard.
        {} as any,
      ),
    ).toThrow(/authorize/);
  });
});

describe('auth guard (401 path)', () => {
  test('data endpoints are 401 without the guard passing', async () => {
    const { app } = await harness();
    const res = await app.request('/admin/clients');
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('sync.auth_required');
  });

  test('the page itself is guarded', async () => {
    const { app } = await harness();
    const res = await app.request('/admin');
    expect(res.status).toBe(401);
  });

  test('authorized requests pass', async () => {
    const { app, auth } = await harness();
    const res = await app.request('/admin/clients', auth);
    expect(res.status).toBe(200);
  });
});

describe('JSON endpoints mirror the read surface', () => {
  test('GET /admin/clients', async () => {
    const { app, seed, auth } = await harness();
    await seed();
    const res = await app.request('/admin/clients', auth);
    const body = (await res.json()) as {
      clients: { clientId: string; cursor: number }[];
    };
    expect(body.clients[0]).toMatchObject({ clientId: 'client-1', cursor: 1 });
  });

  test('GET /admin/commits', async () => {
    const { app, seed, auth } = await harness();
    await seed();
    const res = await app.request('/admin/commits?limit=10', auth);
    const body = (await res.json()) as {
      commits: { commitSeq: number; tables: string[] }[];
    };
    expect(body.commits[0]).toMatchObject({ commitSeq: 1, tables: ['tasks'] });
  });

  test('GET /admin/reactions', async () => {
    const { app, seed, auth } = await harness();
    await seed();
    const res = await app.request(
      '/admin/reactions?status=pending&type=email.send',
      auth,
    );
    const body = (await res.json()) as {
      reactions: { status: string; type: string; sourceCommitSeq: number }[];
    };
    expect(body.reactions).toEqual([
      expect.objectContaining({
        status: 'pending',
        type: 'email.send',
        sourceCommitSeq: 1,
      }),
    ]);
  });

  test('GET /admin/rows/:table/:rowId', async () => {
    const { app, seed, auth } = await harness();
    await seed();
    const res = await app.request('/admin/rows/tasks/t1', auth);
    const body = (await res.json()) as {
      row: { exists: boolean; serverVersion: number };
    };
    expect(body.row).toMatchObject({ exists: true, serverVersion: 1 });
  });

  test('GET /admin/rows rejects a table outside the schema', async () => {
    const { app, auth } = await harness();
    const res = await app.request('/admin/rows/nope/t1', auth);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: 'sync.unknown_table',
      details: { table: 'nope' },
    });
  });

  test('GET /admin/scope-activity', async () => {
    const { app, seed, auth } = await harness();
    await seed();
    const res = await app.request(
      '/admin/scope-activity?variable=project_id&value=p1',
      auth,
    );
    const body = (await res.json()) as { activity: { commitSeq: number }[] };
    expect(body.activity[0]?.commitSeq).toBe(1);
  });

  test('GET /admin/scope-activity requires variable+value', async () => {
    const { app, auth } = await harness();
    const res = await app.request('/admin/scope-activity', auth);
    expect(res.status).toBe(400);
  });

  test('GET /admin/horizon', async () => {
    const { app, seed, auth } = await harness();
    await seed();
    const res = await app.request('/admin/horizon', auth);
    const body = (await res.json()) as {
      horizon: { maxCommitSeq: number; recommendation: string };
    };
    expect(body.horizon.maxCommitSeq).toBe(1);
    expect(body.horizon.recommendation).toBeDefined();
  });

  test('GET /admin/stats', async () => {
    const { app, seed, auth } = await harness();
    await seed();
    const res = await app.request('/admin/stats', auth);
    const body = (await res.json()) as {
      stats: { segments?: { count: number } };
    };
    expect(body.stats.segments).toBeDefined();
  });

  test('GET /admin/events returns the ring tail', async () => {
    const { app, seed, auth } = await harness();
    await seed();
    const res = await app.request('/admin/events?limit=50', auth);
    const body = (await res.json()) as {
      events: { type: string }[];
    };
    expect(body.events.some((e) => e.type === 'push.applied')).toBe(true);
  });

  test('GET /admin/events filters by type', async () => {
    const { app, seed, auth } = await harness();
    await seed();
    const res = await app.request('/admin/events?type=pull.served', auth);
    const body = (await res.json()) as { events: { type: string }[] };
    expect(body.events.every((e) => e.type === 'pull.served')).toBe(true);
    expect(body.events.length).toBeGreaterThan(0);
  });

  test('GET /admin/events filters by clientId', async () => {
    const { app, seed, auth } = await harness();
    await seed();
    const res = await app.request('/admin/events?clientId=client-1', auth);
    const body = (await res.json()) as { events: { clientId?: string }[] };
    expect(body.events.length).toBeGreaterThan(0);
    expect(body.events.every((e) => e.clientId === 'client-1')).toBe(true);
    const none = await app.request('/admin/events?clientId=ghost', auth);
    expect(((await none.json()) as { events: unknown[] }).events).toEqual([]);
  });

  test('GET /admin/clients/:clientId returns the drill-down', async () => {
    const { app, seed, auth } = await harness();
    await seed();
    const res = await app.request('/admin/clients/client-1', auth);
    const body = (await res.json()) as {
      detail: {
        exists: boolean;
        client: { clientId: string; lag: number };
        events: { clientId?: string }[];
      };
    };
    expect(body.detail.exists).toBe(true);
    expect(body.detail.client).toMatchObject({ clientId: 'client-1', lag: 0 });
    expect(body.detail.events.length).toBeGreaterThan(0);

    const missing = await app.request('/admin/clients/ghost', auth);
    const missingBody = (await missing.json()) as {
      detail: { exists: boolean };
    };
    expect(missingBody.detail.exists).toBe(false);
  });

  test('GET /admin/metrics aggregates the ring', async () => {
    const { app, seed, auth } = await harness();
    await seed();
    const res = await app.request('/admin/metrics?windowMs=60000', auth);
    const body = (await res.json()) as {
      metrics: {
        requests: { count: number };
        pushes: { applied: number };
        buckets: { counts: number[]; p95Ms: (number | null)[] };
        coverage: { complete: boolean };
      };
    };
    expect(body.metrics.coverage.complete).toBe(true);
    expect(body.metrics.requests.count).toBe(1);
    expect(body.metrics.buckets.p95Ms.filter((p) => p !== null)).toHaveLength(
      1,
    );
    expect(body.metrics.pushes.applied).toBe(1);
    expect(body.metrics.buckets.counts.reduce((a, b) => a + b, 0)).toBe(1);
  });

  test('GET /admin/partitions returns the fleet overview', async () => {
    const { app, seed, auth } = await harness();
    await seed();
    const res = await app.request('/admin/partitions', auth);
    const body = (await res.json()) as {
      partitions: { partition: string; activeClients: number }[];
    };
    expect(body.partitions).toHaveLength(1);
    expect(body.partitions[0]).toMatchObject({
      partition: 'part-1',
      maxCommitSeq: 1,
      knownClients: 1,
      activeClients: 1,
    });
  });
});

describe('SSE event stream', () => {
  test('GET /admin/events/stream replays the backlog as SSE frames', async () => {
    const { app, seed, auth } = await harness();
    await seed();
    const res = await app.request('/admin/events/stream?type=push.applied', {
      ...auth,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body?.getReader();
    if (reader === undefined) throw new Error('expected a body stream');
    // Every enqueue may arrive as its own chunk: accumulate until the
    // backlog's data frame shows up.
    const decoder = new TextDecoder();
    let text = '';
    for (let i = 0; i < 10 && !text.includes('"type"'); i += 1) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    expect(text).toContain('retry: 2000');
    expect(text).toContain('data: ');
    expect(text).toContain('"type":"push.applied"');
    await reader.cancel();
  });

  test('the stream is guarded like every other route', async () => {
    const { app } = await harness();
    const res = await app.request('/admin/events/stream');
    expect(res.status).toBe(401);
  });

  test('without a ring the stream refuses with 400', async () => {
    const admin = new SyncularAdmin({
      storage: new SqliteServerStorage(),
      segments: new MemorySegmentStore(),
    });
    const routes = createSyncularAdminRoutes(admin, {
      authorize: () => true,
    });
    const app = new Hono();
    app.route('/admin', routes);
    const res = await app.request('/admin/events/stream');
    expect(res.status).toBe(400);
  });
});

describe('drill-downs, trace, failures', () => {
  test('GET /admin/info describes the console surface', async () => {
    const { app, auth } = await harness();
    const res = await app.request('/admin/info', auth);
    expect(await res.json()).toMatchObject({
      partition: 'part-1',
      hasEventStream: true,
      actions: false,
      tables: [
        {
          name: 'tasks',
          columns: [
            { name: 'id', type: 'string', nullable: false, primaryKey: true },
            { name: 'project_id', primaryKey: false },
            { name: 'title', primaryKey: false },
          ],
        },
      ],
    });
  });

  test('GET /admin/rows decodes values and lists the row history', async () => {
    const { app, seed, auth } = await harness();
    await seed();
    const res = await app.request('/admin/rows/tasks/t1', auth);
    expect(await res.json()).toMatchObject({
      row: {
        exists: true,
        values: { id: 't1', project_id: 'p1', title: 'hello' },
        history: [{ commitSeq: 1, op: 'upsert', clientId: 'client-1' }],
      },
    });
  });

  test('GET /admin/commits/:seq renders the changes; a missing seq is 404', async () => {
    const { app, seed, auth } = await harness();
    await seed();
    const res = await app.request('/admin/commits/1', auth);
    expect(await res.json()).toMatchObject({
      commit: {
        commitSeq: 1,
        clientCommitId: 'c1',
        changes: [
          {
            table: 'tasks',
            rowId: 't1',
            op: 'upsert',
            values: { title: 'hello' },
          },
        ],
      },
    });
    const missing = await app.request('/admin/commits/99', auth);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({
      code: 'sync.not_found',
      details: { commitSeq: 99 },
    });
  });

  test('GET /admin/trace explains delivery per client and row', async () => {
    const { app, seed, auth } = await harness();
    await seed();
    const trace = async (query: string) =>
      (
        (await (await app.request(`/admin/trace?${query}`, auth)).json()) as {
          trace: {
            verdict: string;
            subscriptions: { effectiveMatch?: boolean }[];
          };
        }
      ).trace;
    const delivered = await trace('table=tasks&rowId=t1&clientId=client-1');
    expect(delivered.verdict).toBe('delivered');
    expect(delivered.subscriptions[0]?.effectiveMatch).toBe(true);
    expect((await trace('table=tasks&rowId=t1&clientId=ghost')).verdict).toBe(
      'client-unknown',
    );
    expect(
      (await trace('table=tasks&rowId=nope&clientId=client-1')).verdict,
    ).toBe('row-missing');
    const incomplete = await app.request('/admin/trace?table=tasks', auth);
    expect(incomplete.status).toBe(400);
  });

  test('GET /admin/errors groups failures with window coverage', async () => {
    const { app, seed, auth } = await harness();
    await seed();
    const res = await app.request('/admin/errors?windowMs=60000', auth);
    expect(await res.json()).toMatchObject({
      errors: {
        windowMs: 60000,
        coverage: { complete: true },
        byCode: [],
        byClient: [],
      },
    });
  });

  test('malformed query parameters answer 400', async () => {
    const { app, auth } = await harness();
    for (const path of ['/admin/clients?limit=ten', '/admin/clients?sort=x']) {
      const res = await app.request(path, auth);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'sync.invalid_request' });
    }
  });
});

describe('navigation routes', () => {
  test('GET /admin/actors, /search, /tables, /rows/:table, delivery and writes', async () => {
    const { app, seed, auth } = await harness();
    await seed();
    const json = async (path: string) =>
      (await app.request(`/admin${path}`, auth)).json();

    expect(await json('/actors')).toMatchObject({
      actors: [{ actorId: 'actor-1', maxLag: 0 }],
    });
    expect(await json('/search?q=t1')).toMatchObject({
      search: { rows: [{ table: 'tasks', rowId: 't1' }] },
    });
    expect(await json('/tables')).toMatchObject({
      tables: [{ name: 'tasks', rowCount: 1 }],
    });
    expect(await json('/rows/tasks?scope=project_id:p1')).toMatchObject({
      page: {
        table: 'tasks',
        rows: [{ rowId: 't1', values: { title: 'hello' } }],
      },
    });
    expect((await app.request('/admin/rows/tasks?scope=p1', auth)).status).toBe(
      400,
    );
    expect(await json('/rows/tasks/t1/delivery')).toMatchObject({
      delivery: {
        clients: [{ client: { clientId: 'client-1' }, verdict: 'delivered' }],
      },
    });
    expect(await json('/writes/c1')).toMatchObject({
      write: {
        outcomes: [{ clientId: 'client-1', status: 'applied', commitSeq: 1 }],
        events: expect.arrayContaining([
          expect.objectContaining({
            type: 'push.applied',
            clientCommitId: 'c1',
          }),
          expect.objectContaining({
            type: 'reaction.queued',
            clientCommitId: 'c1',
          }),
        ]),
      },
    });
    expect(await json('/commits?sample=5')).toMatchObject({
      commits: [
        {
          commitSeq: 1,
          sample: [{ table: 'tasks', rowId: 't1', op: 'upsert' }],
        },
      ],
    });
  });

  test("GET /admin/events?requestId returns one request's events", async () => {
    const { app, seed, auth } = await harness();
    await seed();
    const all = (await (await app.request('/admin/events', auth)).json()) as {
      events: { type: string; requestId?: string }[];
    };
    const requestId = all.events.find(
      (event) => event.type === 'request.handled',
    )?.requestId;
    expect(requestId).toBeString();
    const one = (await (
      await app.request(`/admin/events?requestId=${requestId}`, auth)
    ).json()) as { events: { requestId?: string }[] };
    expect(one.events.length).toBeGreaterThan(1);
    expect(one.events.every((event) => event.requestId === requestId)).toBe(
      true,
    );
  });
});

describe('operator actions', () => {
  test('without authorizeActions every action answers 403', async () => {
    const { app, auth } = await harness();
    const res = await app.request('/admin/prune', { ...auth, method: 'POST' });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'sync.forbidden' });
  });

  test('POST /admin/prune runs one prune pass', async () => {
    const { app, seed, auth } = await harness({ actions: true });
    await seed();
    const info = await app.request('/admin/info', auth);
    expect(await info.json()).toMatchObject({ actions: true });
    const res = await app.request('/admin/prune', { ...auth, method: 'POST' });
    expect(await res.json()).toEqual({
      prune: { previousHorizonSeq: 0, horizonSeq: 0 },
    });
  });

  test('retrying a reaction that is not dead-lettered answers 400', async () => {
    const { app, seed, auth } = await harness({ actions: true });
    await seed();
    const res = await app.request('/admin/reactions/task:t1/retry', {
      ...auth,
      method: 'POST',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: 'sync.invalid_request',
      details: { idempotencyKey: 'task:t1' },
    });
  });
});

describe('createSyncularHono admin option', () => {
  test('the console ring sees socket sessions of the realtime hub', async () => {
    const storage = new SqliteServerStorage();
    await storage.touchPartition('part-1', 0, TEST_LOG_EPOCH);
    const capabilities = {
      schema: SCHEMA,
      storage,
      segments: new MemorySegmentStore(),
      resolveScopes: () => ({ project_id: ['p1'] }),
    };
    const hub = createRealtimeHub(capabilities);
    const app = createSyncularHono({
      config: { ...capabilities, realtime: hub },
      authenticate: async () => null,
      admin: { authorize: () => true },
    });
    await hub.connect({
      partition: 'part-1',
      actorId: 'actor-1',
      clientId: 'client-1',
      send: () => {},
    });
    const res = await app.request('/admin/events?type=realtime.opened');
    expect(await res.json()).toMatchObject({
      events: [{ type: 'realtime.opened', clientId: 'client-1' }],
    });
  });

  test('a request without ?partition= needs one when several exist', async () => {
    const storage = new SqliteServerStorage();
    await storage.touchPartition('part-1', 0, TEST_LOG_EPOCH);
    await storage.touchPartition('part-2', 0, TEST_LOG_EPOCH);
    const app = createSyncularHono({
      config: {
        schema: SCHEMA,
        storage,
        segments: new MemorySegmentStore(),
        resolveScopes: () => ({ project_id: ['p1'] }),
      },
      authenticate: async () => null,
      admin: {
        path: '/ops',
        authorize: ({ request }) =>
          request.headers.get('authorization') === 'Bearer admin',
      },
    });
    const auth = { headers: { authorization: 'Bearer admin' } };
    const ambiguous = await app.request('/ops/clients', auth);
    expect(ambiguous.status).toBe(400);
    expect(await ambiguous.json()).toMatchObject({
      code: 'sync.invalid_request',
      details: { parameter: 'partition' },
    });
    // The partition count is fleet knowledge; an unauthorized caller only
    // learns that it is unauthorized.
    expect((await app.request('/ops/clients')).status).toBe(401);
    const picked = await app.request('/ops/info?partition=part-2', auth);
    expect(await picked.json()).toMatchObject({ partition: 'part-2' });
  });
});

describe('partition-scoped guard', () => {
  function tenantApp() {
    const ring = new RingBufferEvents({ capacity: 10 });
    for (const partition of ['part-1', 'part-2']) {
      ring.emit({
        type: 'lease.revoked',
        atMs: 1,
        partition,
        leaseId: `lease-${partition}`,
      });
    }
    const admin = new SyncularAdmin({
      storage: new SqliteServerStorage(),
      segments: new MemorySegmentStore(),
      ring,
    });
    const routes = createSyncularAdminRoutes(admin, {
      authorize: ({ partition }) => partition === 'part-1',
    });
    const app = new Hono();
    app.route('/admin', routes);
    return app;
  }

  test('the event tail only carries the authorized partition', async () => {
    const res = await tenantApp().request('/admin/events?partition=part-1');
    const body = (await res.json()) as { events: { partition: string }[] };
    expect(body.events.map((event) => event.partition)).toEqual(['part-1']);
  });

  test('the fleet view is never granted by a partition guard', async () => {
    const res = await tenantApp().request('/admin/partitions?partition=part-1');
    expect(res.status).toBe(401);
  });
});

describe('static console page', () => {
  test('GET /admin serves HTML 200 with a content-type', async () => {
    const { app, auth } = await harness();
    const res = await app.request('/admin', auth);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('Syncular console');
    expect(html).toContain('<!doctype html>');
  });

  test('supports the same-origin parent transport used by static hosts', () => {
    expect(ADMIN_CONSOLE_HTML).toContain("get('transport') === 'parent'");
    expect(ADMIN_CONSOLE_HTML).toContain('syncular-admin-request');
    expect(ADMIN_CONSOLE_HTML).toContain('syncular-admin-response');
  });

  test('the page is self-contained and stays under 120 KiB', () => {
    // No stylesheet, script, font, or image fetch: one string serves Bun,
    // Node, and Workers identically.
    expect(ADMIN_CONSOLE_HTML).not.toMatch(
      /<link(?! rel="icon" href="data:)|\bsrc=|url\(|@import|https?:\/\//,
    );
    expect(new TextEncoder().encode(ADMIN_CONSOLE_HTML).length).toBeLessThan(
      120 * 1024,
    );
  });

  test('the page renders the seeded partition from the real endpoints', async () => {
    const { app, seed } = await harness();
    await seed();
    const window = new Window({
      url: 'http://admin.test/admin#/people',
      settings: {
        enableJavaScriptEvaluation: true,
        suppressInsecureJavaScriptEnvironmentWarning: true,
      },
    });
    const pending: Promise<unknown>[] = [];
    const streams: string[] = [];
    Object.defineProperty(window, 'fetch', {
      value: (path: string, init: { headers: Record<string, string> }) => {
        const response = Promise.resolve(
          app.request(path, {
            headers: { ...init.headers, authorization: 'Bearer admin' },
          }),
        );
        pending.push(response);
        return response;
      },
    });
    Object.defineProperty(window, 'EventSource', {
      value: class {
        constructor(url: string) {
          streams.push(url);
        }
        close(): void {}
      },
    });
    // Readiness: drain every request the page issued, then the microtask
    // chains that render them, until the page issues no new request.
    const settle = async (): Promise<void> => {
      for (let seen = -1; seen !== pending.length;) {
        seen = pending.length;
        await Promise.all(pending);
        for (let i = 0; i < 40; i++) await Promise.resolve();
      }
    };
    try {
      window.document.write(ADMIN_CONSOLE_HTML);
      await settle();
      const text = (selector: string) =>
        window.document.querySelector(selector)?.textContent ?? '';
      const visit = async (hash: string): Promise<void> => {
        window.history.pushState(null, '', hash);
        window.dispatchEvent(new window.PopStateEvent('popstate'));
        await settle();
      };
      expect(text('#people-table')).toContain('actor-1');
      expect(text('#people-table')).toContain('client-1');
      expect(text('#n-people')).toBe('1');
      expect(streams).toEqual(['/admin/events/stream?limit=200']);
      expect(text('#updated')).toStartWith('Updated');

      await visit('#/client/client-1');
      expect(text('#client-subs')).toContain('tasks');
      expect(text('#updated')).toStartWith('Updated');

      await visit('#/table/tasks');
      expect(text('#table-rows')).toContain('t1');
      expect(text('#table-rows')).toContain('hello');

      await visit('#/row/tasks/t1');
      expect(text('#row-values')).toContain('hello');
      expect(text('#row-history')).toContain('upsert');
      expect(text('#row-delivery')).toContain('client-1');
      expect(text('#updated')).toStartWith('Updated');

      await visit('#/commits');
      expect(text('#commits-list')).toContain('tasks / t1');

      await visit('#/overview');
      expect(text('#ov-part')).toBe('part-1');
      expect(text('#kpis')).toContain('1 in the last 5 min');
      expect(text('#ov-horizon')).toContain('head 1');
      expect(text('#ov-fleet')).toContain('part-1');
      expect(text('#updated')).toStartWith('Updated');
    } finally {
      await window.happyDOM.close();
    }
  });
});

describe('adapter error mapping (§10.2)', () => {
  test('a host mapError answers a typed catalog error on the admin surface', async () => {
    const storage = new SqliteServerStorage();
    const segments = new MemorySegmentStore();
    const admin = new SyncularAdmin({ storage, segments });
    const observed: unknown[] = [];
    const routes = createSyncularAdminRoutes(admin, {
      authorize: () => {
        throw new Error('quota exhausted');
      },
      onError: (error) => {
        observed.push(error);
      },
      mapError: () =>
        new SyncError(
          'sync.rate_limited',
          'service paused',
          JSON.stringify({ retryAfterMs: 4000 }),
        ),
    });
    const app = new Hono();
    app.route('/admin', routes);
    const response = await app.request('/admin/clients', {
      headers: { authorization: 'Bearer admin' },
    });
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({
      code: 'sync.rate_limited',
      category: 'rate-limited',
      retryable: true,
      recommendedAction: 'retryLater',
      details: { retryAfterMs: 4000 },
    });
    expect(observed).toHaveLength(1);
  });
});
