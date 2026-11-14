/**
 * Bootstrap (§4.7, §5): fresh via inline segments, external SEGMENT_REF
 * download with content-address verification (§5.1), the §5.6 first-page
 * delete rule, resume mid-way with the opaque token round-trip, handoff to
 * incremental at the pin, and cursor-expired re-bootstrap (§4.6).
 */
import { describe, expect, test } from 'bun:test';
import {
  PROTOCOL_WIRE_VERSION,
  unitId,
  encodeMessage,
  encodeRow,
  encodeRowsSegment,
} from '@syncular/core';
import { compileSchema, type SqliteValue } from '@syncular/server';
import { SyncClient, type SegmentFetchRequest } from '@syncular/client';
import { BunClientDatabase } from '@syncular/client/bun';
import { upsertSql, upsertValues } from '../../server/src/relational-rows';
import {
  CLIENT_SCHEMA,
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
    b.client.subscribe({ project_id: 'p1' });
    const summary = await b.client.sync();
    expect(summary.segmentRowsApplied).toBe(5);
    expect(summary.bootstrapping).toHaveLength(0);
    expect(tableRows(b.db, 'tasks')).toHaveLength(5);
    expect(b.client.unitCatchup(unitId({ project_id: 'p1' }))).toMatchObject({
      live: true,
      cursor: await server.storage.getMaxCommitSeq(PARTITION),
      hasResumeToken: false,
    });

    // A later commit arrives incrementally, not via re-bootstrap.
    const a = await makeClient(server, { clientId: 'client-a' });
    a.client.subscribe({ project_id: 'p1' });
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
    b.client.subscribe({ project_id: 'p1' });
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
    b.client.subscribe({ project_id: 'p1' });
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
  /**
   * A response whose frames are the only authority: N rows pages, one row
   * each, content-addressed so a misordered apply fails §5.1 verification.
   */
  async function pageResponse(ids: readonly string[]): Promise<{
    response: Uint8Array;
    pages: { segmentId: string; bytes: Uint8Array }[];
  }> {
    const pages = await Promise.all(
      ids.map(async (id) => {
        const bytes = encodeRowsSegment({
          table: 'tasks',
          schemaVersion: 1,
          columns: TASK_COLUMNS,
          blocks: [
            [
              {
                serverVersion: 1,
                values: [id, 'p1', `row ${id}`, false, null, null],
              },
            ],
          ],
        });
        const digest = await crypto.subtle.digest(
          'SHA-256',
          bytes.slice().buffer as ArrayBuffer,
        );
        const hex = [...new Uint8Array(digest)]
          .map((byte) => byte.toString(16).padStart(2, '0'))
          .join('');
        return { segmentId: `sha256:${hex}`, bytes };
      }),
    );
    return {
      pages,
      response: encodeMessage({
        wireVersion: PROTOCOL_WIRE_VERSION,
        msgKind: 'response',
        frames: [
          { type: 'RESP_HEADER', logEpoch: 'epoch-1', resetRequired: false },
          {
            type: 'SUB_START',
            id: unitId({ project_id: 'p1' }),
            status: 'active',
            reasonCode: '',
            fenced: [],
            bootstrap: true,
          },
          ...pages.map((page) => ({
            type: 'SEGMENT_REF' as const,
            segmentId: page.segmentId,
            mediaType: 'rows' as const,
            table: 'tasks',
            byteLength: page.bytes.byteLength,
            rowCount: 1,
            asOfCommitSeq: 1,
            scopeDigest: 'digest',
          })),
          { type: 'SUB_END', nextCursor: 1 },
          { type: 'LIVE_START', status: 'active', reasonCode: '' },
          { type: 'LIVE_END', throughSeq: 1, echoDigest: new Uint8Array(32) },
        ],
      }),
    };
  }

  /** One client whose segment downloads park on manual gates. */
  async function gatedClient(ids: readonly string[]): Promise<{
    client: SyncClient;
    pages: { segmentId: string; bytes: Uint8Array }[];
    started: string[];
    gates: Map<string, { resolve: () => void; reject: (error: Error) => void }>;
    /** Settles once `count` downloads have started. */
    issued: (count: number) => Promise<void>;
  }> {
    const db = new BunClientDatabase();
    const { response, pages } = await pageResponse(ids);
    const started: string[] = [];
    const gates = new Map<
      string,
      { resolve: () => void; reject: (error: Error) => void }
    >();
    const waiters: Array<() => void> = [];
    const issued = (count: number) =>
      new Promise<void>((resolve) => {
        const check = () => {
          if (started.length >= count) resolve();
        };
        waiters.push(check);
        check();
      });
    const segments = (request: SegmentFetchRequest): Promise<Uint8Array> => {
      started.push(request.segmentId);
      const bytes = pages.find(
        (page) => page.segmentId === request.segmentId,
      )!.bytes;
      return new Promise<Uint8Array>((resolve, reject) => {
        gates.set(request.segmentId, { resolve: () => resolve(bytes), reject });
        for (const check of waiters) check();
      });
    };
    const client = new SyncClient({
      database: db,
      schema: CLIENT_SCHEMA,
      clientId: 'segment-batch',
      transport: async () => response,
      segments,
    });
    await client.start();
    db.exec(
      "INSERT OR REPLACE INTO _syncular_meta(key, value) VALUES ('logEpoch', 'epoch-1')",
    );
    client.subscribe({ project_id: 'p1' });
    return { client, pages, started, gates, issued };
  }

  test('every page download of one response is in flight before the first applies', async () => {
    const ids = ['a', 'b', 'c'] as const;
    const { client, pages, started, gates, issued } = await gatedClient(ids);
    try {
      const round = client.sync();
      await issued(ids.length);
      expect(started).toEqual(pages.map((page) => page.segmentId));
      // No page has resolved, so the apply loop is still parked on the first
      // one and nothing has applied yet.
      expect(client.query('SELECT id FROM tasks ORDER BY id')).toEqual([]);
      // Resolve out of order: apply still runs in frame order.
      for (const page of [...pages].reverse())
        gates.get(page.segmentId)!.resolve();
      const summary = await round;
      expect(summary.segmentRowsApplied).toBe(3);
      expect(client.query('SELECT id FROM tasks ORDER BY id')).toEqual([
        { id: 'a' },
        { id: 'b' },
        { id: 'c' },
      ]);
      expect(started).toHaveLength(3);
    } finally {
      await client.close();
    }
  });

  test('a response downloads through a window of four and each applied page starts the next', async () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'] as const;
    const { client, pages, started, gates, issued } = await gatedClient(ids);
    const segmentIds = pages.map((page) => page.segmentId);
    try {
      const round = client.sync();
      await issued(4);
      expect(started).toEqual(segmentIds.slice(0, 4));
      // Applying the first page frees its slot for the fifth download.
      gates.get(segmentIds[0]!)!.resolve();
      await issued(5);
      expect(started).toEqual(segmentIds.slice(0, 5));
      gates.get(segmentIds[1]!)!.resolve();
      await issued(6);
      for (const segmentId of segmentIds.slice(2))
        gates.get(segmentId)!.resolve();
      expect((await round).segmentRowsApplied).toBe(6);
      expect(started).toEqual(segmentIds);
    } finally {
      await client.close();
    }
  });

  test('a page fetch apply never awaits cannot surface as an unhandled rejection', async () => {
    const { client, pages, gates, issued } = await gatedClient(['a', 'b', 'c']);
    try {
      const round = client.sync();
      await issued(3);
      // The first page fails, so the apply loop aborts before the others are
      // awaited; their rejections must stay handled.
      gates.get(pages[0]!.segmentId)!.reject(new Error('segment fetch failed'));
      await expect(round).rejects.toThrow('segment fetch failed');
      for (const page of pages.slice(1))
        gates.get(page.segmentId)!.reject(new Error('late failure'));
      expect(client.unit(unitId({ project_id: 'p1' }))?.cursor).toBe(-1);
    } finally {
      await client.close();
    }
  });

  test('§4.6: a live replica behind a commit past the live byte budget re-bootstraps to its state', async () => {
    const server = makeServer();
    await seedTasks(server, 2);
    const b = await makeClient(server, { clientId: 'client-b' });
    b.client.subscribe({ project_id: 'p1' });
    await b.client.syncUntilIdle();
    expect(tableRows(b.db, 'tasks')).toHaveLength(2);
    // One commit of 8 rows of 4 KiB titles, past a 16 KiB budget.
    server.limits.maxLiveSectionBytes = 16 * 1024;
    const writer = await makeClient(server, { clientId: 'writer' });
    writer.client.mutate(
      Array.from({ length: 8 }, (_, i) => ({
        table: 'tasks',
        op: 'upsert' as const,
        values: taskValues(`big${i}`, 'p1', 'x'.repeat(4096)),
      })),
    );
    await writer.client.syncUntilIdle();
    const reset = await b.client.sync();
    expect(reset.resets).toEqual([unitId({ project_id: 'p1' })]);
    await b.client.syncUntilIdle();
    expect(tableRows(b.db, 'tasks').map((row) => row.id)).toEqual([
      ...Array.from({ length: 8 }, (_, i) => `big${i}`),
      't000',
      't001',
    ]);
    expect(b.client.unit(unitId({ project_id: 'p1' }))?.status).toBe('active');
  });

  test('referenced segments download, verify, and apply', async () => {
    const server = makeServer();
    server.limits.inlineSegmentMaxBytes = 0; // force SEGMENT_REF
    await seedTasks(server, 5);
    const b = await makeClient(server, { clientId: 'client-b' });
    b.client.subscribe({ project_id: 'p1' });
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
    b.client.subscribe({ project_id: 'p1' });
    b.faults.corruptSegmentDownload = 2; // second page tampered
    await expect(b.client.sync()).rejects.toThrow('content-address');
    // SUB_END was never processed: no cursor, no resume token (§1.4).
    const sub = b.client.unit(unitId({ project_id: 'p1' }));
    expect(sub?.cursor).toBe(-1);
    expect(sub?.bootstrapState).toBeUndefined();

    await b.client.syncUntilIdle();
    expect(tableRows(b.db, 'tasks')).toHaveLength(5);
  });
});

describe('segment byteLength cap (§5.4)', () => {
  test('a body longer than its descriptor fails before the content-address check', async () => {
    const server = makeServer();
    server.limits.inlineSegmentMaxBytes = 0;
    await seedTasks(server, 3);
    const b = await makeClient(server, { clientId: 'client-b' });
    b.client.subscribe({ project_id: 'p1' });
    b.faults.extendSegmentDownloadOnce = true;
    await expect(b.client.sync()).rejects.toThrow(
      'segment exceeds its byteLength',
    );
    expect(b.client.unit(unitId({ project_id: 'p1' }))?.cursor).toBe(-1);
    await b.client.syncUntilIdle();
    expect(tableRows(b.db, 'tasks')).toHaveLength(3);
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
    b.client.subscribe({ project_id: 'p1' });

    const first = await b.client.sync();
    expect(first.bootstrapping).toEqual([unitId({ project_id: 'p1' })]);
    expect(tableRows(b.db, 'tasks')).toHaveLength(2);
    const mid = b.client.unit(unitId({ project_id: 'p1' }));
    // §4.7: every bootstrap response pins nextCursor = asOfCommitSeq; the
    // token, round-tripped opaquely, marks the subscription as resuming.
    expect(mid?.cursor).toBe(pin);
    expect(mid?.bootstrapState).toBeDefined();

    // A commit lands mid-bootstrap; the post-pin replay must deliver it.
    const a = await makeClient(server, { clientId: 'client-a' });
    a.client.subscribe({ project_id: 'p1' });
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
    expect(
      b.client.unit(unitId({ project_id: 'p1' }))?.bootstrapState,
    ).toBeUndefined();
  });

  test('a subscription left mid-bootstrap keeps sync-needed raised', async () => {
    const server = makeServer();
    await seedTasks(server, 5);
    const b = await makeClient(server, {
      clientId: 'client-b',
      limits: { limitSnapshotRows: 2, maxSnapshotPages: 1, accept: 0b0011 },
    });
    b.client.subscribe({ project_id: 'p1' });

    // A drive that ends early (deadline, budget, a manual sync) leaves the
    // resume token; the status tells every host loop more rounds are owed.
    const first = await b.client.sync();
    expect(first.bootstrapping).toEqual([unitId({ project_id: 'p1' })]);
    expect(b.client.statusSnapshot().syncNeeded).toBe(true);

    await b.client.syncUntilIdle();
    expect(tableRows(b.db, 'tasks')).toHaveLength(5);
    expect(b.client.statusSnapshot().syncNeeded).toBe(false);
  });

  test('a lost response mid-bootstrap resumes without loss or duplication', async () => {
    const server = makeServer();
    await seedTasks(server, 5);
    const b = await makeClient(server, {
      clientId: 'client-b',
      // accept 0b0011 pins the rows lane — resume needs a paged bootstrap.
      limits: { limitSnapshotRows: 2, maxSnapshotPages: 1, accept: 0b0011 },
    });
    b.client.subscribe({ project_id: 'p1' });
    await b.client.sync(); // page 1 applied, token persisted

    b.faults.dropResponseOnce = true;
    await expect(b.client.sync()).rejects.toThrow('transport round failed');
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
    b.client.subscribe({ project_id: 'p1' });
    await b.client.syncUntilIdle();
    const oldCursor = b.client.diagnosticsSnapshot().replicaCursor;

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
    expect(summary.resets).toEqual([unitId({ project_id: 'p1' })]);
    const sub = b.client.unit(unitId({ project_id: 'p1' }));
    expect(sub?.cursor).toBe(-1);
    expect(sub?.status).toBe('active');
    expect(b.client.diagnosticsSnapshot().units).toMatchObject({
      reset: 1,
      reasonCodes: ['sync.cursor_expired'],
    });
    // §4.6: reset is a staleness signal, not a purge — rows stay in place
    // until bootstrap application replaces them.
    expect(tableRows(b.db, 'tasks')).toHaveLength(3);

    await b.client.syncUntilIdle();
    expect(tableRows(b.db, 'tasks')).toHaveLength(5);
    expect(b.client.unit(unitId({ project_id: 'p1' }))?.cursor).toBeUndefined();
    expect(b.client.diagnosticsSnapshot()).toMatchObject({
      replicaCursor: await server.storage.getMaxCommitSeq(PARTITION),
      units: { complete: 1 },
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
      client.subscribe({ project_id: 'p1' });
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
      expect(client.unitCatchup(unitId({ project_id: 'p1' }))).toMatchObject({
        live: true,
        cursor: 0,
      });
      if (process.env.SYNCULAR_IMAGE_BENCH === '1')
        console.log(JSON.stringify({ phase, count, elapsedMs }));
    } finally {
      await client.close();
      db.close();
    }
  }
  server.storage.db.close();
}, 60_000);
