/**
 * Bootstrap: inline rows segments, paging, resumable bootstrapState,
 * pinning (SPEC.md §4.7, §5) — driven through bytes.
 */
import { describe, expect, test } from 'bun:test';
import {
  decodeRowsSegment,
  type SegmentInlineFrame,
  type SegmentRefFrame,
} from '@syncular/core';
import {
  compileSchema,
  verifySegmentToken,
  MemorySegmentStore,
  type SqliteValue,
} from '@syncular/server';
import { buildSqliteImage } from '@syncular/server/sqlite';
import { Database } from 'bun:sqlite';
import { subscriptionSection } from '../src/pull';
import { upsertSql, upsertValues } from '../src/relational-rows';
import {
  makeContext,
  taskRow,
  pullHeader,
  section,
  seedTask,
  subFrame,
  sync,
} from './helpers';

function inlineSegments(body: { type: string }[]): SegmentInlineFrame[] {
  return body.filter(
    (f): f is SegmentInlineFrame => f.type === 'SEGMENT_INLINE',
  );
}

function refSegments(body: { type: string }[]): SegmentRefFrame[] {
  return body.filter((f): f is SegmentRefFrame => f.type === 'SEGMENT_REF');
}

describe('fresh bootstrap (§4.7, §5.7)', () => {
  test('cursor -1 delivers an inline rows segment and completes', async () => {
    const t = makeContext();
    t.scopes.value = { project_id: ['p1', 'p2'] };
    await seedTask(t, 'c1', 't1', 'p1', 'one');
    await seedTask(t, 'c2', 't2', 'p1', 'two');
    await seedTask(t, 'c3', 'tx', 'p2', 'other-scope');
    const maxSeq = 3;
    const message = await sync(t, [
      pullHeader(),
      subFrame('s1', 'tasks', { project_id: ['p1'] }, -1),
    ]);
    const s = section(message, 's1');
    expect(s.start.status).toBe('active');
    expect(s.start.bootstrap).toBe(true);
    const inline = inlineSegments(s.body);
    expect(inline).toHaveLength(1);
    const segment = decodeRowsSegment(inline[0]?.payload ?? new Uint8Array());
    expect(segment.table).toBe('tasks');
    expect(segment.schemaVersion).toBe(1);
    expect(segment.columns.map((c) => c.name)).toEqual([
      'id',
      'project_id',
      'title',
      'done',
      'priority',
      'meta',
    ]);
    const rows = segment.blocks.flat();
    expect(rows.map((r) => r.values[0])).toEqual(['t1', 't2']); // p2 row excluded
    // §5.2: every row record carries the row's current server_version.
    expect(rows.map((r) => r.serverVersion)).toEqual([1, 1]);
    expect(s.end.nextCursor).toBe(maxSeq);
    expect(s.end.bootstrapState).toBeUndefined(); // complete
  });

  test('an empty table still delivers a first-page segment (§5.6 delete rule)', async () => {
    const t = makeContext();
    const message = await sync(t, [
      pullHeader(),
      subFrame('s1', 'tasks', { project_id: ['p1'] }, -1),
    ]);
    const s = section(message, 's1');
    expect(s.start.bootstrap).toBe(true);
    const inline = inlineSegments(s.body);
    expect(inline).toHaveLength(1);
    const segment = decodeRowsSegment(inline[0]?.payload ?? new Uint8Array());
    expect(segment.blocks.flat()).toHaveLength(0);
    expect(s.end.bootstrapState).toBeUndefined();
  });

  test('a cursor from the future re-bootstraps (§4.7)', async () => {
    const t = makeContext();
    await seedTask(t, 'c1', 't1', 'p1');
    const message = await sync(t, [
      pullHeader(),
      subFrame('s1', 'tasks', { project_id: ['p1'] }, 999),
    ]);
    expect(section(message, 's1').start.bootstrap).toBe(true);
  });
});

describe('paged, resumable, pinned bootstrap (§4.7)', () => {
  test('pages, resumes from bootstrapState, and pins asOfCommitSeq', async () => {
    const t = makeContext();
    for (let i = 1; i <= 5; i++) {
      await seedTask(t, `c${i}`, `t${i}`, 'p1', `row ${i}`);
    }
    const pinnedSeq = 5;
    const page = () =>
      pullHeader({ limitSnapshotRows: 2, maxSnapshotPages: 1 });

    const first = await sync(t, [
      page(),
      subFrame('s1', 'tasks', { project_id: ['p1'] }, -1),
    ]);
    const s1 = section(first, 's1');
    const seg1 = decodeRowsSegment(
      inlineSegments(s1.body)[0]?.payload ?? new Uint8Array(),
    );
    expect(seg1.blocks.flat().map((r) => r.values[0])).toEqual(['t1', 't2']);
    expect(s1.end.nextCursor).toBe(pinnedSeq);
    const token1 = s1.end.bootstrapState;
    if (token1 === undefined) throw new Error('expected bootstrapState');
    expect(JSON.parse(token1)).toMatchObject({
      asOfCommitSeq: pinnedSeq,
      tables: ['tasks'],
      tableIndex: 0,
      rowCursor: 't2',
    });

    // New commits land while the bootstrap is in flight — the pin holds.
    await seedTask(t, 'c6', 't6', 'p1', 'late');

    const second = await sync(t, [
      page(),
      subFrame('s1', 'tasks', { project_id: ['p1'] }, pinnedSeq, {
        bootstrapState: token1,
      }),
    ]);
    const s2 = section(second, 's1');
    const seg2 = decodeRowsSegment(
      inlineSegments(s2.body)[0]?.payload ?? new Uint8Array(),
    );
    // t6 is included in the scan (snapshot reads current rows) — but the
    // pin means the post-pin commit replays after completion; here page 2
    // continues at the recorded row cursor.
    expect(seg2.blocks.flat().map((r) => r.values[0])).toEqual(['t3', 't4']);
    expect(s2.end.nextCursor).toBe(pinnedSeq);
    const token2 = s2.end.bootstrapState;
    if (token2 === undefined) throw new Error('expected bootstrapState');

    const third = await sync(t, [
      page(),
      subFrame('s1', 'tasks', { project_id: ['p1'] }, pinnedSeq, {
        bootstrapState: token2,
      }),
    ]);
    const s3 = section(third, 's1');
    expect(s3.end.bootstrapState).toBeUndefined(); // complete
    expect(s3.end.nextCursor).toBe(pinnedSeq);

    // Completion hands off to incremental pulls at the pin: the late
    // commit replays through the log window.
    const incremental = await sync(t, [
      pullHeader(),
      subFrame('s1', 'tasks', { project_id: ['p1'] }, pinnedSeq),
    ]);
    const commits = section(incremental, 's1').body.filter(
      (f) => f.type === 'COMMIT',
    );
    expect(commits).toHaveLength(1);
  });

  test('a resumed pin behind the horizon restarts from a fresh pin (§4.7)', async () => {
    const t = makeContext();
    for (let i = 1; i <= 3; i++) {
      await seedTask(t, `c${i}`, `t${i}`, 'p1');
    }
    const staleToken = JSON.stringify({
      asOfCommitSeq: 1,
      tables: ['tasks'],
      tableIndex: 0,
      rowCursor: 't2',
    });
    await t.storage.setHorizonSeq('part-1', 2);
    const message = await sync(t, [
      pullHeader({ limitSnapshotRows: 2, maxSnapshotPages: 1 }),
      subFrame('s1', 'tasks', { project_id: ['p1'] }, 1, {
        bootstrapState: staleToken,
      }),
    ]);
    const s = section(message, 's1');
    expect(s.start.status).toBe('active');
    expect(s.start.bootstrap).toBe(true);
    const segment = decodeRowsSegment(
      inlineSegments(s.body)[0]?.payload ?? new Uint8Array(),
    );
    // Restarted from the beginning of the table with a fresh pin.
    expect(segment.blocks.flat().map((r) => r.values[0])).toEqual(['t1', 't2']);
    expect(s.end.nextCursor).toBe(3);
    const token = s.end.bootstrapState;
    if (token === undefined) throw new Error('expected bootstrapState');
    expect(JSON.parse(token)).toMatchObject({ asOfCommitSeq: 3 });
  });
});

describe('segment delivery negotiation (§4.2, §5.4, §5.7)', () => {
  test('segments above the inline threshold become SEGMENT_REFs', async () => {
    const t = makeContext({ limits: { inlineSegmentMaxBytes: 1 } });
    await seedTask(t, 'c1', 't1', 'p1');
    const message = await sync(t, [
      pullHeader(),
      subFrame('s1', 'tasks', { project_id: ['p1'] }, -1),
    ]);
    const s = section(message, 's1');
    const refs = refSegments(s.body);
    expect(refs).toHaveLength(1);
    const ref = refs[0];
    expect(ref?.mediaType).toBe('rows');
    expect(ref?.table).toBe('tasks');
    expect(ref?.rowCount).toBe(1);
    expect(ref?.asOfCommitSeq).toBe(1);
    expect(ref?.rowCursor).toBeUndefined(); // first page
    expect(ref?.nextRowCursor).toBeUndefined(); // last page
    expect(ref?.url).toBeUndefined(); // no signed-URL config
    const stored = await t.segments.get(ref?.segmentId ?? '');
    expect(stored).toBeDefined();
    expect(stored?.record.scopeDigest).toBe(ref?.scopeDigest ?? '');
  });

  test('without external-rows acceptance (bit 1) segments inline regardless of size', async () => {
    const t = makeContext({ limits: { inlineSegmentMaxBytes: 1 } });
    await seedTask(t, 'c1', 't1', 'p1');
    const message = await sync(t, [
      pullHeader({ accept: 0b0001 }),
      subFrame('s1', 'tasks', { project_id: ['p1'] }, -1),
    ]);
    const s = section(message, 's1');
    expect(inlineSegments(s.body)).toHaveLength(1);
    expect(refSegments(s.body)).toHaveLength(0);
  });

  test('signed URLs are issued when advertised and configured (§5.4)', async () => {
    const key = 'test-signing-key';
    const t = makeContext({
      limits: { inlineSegmentMaxBytes: 1 },
      signedUrls: {
        key,
        baseUrl: 'https://cdn.example/segments',
        ttlSeconds: 600,
        audience: (partition) => `aud-${partition}`,
      },
    });
    await seedTask(t, 'c1', 't1', 'p1');
    const message = await sync(t, [
      pullHeader({ accept: 0b1011 }),
      subFrame('s1', 'tasks', { project_id: ['p1'] }, -1),
    ]);
    const ref = refSegments(section(message, 's1').body)[0];
    if (ref?.url === undefined) throw new Error('expected a signed url');
    expect(ref.url.startsWith('https://cdn.example/segments/sha256:')).toBe(
      true,
    );
    expect(ref.urlExpiresAtMs).toBe(t.now.ms - (t.now.ms % 1000) + 600_000);
    const token = new URL(ref.url).searchParams.get('st');
    if (token === null) throw new Error('missing st token');
    const claims = await verifySegmentToken(key, token, {
      segmentId: ref.segmentId,
      scopeDigest: ref.scopeDigest,
      audience: 'aud-part-1',
      nowMs: t.now.ms,
    });
    expect(claims.seg).toBe(ref.segmentId);
    // Tampered expectations are rejected.
    await expect(
      verifySegmentToken(key, token, {
        segmentId: ref.segmentId,
        scopeDigest: 'not-the-digest',
        audience: 'aud-part-1',
        nowMs: t.now.ms,
      }),
    ).rejects.toMatchObject({ code: 'sync.forbidden' });
    await expect(
      verifySegmentToken('wrong-key', token, {
        segmentId: ref.segmentId,
        scopeDigest: ref.scopeDigest,
        audience: 'aud-part-1',
        nowMs: t.now.ms,
      }),
    ).rejects.toMatchObject({ code: 'sync.forbidden' });
    // Expired tokens are rejected (past TTL + skew).
    await expect(
      verifySegmentToken(key, token, {
        segmentId: ref.segmentId,
        scopeDigest: ref.scopeDigest,
        audience: 'aud-part-1',
        nowMs: t.now.ms + 700_000,
      }),
    ).rejects.toMatchObject({ code: 'sync.forbidden' });
  });
});

describe('coalesced SQLite image builds', () => {
  test('20 authorized cold requests share one bounded build; warm requests reuse it', async () => {
    const count = process.env.SYNCULAR_IMAGE_BENCH === '1' ? 100_000 : 1_001;
    const requestCount = process.env.SYNCULAR_IMAGE_SINGLE === '1' ? 1 : 20;
    let grants = 0;
    let builds = 0;
    let stagedRows = 0;
    let maxBatch = 0;
    const t = makeContext({
      signedUrls: {
        presign: ({ segmentId, nowMs }) => ({
          url: `https://segments.example/${segmentId}?grant=${++grants}`,
          urlExpiresAtMs: nowMs + 1000,
        }),
      },
      sqliteImageBuilder: async (input) => {
        builds += 1;
        return buildSqliteImage({
          ...input,
          rowBatches: (async function* () {
            for await (const rows of input.rowBatches) {
              stagedRows += rows.length;
              maxBatch = Math.max(maxBatch, rows.length);
              yield rows;
            }
          })(),
        });
      },
    });
    await t.storage.ensureSchema(compileSchema(t.ctx.schema));
    // Bulk fixture loading excludes replacement-scope deletion from bootstrap timing.
    const table = compileSchema(t.ctx.schema).tables.get('tasks')!;
    const insertRow = t.storage.db.query(upsertSql(table, 'sqlite'));
    const insertScope = t.storage.db.query(
      'INSERT INTO sync_row_scopes(partition,tbl,var,value,row_id) VALUES (?,?,?,?,?)',
    );
    t.storage.db.exec('BEGIN');
    for (let index = 0; index < count; index += 1) {
      const rowId = String(index).padStart(6, '0');
      insertRow.run(
        ...(upsertValues(
          table,
          'part-1',
          {
            rowId,
            serverVersion: 7,
            scopes: { project_id: 'p1' },
            payload: taskRow(rowId, 'p1'),
          },
          'sqlite',
        ) as SqliteValue[]),
      );
      insertScope.run('part-1', 'tasks', 'project_id', 'p1', rowId);
    }
    t.storage.db.exec('COMMIT');
    let arrivals = 0;
    let allArrived!: () => void;
    const arrived = new Promise<void>((resolve) => {
      allArrived = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scanRows = t.storage.scanRows.bind(t.storage);
    t.storage.scanRows = async (partition, query) => {
      if (query.afterRowId === null && arrivals < requestCount) {
        arrivals += 1;
        if (arrivals === requestCount) allArrived();
        await gate;
      }
      return scanRows(partition, query);
    };
    let authorizations = 0;
    t.ctx = {
      ...t.ctx,
      resolveScopes: () => {
        authorizations += 1;
        return t.scopes.value;
      },
    };
    const frames = () => [
      pullHeader({ accept: 0b1111, limitSnapshotRows: 1000 }),
      subFrame('s1', 'tasks', { project_id: ['p1'] }, -1),
    ];
    const start = performance.now();
    const requests = Array.from({ length: requestCount }, (_, index) =>
      sync(t, frames(), { clientId: `image-${index}` }),
    );
    await arrived;
    release();
    const responses = await Promise.all(requests);
    const coldMs = performance.now() - start;
    expect(builds).toBe(
      process.env.SYNCULAR_IMAGE_BASELINE === '1' ? requestCount : 1,
    );
    expect(stagedRows).toBe(
      count * (process.env.SYNCULAR_IMAGE_BASELINE === '1' ? requestCount : 1),
    );
    expect(maxBatch).toBeLessThanOrEqual(
      process.env.SYNCULAR_IMAGE_BASELINE === '1' ? count : 5_000,
    );
    expect(authorizations).toBe(requestCount);
    const refs = responses.map(
      (response) => refSegments(section(response, 's1').body)[0]!,
    );
    expect(new Set(refs.map((ref) => ref.segmentId)).size).toBe(1);
    expect(new Set(refs.map((ref) => ref.url)).size).toBe(requestCount);
    expect(grants).toBe(requestCount);
    const stored = await t.segments.get(refs[0]!.segmentId);
    expect(stored?.record.rowCount).toBe(count);
    const image = Database.deserialize(stored!.bytes);
    expect(
      image
        .query(
          'SELECT COUNT(*) AS count, MIN(_syncular_version) AS version FROM tasks',
        )
        .get(),
    ).toEqual({ count, version: 7 });
    expect(image.query('SELECT rowCount FROM _syncular_segment').get()).toEqual(
      { rowCount: count },
    );
    image.close();
    const warmStart = performance.now();
    await Promise.all(
      Array.from({ length: requestCount }, (_, index) =>
        sync(t, frames(), { clientId: `warm-${index}` }),
      ),
    );
    const warmMs = performance.now() - warmStart;
    expect(builds).toBe(
      process.env.SYNCULAR_IMAGE_BASELINE === '1' ? requestCount : 1,
    );
    expect(authorizations).toBe(requestCount * 2);
    if (process.env.SYNCULAR_IMAGE_BENCH === '1')
      console.log(
        JSON.stringify({
          count,
          requestCount,
          coldMs,
          warmMs,
          maxBatch,
          stagedRows,
          imageBytes: stored!.bytes.byteLength,
          maxRssBytes: process.resourceUsage().maxRSS * 1024,
        }),
      );
    t.storage.db.close();
  }, 60_000);

  test('failed builds leave no in-flight entry and a retry can produce the artifact', async () => {
    let attempts = 0;
    const t = makeContext({
      sqliteImageBuilder: async (input) => {
        attempts += 1;
        if (attempts === 1) throw new Error('injected build failure');
        return buildSqliteImage(input);
      },
    });
    await seedTask(t, 'one', 'r1', 'p1');
    await seedTask(t, 'two', 'r2', 'p1');
    const frames = () => [
      pullHeader({ accept: 0b0111, limitSnapshotRows: 1 }),
      subFrame('s1', 'tasks', { project_id: ['p1'] }, -1),
    ];
    await expect(sync(t, frames())).rejects.toThrow('injected build failure');
    const retried = await sync(t, frames());
    expect(refSegments(section(retried, 's1').body)).toHaveLength(1);
    expect(attempts).toBe(2);
    t.storage.db.close();
  });
});

test('image build identity includes scopes, partition, epoch, pin, schema and owning stores', async () => {
  let builds = 0;
  const t = makeContext({
    sqliteImageBuilder: async (input) => {
      builds += 1;
      return buildSqliteImage(input);
    },
  });
  t.scopes.value = { project_id: ['p1', 'p2'] };
  for (const project of ['p1', 'p2']) {
    for (let index = 0; index < 2; index += 1)
      await seedTask(t, `${project}-${index}`, `${project}-${index}`, project);
  }
  const rows = await t.storage.scanRows('part-1', {
    table: 'tasks',
    scopeFilter: { project_id: ['p1'] },
    afterRowId: null,
    limit: 10,
  });
  const tx = await t.storage.begin('part-2');
  for (const row of rows) await tx.upsertRow('tasks', row);
  await tx.commit();
  const variants = [
    {
      partition: 'part-1',
      epoch: 'epoch1',
      pin: 4,
      project: 'p1',
      version: 1,
      segments: t.segments,
    },
    {
      partition: 'part-2',
      epoch: 'epoch1',
      pin: 4,
      project: 'p1',
      version: 1,
      segments: t.segments,
    },
    {
      partition: 'part-1',
      epoch: 'epoch2',
      pin: 4,
      project: 'p1',
      version: 1,
      segments: t.segments,
    },
    {
      partition: 'part-1',
      epoch: 'epoch1',
      pin: 5,
      project: 'p1',
      version: 1,
      segments: t.segments,
    },
    {
      partition: 'part-1',
      epoch: 'epoch1',
      pin: 4,
      project: 'p2',
      version: 1,
      segments: t.segments,
    },
    {
      partition: 'part-1',
      epoch: 'epoch1',
      pin: 4,
      project: 'p1',
      version: 2,
      segments: t.segments,
    },
    {
      partition: 'part-1',
      epoch: 'epoch1',
      pin: 4,
      project: 'p1',
      version: 1,
      segments: new MemorySegmentStore(),
    },
  ];
  await Promise.all(
    variants.map(async (variant) => {
      const schema = compileSchema({
        ...t.ctx.schema,
        version: variant.version,
      });
      const plan = {
        frame: subFrame('s', 'tasks', { project_id: [variant.project] }, -1),
        table: schema.tables.get('tasks')!,
        status: 'active' as const,
        effective: { project_id: [variant.project] },
      };
      const stream = subscriptionSection(
        { ...t.ctx, partition: variant.partition, segments: variant.segments },
        schema,
        {
          accept: 7,
          limitSnapshotRows: 1,
          maxSnapshotPages: 1,
          limitCommits: 1000,
        },
        plan,
        variant.pin,
        0,
        undefined,
        variant.epoch,
      );
      const refs = [];
      for await (const frame of stream)
        if (frame.type === 'SEGMENT_REF') refs.push(frame);
      expect(refs).toHaveLength(1);
      expect(refs[0]?.asOfCommitSeq).toBe(variant.pin);
      const stored = await variant.segments.get(refs[0]!.segmentId);
      expect(stored?.record).toMatchObject({
        partition: variant.partition,
        logEpoch: variant.epoch,
        schemaVersion: variant.version,
      });
    }),
  );
  expect(builds).toBe(variants.length);
  t.storage.db.close();
});

test('returning one subscription stream does not cancel a build awaited by another', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const building = new Promise<void>((resolve) => {
    started = resolve;
  });
  let builds = 0;
  const t = makeContext({
    sqliteImageBuilder: async (input) => {
      builds += 1;
      started();
      await gate;
      return buildSqliteImage(input);
    },
  });
  await seedTask(t, 'one', 'r1', 'p1');
  await seedTask(t, 'two', 'r2', 'p1');
  const schema = compileSchema(t.ctx.schema);
  const streams = [0, 1].map(() =>
    subscriptionSection(
      t.ctx,
      schema,
      {
        accept: 7,
        limitSnapshotRows: 1,
        maxSnapshotPages: 1,
        limitCommits: 1000,
      },
      {
        frame: subFrame('s', 'tasks', { project_id: ['p1'] }, -1),
        table: schema.tables.get('tasks')!,
        status: 'active',
        effective: { project_id: ['p1'] },
      },
      2,
      0,
      undefined,
      'epoch',
    ),
  );
  for (const stream of streams)
    expect((await stream.next()).value).toMatchObject({ type: 'SUB_START' });
  const first = streams[0]!.next();
  const second = streams[1]!.next();
  await building;
  const cancelled = streams[0]!.return({ nextCursor: -1, active: false });
  release();
  await first;
  await cancelled;
  expect((await second).value).toMatchObject({
    type: 'SEGMENT_REF',
    mediaType: 'sqlite',
    rowCount: 2,
  });
  expect(builds).toBe(1);
  await streams[1]!.return({ nextCursor: 2, active: true });
  t.storage.db.close();
});
