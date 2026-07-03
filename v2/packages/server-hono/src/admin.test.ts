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
} from '@syncular-v2/core';
import {
  MemorySegmentStore,
  RingBufferEvents,
  type ServerSchema,
  SqliteServerStorage,
  SSP2_CONTENT_TYPE,
  type SyncServerConfig,
  SyncularAdmin,
} from '@syncular-v2/server';
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
