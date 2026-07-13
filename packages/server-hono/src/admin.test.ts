/**
 * Admin HTTP routes (TODO §2.5): auth-guard enforcement (mount refusal +
 * 401 path), JSON endpoints mirroring the read surface, and a smoke of the
 * static console page. Driven through Hono's in-process fetch dispatch (the
 * same allowance as index.test.ts — no socket).
 */
import { describe, expect, test } from 'bun:test';
import {
  encodeMessage,
  encodeRow,
  PROTOCOL_WIRE_VERSION,
  type RowColumn,
} from '@syncular/core';
import {
  MemorySegmentStore,
  RingBufferEvents,
  type ServerSchema,
  SqliteServerStorage,
  SSP2_CONTENT_TYPE,
  type SyncServerConfig,
  SyncularAdmin,
} from '@syncular/server';
import { Hono } from 'hono';
import { createSyncularAdminRoutes } from './admin';
import { createSyncularHono } from './index';

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
function harness() {
  const storage = new SqliteServerStorage();
  const segments = new MemorySegmentStore();
  const ring = new RingBufferEvents({ capacity: 100 });
  const config: SyncServerConfig = {
    schema: SCHEMA,
    storage,
    segments,
    resolveScopes: () => ({ project_id: ['p1'] }),
    events: ring,
  };
  const sync = createSyncularHono({
    config,
    authenticate: async () => ({ actorId: 'actor-1', partition: 'part-1' }),
  });
  const admin = SyncularAdmin.fromConfig(config, { ring });
  const routes = createSyncularAdminRoutes(admin, {
    defaultPartition: 'part-1',
    authorize: ({ request }) =>
      request.headers.get('authorization') === 'Bearer admin',
  });
  const app = new Hono();
  app.route('/admin', routes);

  async function seed(): Promise<void> {
    const bytes = encodeMessage({
      wireVersion: PROTOCOL_WIRE_VERSION,
      msgKind: 'request',
      frames: [
        { type: 'REQ_HEADER', clientId: 'client-1', schemaVersion: 1 },
        {
          type: 'PUSH_COMMIT',
          clientCommitId: 'c1',
          operations: [
            {
              table: 'tasks',
              rowId: 't1',
              op: 'upsert',
              payload: encodeRow(COLUMNS, ['t1', 'p1', 'hello']),
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
    await sync.request('/sync', {
      method: 'POST',
      headers: {
        'content-type': SSP2_CONTENT_TYPE,
        authorization: 'Bearer good',
      },
      body: bytes.slice().buffer as ArrayBuffer,
    });
  }

  const auth = { headers: { authorization: 'Bearer admin' } };
  return { app, admin, seed, auth };
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
        // biome-ignore lint/suspicious/noExplicitAny: intentionally omitting the required guard.
        {} as any,
      ),
    ).toThrow(/authorize/);
  });
});

describe('auth guard (401 path)', () => {
  test('data endpoints are 401 without the guard passing', async () => {
    const { app } = harness();
    const res = await app.request('/admin/clients');
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('sync.auth_required');
  });

  test('the page itself is guarded', async () => {
    const { app } = harness();
    const res = await app.request('/admin');
    expect(res.status).toBe(401);
  });

  test('authorized requests pass', async () => {
    const { app, auth } = harness();
    const res = await app.request('/admin/clients', auth);
    expect(res.status).toBe(200);
  });
});

describe('JSON endpoints mirror the read surface', () => {
  test('GET /admin/clients', async () => {
    const { app, seed, auth } = harness();
    await seed();
    const res = await app.request('/admin/clients', auth);
    const body = (await res.json()) as {
      clients: { clientId: string; cursor: number }[];
    };
    expect(body.clients[0]).toMatchObject({ clientId: 'client-1', cursor: 1 });
  });

  test('GET /admin/commits', async () => {
    const { app, seed, auth } = harness();
    await seed();
    const res = await app.request('/admin/commits?limit=10', auth);
    const body = (await res.json()) as {
      commits: { commitSeq: number; tables: string[] }[];
    };
    expect(body.commits[0]).toMatchObject({ commitSeq: 1, tables: ['tasks'] });
  });

  test('GET /admin/rows/:table/:rowId', async () => {
    const { app, seed, auth } = harness();
    await seed();
    const res = await app.request('/admin/rows/tasks/t1', auth);
    const body = (await res.json()) as {
      row: { exists: boolean; serverVersion: number };
    };
    expect(body.row).toMatchObject({ exists: true, serverVersion: 1 });
  });

  test('GET /admin/scope-activity', async () => {
    const { app, seed, auth } = harness();
    await seed();
    const res = await app.request(
      '/admin/scope-activity?variable=project_id&value=p1',
      auth,
    );
    const body = (await res.json()) as { activity: { commitSeq: number }[] };
    expect(body.activity[0]?.commitSeq).toBe(1);
  });

  test('GET /admin/scope-activity requires variable+value', async () => {
    const { app, auth } = harness();
    const res = await app.request('/admin/scope-activity', auth);
    expect(res.status).toBe(400);
  });

  test('GET /admin/horizon', async () => {
    const { app, seed, auth } = harness();
    await seed();
    const res = await app.request('/admin/horizon', auth);
    const body = (await res.json()) as {
      horizon: { maxCommitSeq: number; recommendation: string };
    };
    expect(body.horizon.maxCommitSeq).toBe(1);
    expect(body.horizon.recommendation).toBeDefined();
  });

  test('GET /admin/stats', async () => {
    const { app, seed, auth } = harness();
    await seed();
    const res = await app.request('/admin/stats', auth);
    const body = (await res.json()) as {
      stats: { segments?: { count: number } };
    };
    expect(body.stats.segments).toBeDefined();
  });

  test('GET /admin/events returns the ring tail', async () => {
    const { app, seed, auth } = harness();
    await seed();
    const res = await app.request('/admin/events?limit=50', auth);
    const body = (await res.json()) as {
      events: { type: string }[];
      hasEventStream: boolean;
    };
    expect(body.hasEventStream).toBe(true);
    expect(body.events.some((e) => e.type === 'push.applied')).toBe(true);
  });

  test('GET /admin/events filters by type', async () => {
    const { app, seed, auth } = harness();
    await seed();
    const res = await app.request('/admin/events?type=pull.served', auth);
    const body = (await res.json()) as { events: { type: string }[] };
    expect(body.events.every((e) => e.type === 'pull.served')).toBe(true);
    expect(body.events.length).toBeGreaterThan(0);
  });

  test('GET /admin/events filters by clientId', async () => {
    const { app, seed, auth } = harness();
    await seed();
    const res = await app.request('/admin/events?clientId=client-1', auth);
    const body = (await res.json()) as { events: { clientId?: string }[] };
    expect(body.events.length).toBeGreaterThan(0);
    expect(body.events.every((e) => e.clientId === 'client-1')).toBe(true);
    const none = await app.request('/admin/events?clientId=ghost', auth);
    expect(((await none.json()) as { events: unknown[] }).events).toEqual([]);
  });

  test('GET /admin/clients/:clientId returns the drill-down', async () => {
    const { app, seed, auth } = harness();
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
    const { app, seed, auth } = harness();
    await seed();
    const res = await app.request('/admin/metrics?windowMs=60000', auth);
    const body = (await res.json()) as {
      metrics: {
        requests: { count: number };
        pushes: { applied: number };
        buckets: { counts: number[] };
      };
      hasEventStream: boolean;
    };
    expect(body.hasEventStream).toBe(true);
    expect(body.metrics.requests.count).toBe(1);
    expect(body.metrics.pushes.applied).toBe(1);
    expect(body.metrics.buckets.counts.reduce((a, b) => a + b, 0)).toBe(1);
  });

  test('GET /admin/partitions returns the fleet overview', async () => {
    const { app, seed, auth } = harness();
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
    const { app, seed, auth } = harness();
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
    const { app } = harness();
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

describe('static console page', () => {
  test('GET /admin serves HTML 200 with a content-type', async () => {
    const { app, auth } = harness();
    const res = await app.request('/admin', auth);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('Syncular console');
    expect(html).toContain('<!doctype html>');
  });
});
