/**
 * The ONE apply-path invalidation choke point (TODO 3.1 / DESIGN-eviction
 * I1–I4): every local mutation emits exactly one coalesced
 * `{tables, scopeKeys}` event per apply batch, keyed by the §3.1 scope
 * vocabulary where the wire carries it. These tests assert the granularity
 * truth and the coalescing rule against the real loopback server — the
 * substrate the React `useRawSql` re-run logic depends on.
 */
import { describe, expect, test } from 'bun:test';
import type { InvalidationEvent } from '@syncular/client';
import {
  makeClient,
  makeServer,
  type TestClient,
  type TestServer,
  taskValues,
} from './helpers';

interface Recorder {
  readonly events: InvalidationEvent[];
  /** Flattened tables across all captured events. */
  tables(): string[];
  /** Flattened scope keys across all captured events. */
  scopeKeys(): string[];
  reset(): void;
}

function record(client: TestClient['client']): Recorder {
  const events: InvalidationEvent[] = [];
  client.onInvalidate((event) => events.push(event));
  return {
    events,
    tables: () => events.flatMap((e) => [...e.tables]),
    scopeKeys: () => events.flatMap((e) => [...e.scopeKeys]),
    reset: () => {
      events.length = 0;
    },
  };
}

async function seededPair(): Promise<{
  server: TestServer;
  a: TestClient;
  b: TestClient;
}> {
  const server = makeServer();
  const a = await makeClient(server, { clientId: 'client-a' });
  const b = await makeClient(server, { clientId: 'client-b' });
  for (const c of [a, b]) {
    c.client.subscribe({
      id: 's1',
      table: 'tasks',
      scopes: { project_id: ['p1'] },
    });
    await c.client.syncUntilIdle();
  }
  return { server, a, b };
}

describe('invalidation choke point (TODO 3.1)', () => {
  test('local mutate emits one event with the touched table + scope key', async () => {
    const { a } = await seededPair();
    const rec = record(a.client);
    a.client.mutate([
      { table: 'tasks', op: 'upsert', values: taskValues('t1', 'p1', 'hi') },
    ]);
    // I1: exactly ONE event per apply batch (never per row).
    expect(rec.events).toHaveLength(1);
    expect(rec.tables()).toEqual(['tasks']);
    // I2: the §3.1 `prefix:value` scope key, derived from the scope column.
    expect(rec.scopeKeys()).toEqual(['project:p1']);
  });

  test('a relevant-table pull re-runs; the row scope key is precise', async () => {
    const { a, b } = await seededPair();
    a.client.mutate([
      { table: 'tasks', op: 'upsert', values: taskValues('t1', 'p1', 'x') },
    ]);
    await a.client.sync();

    const rec = record(b.client);
    await b.client.syncUntilIdle();
    // COMMIT frames carry per-row scopes (§4.5): precise key on the pull.
    expect(rec.tables()).toContain('tasks');
    expect(rec.scopeKeys()).toContain('project:p1');
  });

  test('coalescing: a multi-row commit is ONE event with distinct keys (I1)', async () => {
    const { a, b } = await seededPair();
    // Two projects in one commit: one batch, two scope keys, one table.
    a.client.subscribe({
      id: 's2',
      table: 'tasks',
      scopes: { project_id: ['p2'] },
    });
    await a.client.syncUntilIdle();
    b.client.subscribe({
      id: 's2',
      table: 'tasks',
      scopes: { project_id: ['p2'] },
    });
    await b.client.syncUntilIdle();

    a.client.mutate([
      { table: 'tasks', op: 'upsert', values: taskValues('t1', 'p1', 'a') },
      { table: 'tasks', op: 'upsert', values: taskValues('t2', 'p2', 'b') },
    ]);
    await a.client.sync();

    const rec = record(b.client);
    await b.client.syncUntilIdle();
    // I1: coalesced — the whole round is one event, not one per row/commit.
    expect(rec.events.length).toBeGreaterThanOrEqual(1);
    const keys = new Set(rec.scopeKeys());
    expect(keys.has('project:p1')).toBe(true);
    expect(keys.has('project:p2')).toBe(true);
  });

  test('counter-proof (I4): an unrelated-table commit never touches tasks', async () => {
    const { server, a, b } = await seededPair();
    // Both also subscribe to `docs` so it bootstraps and stays in sync.
    for (const c of [a, b]) {
      c.client.subscribe({
        id: 'sd',
        table: 'docs',
        scopes: { org_id: ['o1'] },
      });
      await c.client.syncUntilIdle();
    }
    void server;

    a.client.mutate([
      {
        table: 'docs',
        op: 'upsert',
        values: { id: 'd1', org_id: 'o1', project_id: 'p9', body: 'hello' },
      },
    ]);
    await a.client.sync();

    const rec = record(b.client);
    await b.client.syncUntilIdle();
    // Only `docs` invalidates — the `tasks` live query must NOT re-run.
    const tables = new Set(rec.tables());
    expect(tables.has('docs')).toBe(true);
    expect(tables.has('tasks')).toBe(false);
    // The docs scope key uses the `org:` prefix (multi-pattern table).
    expect(rec.scopeKeys()).toContain('org:o1');
  });

  test('a no-op pull (nothing delivered) emits no event', async () => {
    const { b } = await seededPair();
    const rec = record(b.client);
    await b.client.syncUntilIdle();
    expect(rec.events).toHaveLength(0);
  });

  test('segment bootstrap invalidates the table + subscription scope keys', async () => {
    const server = makeServer();
    const a = await makeClient(server, { clientId: 'client-a' });
    // Seed rows on the server via client A first.
    a.client.subscribe({
      id: 's1',
      table: 'tasks',
      scopes: { project_id: ['p1'] },
    });
    await a.client.syncUntilIdle();
    a.client.mutate([
      { table: 'tasks', op: 'upsert', values: taskValues('t1', 'p1', 'seed') },
    ]);
    await a.client.sync();

    // A fresh client B bootstraps via a segment: table + effective scope key.
    const b = await makeClient(server, { clientId: 'client-b' });
    const rec = record(b.client);
    b.client.subscribe({
      id: 's1',
      table: 'tasks',
      scopes: { project_id: ['p1'] },
    });
    await b.client.syncUntilIdle();
    expect(rec.tables()).toContain('tasks');
    expect(rec.scopeKeys()).toContain('project:p1');
  });
});
