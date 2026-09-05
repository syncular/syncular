/**
 * Bootstrap (§4.7, §5): fresh via inline segments, external SEGMENT_REF
 * download with content-address verification (§5.1), the §5.6 first-page
 * delete rule, resume mid-way with the opaque token round-trip, handoff to
 * incremental at the pin, and cursor-expired re-bootstrap (§4.6).
 */
import { describe, expect, test } from 'bun:test';
import { compileSchema, type SqliteValue } from '@syncular/server';
import { encodeRow } from '@syncular/core';
import { upsertSql, upsertValues } from '../../server/src/relational-rows';
import {
  makeClient,
  TASK_COLUMNS,
  makeServer,
  PARTITION,
  type TestServer,
  tableRows,
  taskValues,
} from './helpers';

async function seedTasks(
  server: TestServer,
  count: number,
  startAt = 0,
): Promise<void> {
  const seeder = await makeClient(server, { clientId: `seeder-${startAt}` });
  for (let i = startAt; i < startAt + count; i++) {
    seeder.client.mutate([
      {
        table: 'tasks',
        op: 'upsert',
        values: taskValues(`t${String(i).padStart(3, '0')}`, 'p1', `task ${i}`),
      },
    ]);
  }
  const summary = await seeder.client.sync();
  expect(summary.applied).toHaveLength(count);
}

describe('fresh bootstrap', () => {
  test('inline segments deliver the snapshot; incremental takes over at the pin', async () => {
    const server = makeServer();
    await seedTasks(server, 5);
    const b = await makeClient(server, { clientId: 'client-b' });
    b.client.subscribe({
      id: 's1',
      table: 'tasks',
      scopes: { project_id: ['p1'] },
    });
    const summary = await b.client.sync();
    expect(summary.segmentRowsApplied).toBe(5);
    expect(summary.bootstrapping).toHaveLength(0);
    expect(tableRows(b.db, 'tasks')).toHaveLength(5);
    const sub = b.client.subscription('s1');
    expect(sub?.cursor).toBe(await server.storage.getMaxCommitSeq(PARTITION));
    expect(sub?.bootstrapState).toBeUndefined();

    // A later commit arrives incrementally, not via re-bootstrap.
    const a = await makeClient(server, { clientId: 'client-a' });
    a.client.subscribe({
      id: 's1',
      table: 'tasks',
      scopes: { project_id: ['p1'] },
    });
    await a.client.syncUntilIdle();
    a.client.mutate([
      { table: 'tasks', op: 'upsert', values: taskValues('t999', 'p1', 'new') },
    ]);
    await a.client.syncUntilIdle();
    const incremental = await b.client.sync();
    expect(incremental.commitsApplied).toBe(1);
    expect(incremental.segmentRowsApplied).toBe(0);
    expect(tableRows(b.db, 'tasks')).toHaveLength(6);
  });

  test('§5.6 first-page rule: stale scoped rows do not survive a fresh bootstrap', async () => {
    const server = makeServer();
    await seedTasks(server, 2);
    const b = await makeClient(server, { clientId: 'client-b' });
    // A stale local row inside the subscribed scope, unknown to the server.
    b.db.exec(
      `INSERT INTO "tasks" (id, project_id, title, done, priority, meta, _sync_version)
       VALUES ('stale', 'p1', 'stale', 0, NULL, NULL, 7)`,
    );
    // A local row in another scope stays untouched.
    b.db.exec(
      `INSERT INTO "tasks" (id, project_id, title, done, priority, meta, _sync_version)
       VALUES ('other', 'p2', 'other-scope', 0, NULL, NULL, 0)`,
    );
    b.client.subscribe({
      id: 's1',
      table: 'tasks',
      scopes: { project_id: ['p1'] },
    });
    await b.client.syncUntilIdle();
    const ids = tableRows(b.db, 'tasks').map((r) => r.id);
    expect(ids).not.toContain('stale');
    expect(ids).toContain('other');
    expect(ids).toHaveLength(3);
  });

  test('all §2.4 column types round-trip through a bootstrap segment', async () => {
    const server = makeServer();
    const seeder = await makeClient(server, { clientId: 'seeder' });
    seeder.client.mutate([
      {
        table: 'tasks',
        op: 'upsert',
        values: taskValues('t1', 'p1', 'naïve 🚀', true, 42, '{"a":[1,2]}'),
      },
      {
        table: 'tasks',
        op: 'upsert',
        values: taskValues('t2', 'p1', '', false, null, null),
      },
    ]);
    await seeder.client.sync();
    const b = await makeClient(server, { clientId: 'client-b' });
    b.client.subscribe({
      id: 's1',
      table: 'tasks',
      scopes: { project_id: ['p1'] },
    });
    await b.client.syncUntilIdle();
    const rows = tableRows(b.db, 'tasks');
    expect(rows[0]).toMatchObject({
      id: 't1',
      title: 'naïve 🚀',
      done: 1,
      priority: 42,
      meta: '{"a":[1,2]}',
    });
    expect(rows[1]).toMatchObject({ id: 't2', title: '', priority: null });
  });
});

describe('external segments (SEGMENT_REF)', () => {
  test('referenced segments download, verify, and apply', async () => {
    const server = makeServer();
    server.limits.inlineSegmentMaxBytes = 0; // force SEGMENT_REF
    await seedTasks(server, 5);
    const b = await makeClient(server, { clientId: 'client-b' });
    b.client.subscribe({
      id: 's1',
      table: 'tasks',
      scopes: { project_id: ['p1'] },
    });
    const summary = await b.client.sync();
    expect(summary.segmentRowsApplied).toBe(5);
    expect(tableRows(b.db, 'tasks')).toHaveLength(5);
  });

  test('§5.1: a hash mismatch discards the segment; the re-pull converges', async () => {
    const server = makeServer();
    server.limits.inlineSegmentMaxBytes = 0;
    await seedTasks(server, 5);
    const b = await makeClient(server, {
      clientId: 'client-b',
      // accept pins the rows lane: this test exercises §5.2 paging (the
      // sqlite lane is whole-table and would swallow the second page).
      limits: { limitSnapshotRows: 2, maxSnapshotPages: 2, accept: 0b0011 },
    });
    b.client.subscribe({
      id: 's1',
      table: 'tasks',
      scopes: { project_id: ['p1'] },
    });
    b.faults.corruptSegmentDownload = 2; // second page tampered
    await expect(b.client.sync()).rejects.toThrow('content-address');
    // SUB_END was never processed: no cursor, no resume token (§1.4).
    const sub = b.client.subscription('s1');
    expect(sub?.cursor).toBe(-1);
    expect(sub?.bootstrapState).toBeUndefined();

    await b.client.syncUntilIdle();
    expect(tableRows(b.db, 'tasks')).toHaveLength(5);
  });
});

describe('bootstrap resume (§4.7)', () => {
  test('a paged bootstrap resumes from the opaque token and hands off at the pin', async () => {
    const server = makeServer();
    await seedTasks(server, 5);
    const pin = await server.storage.getMaxCommitSeq(PARTITION);
    const b = await makeClient(server, {
      clientId: 'client-b',
      // accept 0b0011 pins the rows lane — this test is about §4.7 paging.
      limits: { limitSnapshotRows: 2, maxSnapshotPages: 1, accept: 0b0011 },
    });
    b.client.subscribe({
      id: 's1',
      table: 'tasks',
      scopes: { project_id: ['p1'] },
    });

    const first = await b.client.sync();
    expect(first.bootstrapping).toEqual(['s1']);
    expect(tableRows(b.db, 'tasks')).toHaveLength(2);
    const mid = b.client.subscription('s1');
    // §4.7: every bootstrap response pins nextCursor = asOfCommitSeq; the
    // token, round-tripped opaquely, marks the subscription as resuming.
    expect(mid?.cursor).toBe(pin);
    expect(mid?.bootstrapState).toBeDefined();

    // A commit lands mid-bootstrap; the post-pin replay must deliver it.
    const a = await makeClient(server, { clientId: 'client-a' });
    a.client.subscribe({
      id: 's1',
      table: 'tasks',
      scopes: { project_id: ['p1'] },
    });
    await a.client.syncUntilIdle();
    a.client.mutate([
      {
        table: 'tasks',
        op: 'upsert',
        values: taskValues('t000', 'p1', 'edited-mid-bootstrap'),
      },
    ]);
    await a.client.syncUntilIdle();

    await b.client.syncUntilIdle();
    const rows = tableRows(b.db, 'tasks');
    expect(rows).toHaveLength(5);
    expect(rows[0]?.title).toBe('edited-mid-bootstrap');
    expect(b.client.subscription('s1')?.bootstrapState).toBeUndefined();
  });

  test('a lost response mid-bootstrap resumes without loss or duplication', async () => {
    const server = makeServer();
    await seedTasks(server, 5);
    const b = await makeClient(server, {
      clientId: 'client-b',
      // accept 0b0011 pins the rows lane — resume needs a paged bootstrap.
      limits: { limitSnapshotRows: 2, maxSnapshotPages: 1, accept: 0b0011 },
    });
    b.client.subscribe({
      id: 's1',
      table: 'tasks',
      scopes: { project_id: ['p1'] },
    });
    await b.client.sync(); // page 1 applied, token persisted

    b.faults.dropResponseOnce = true;
    await expect(b.client.sync()).rejects.toThrow('simulated response loss');
    // Token unchanged — the next pull re-delivers the same window (§1.4).
    await b.client.syncUntilIdle();
    expect(tableRows(b.db, 'tasks')).toHaveLength(5);
  });
});

describe('cursor expiry (§4.6)', () => {
  test('a pruned-past cursor resets, re-bootstraps, and converges', async () => {
    const server = makeServer();
    await seedTasks(server, 3);
    const b = await makeClient(server, { clientId: 'client-b' });
    b.client.subscribe({
      id: 's1',
      table: 'tasks',
      scopes: { project_id: ['p1'] },
    });
    await b.client.syncUntilIdle();
    const oldCursor = b.client.subscription('s1')?.cursor ?? -1;

    // The server advances and prunes past B's cursor while B is away.
    await seedTasks(server, 2, 100);
    const horizon = oldCursor + 1;
    await server.storage.setHorizonSeq(PARTITION, horizon);
    const logEpoch = await server.storage.getPartitionLogEpoch(PARTITION);
    if (logEpoch === undefined) throw new Error('missing epoch');
    await server.storage.pruneCommitsThrough(PARTITION, {
      logEpoch,
      throughSeq: horizon,
    });

    const summary = await b.client.sync();
    expect(summary.resets).toEqual(['s1']);
    const sub = b.client.subscription('s1');
    expect(sub?.cursor).toBe(-1);
    expect(sub?.status).toBe('active');
    expect(b.client.diagnosticsSnapshot().subscriptions[0]).toMatchObject({
      id: 's1',
      state: 'reset',
      complete: false,
      reasonCode: 'sync.cursor_expired',
    });
    // §4.6: reset is a staleness signal, not a purge — rows stay in place
    // until bootstrap application replaces them.
    expect(tableRows(b.db, 'tasks')).toHaveLength(3);

    await b.client.syncUntilIdle();
    expect(tableRows(b.db, 'tasks')).toHaveLength(5);
    expect(b.client.subscription('s1')?.cursor).toBe(
      await server.storage.getMaxCommitSeq(PARTITION),
    );
    expect(b.client.diagnosticsSnapshot().subscriptions[0]).toMatchObject({
      state: 'complete',
      complete: true,
    });
  });
});

test('batched image construction converges cold and warm clients with all row versions', async () => {
  const count = process.env.SYNCULAR_IMAGE_BENCH === '1' ? 100_000 : 2_001;
  const server = makeServer();
  const schema = compileSchema(server.ctxFor('actor-1').schema);
  await server.storage.ensureSchema(schema);
  const table = schema.tables.get('tasks')!;
  const insert = server.storage.db.query(upsertSql(table, 'sqlite'));
  const scope = server.storage.db.query(
    'INSERT INTO sync_row_scopes(partition,tbl,var,value,row_id) VALUES (?,?,?,?,?)',
  );
  server.storage.db.exec('BEGIN');
  for (let index = 0; index < count; index += 1) {
    const id = String(index).padStart(6, '0');
    insert.run(
      ...(upsertValues(
        table,
        PARTITION,
        {
          rowId: id,
          serverVersion: 7,
          scopes: { project_id: 'p1' },
          payload: encodeRow(TASK_COLUMNS, [
            id,
            'p1',
            'task',
            false,
            null,
            null,
          ]),
        },
        'sqlite',
      ) as SqliteValue[]),
    );
    scope.run(PARTITION, 'tasks', 'project_id', 'p1', id);
  }
  server.storage.db.exec('COMMIT');
  for (const phase of ['cold', 'warm']) {
    const { client, db } = await makeClient(server, {
      clientId: phase,
      limits: { accept: 7 },
    });
    try {
      client.subscribe({
        id: 's',
        table: 'tasks',
        scopes: { project_id: ['p1'] },
      });
      const start = performance.now();
      await client.syncUntilIdle();
      const elapsedMs = performance.now() - start;
      expect(client.query('SELECT COUNT(*) AS count FROM tasks')).toEqual([
        { count },
      ]);
      expect(
        client.query('SELECT id, title FROM tasks ORDER BY id LIMIT 1'),
      ).toEqual([{ id: '000000', title: 'task' }]);
      expect(
        db.query(
          'SELECT MIN(_sync_version) AS minimum, MAX(_sync_version) AS maximum FROM tasks',
        ),
      ).toEqual([{ minimum: 7, maximum: 7 }]);
      expect(client.subscription('s')?.cursor).toBe(0);
      if (process.env.SYNCULAR_IMAGE_BENCH === '1')
        console.log(JSON.stringify({ phase, count, elapsedMs }));
    } finally {
      await client.close();
      db.close();
    }
  }
  server.storage.db.close();
}, 60_000);
