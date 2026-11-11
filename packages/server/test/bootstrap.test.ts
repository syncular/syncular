/**
 * Bootstrap: inline rows segments, paging, resumable bootstrapState,
 * pinning (SPEC.md §4.7, §5) — driven through bytes.
 */
import { describe, expect, test } from 'bun:test';
import {
  decodeRowsSegment,
  encodeRow,
  encodeSparseRow,
  type SegmentInlineFrame,
  type SegmentRefFrame,
} from '@syncular/core';
import {
  compileSchema,
  type SyncularServerEvent,
  issueSegmentUrl,
  scopeDigest,
  segmentIdFor,
  verifySegmentToken,
  MemorySegmentStore,
  type SqliteValue,
} from '@syncular/server';
import { buildSqliteImage } from '@syncular/server/sqlite';
import { Database } from 'bun:sqlite';
import { bootstrapSegments, planBootstrap, planUnit } from '../src/pull';
import { upsertSql, upsertValues } from '../src/relational-rows';
import {
  docRow,
  makeContext,
  pushCommit,
  TASK_COLUMNS,
  live,
  progressFrame,
  pullFrames,
  section,
  sections,
  seedTask,
  sync,
  TEST_LOG_EPOCH,
  TestReplica,
  upsert,
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
  test('Bun hosts require an injected builder for cold images but reuse stored images without it', async () => {
    const t = makeContext();
    await seedTask(t, 'c1', 't1', 'p1', 'one');
    await seedTask(t, 'c2', 't2', 'p1', 'two');
    const { sqliteImageBuilder, ...withoutBuilder } = t.ctx;
    expect(sqliteImageBuilder).toBe(buildSqliteImage);
    const frames = [
      ...pullFrames([{ project_id: 'p1' }], {
        accept: 0b1111,
        limitSnapshotRows: 1,
      }),
    ];
    const rows = section(await sync({ ...t, ctx: withoutBuilder }, frames), {
      project_id: 'p1',
    });
    expect(
      inlineSegments(rows.body).length + refSegments(rows.body).length,
    ).toBeGreaterThan(0);
    expect(
      refSegments(rows.body).some((frame) => frame.mediaType === 'sqlite'),
    ).toBe(false);

    const external = section(
      await sync(
        {
          ...t,
          ctx: { ...withoutBuilder, limits: { inlineSegmentMaxBytes: 0 } },
        },
        frames,
      ),
      { project_id: 'p1' },
    );
    expect(inlineSegments(external.body)).toHaveLength(0);
    expect(refSegments(external.body).length).toBeGreaterThan(0);
    expect(
      refSegments(external.body).every((frame) => frame.mediaType === 'rows'),
    ).toBe(true);

    const image = section(await sync(t, frames), { project_id: 'p1' });
    const imageRefs = refSegments(image.body);
    expect(imageRefs).toHaveLength(1);
    expect(imageRefs[0]?.mediaType).toBe('sqlite');
    const reused = section(await sync({ ...t, ctx: withoutBuilder }, frames), {
      project_id: 'p1',
    });
    expect(refSegments(reused.body)).toEqual(imageRefs);
  });

  test('cursor -1 delivers an inline rows segment and completes', async () => {
    const t = makeContext();
    t.scopes.value = { project_id: ['p1', 'p2'] };
    await seedTask(t, 'c1', 't1', 'p1', 'one');
    await seedTask(t, 'c2', 't2', 'p1', 'two');
    await seedTask(t, 'c3', 'tx', 'p2', 'other-scope');
    const maxSeq = 3;
    const message = await sync(t, [...pullFrames([{ project_id: 'p1' }])]);
    const s = section(message, { project_id: 'p1' });
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
    const message = await sync(t, [...pullFrames([{ project_id: 'p1' }])]);
    const s = section(message, { project_id: 'p1' });
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
      ...pullFrames([{ project_id: 'p1' }], {
        progress: [progressFrame({ project_id: 'p1' }, 999)],
      }),
    ]);
    expect(section(message, { project_id: 'p1' }).start.bootstrap).toBe(true);
  });
});

describe('paged, resumable, pinned bootstrap (§4.7)', () => {
  test('pages, resumes from bootstrapState, and pins asOfCommitSeq', async () => {
    const t = makeContext();
    for (let i = 1; i <= 5; i++) {
      await seedTask(t, `c${i}`, `t${i}`, 'p1', `row ${i}`);
    }
    const pinnedSeq = 5;
    const page = (cursor: number, token?: string) =>
      pullFrames([{ project_id: 'p1' }], {
        limitSnapshotRows: 2,
        maxSnapshotPages: 1,
        progress: [progressFrame({ project_id: 'p1' }, cursor, token)],
      });

    const first = await sync(t, page(-1));
    const s1 = section(first, { project_id: 'p1' });
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

    const second = await sync(t, page(pinnedSeq, token1));
    const s2 = section(second, { project_id: 'p1' });
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

    const third = await sync(t, page(pinnedSeq, token2));
    const s3 = section(third, { project_id: 'p1' });
    expect(s3.end.bootstrapState).toBeUndefined(); // complete
    expect(s3.end.nextCursor).toBe(pinnedSeq);

    // Completion enters the scan set at the pin (§4.5): the late commit
    // replays in the same response's live section.
    expect(live(third).commits.map((commit) => commit.commitSeq)).toEqual([6]);
    expect(live(third).end.throughSeq).toBe(6);
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
      ...pullFrames([{ project_id: 'p1' }], {
        limitSnapshotRows: 2,
        maxSnapshotPages: 1,
        progress: [progressFrame({ project_id: 'p1' }, 1, staleToken)],
      }),
    ]);
    const s = section(message, { project_id: 'p1' });
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

test('a unit pages across its covered tables in bootstrap order (§4.7)', async () => {
  const noteColumns = [
    { name: 'id', type: 'string', nullable: false },
    { name: 'project_id', type: 'string', nullable: false },
  ] as const;
  const t = makeContext({
    schema: {
      version: 1,
      tables: [
        {
          name: 'tasks',
          columns: TASK_COLUMNS,
          primaryKey: 'id',
          scopes: ['project:{project_id}'],
        },
        {
          name: 'notes',
          columns: noteColumns,
          primaryKey: 'id',
          scopes: ['project:{project_id}'],
        },
      ],
    },
  });
  t.scopes.value = { project_id: ['p1'] };
  const unit = { project_id: 'p1' };
  const replica = new TestReplica().register(unit);
  // Every covered table delivers a segment, an empty one included.
  const empty = section(await sync(t, pullFrames([unit])), unit);
  expect(
    inlineSegments(empty.body).map((f) => decodeRowsSegment(f.payload).table),
  ).toEqual(['tasks', 'notes']);

  for (let i = 1; i <= 3; i++) await seedTask(t, `c${i}`, `t${i}`, 'p1');
  await sync(t, [
    pushCommit('n', [
      upsert('notes', 'n1', encodeSparseRow(noteColumns, 0, ['n1', 'p1'])),
    ]),
  ]);
  const page = { limitSnapshotRows: 2, maxSnapshotPages: 2 };
  const first = section(await replica.pull(t, page), unit);
  expect(
    inlineSegments(first.body).map((f) =>
      decodeRowsSegment(f.payload)
        .blocks.flat()
        .map((row) => row.values[0]),
    ),
  ).toEqual([['t1', 't2'], ['t3']]);
  expect(JSON.parse(first.end.bootstrapState ?? '')).toEqual({
    asOfCommitSeq: 4,
    tables: ['tasks', 'notes'],
    tableIndex: 1,
    rowCursor: null,
  });
  const second = section(await replica.pull(t, page), unit);
  expect(
    inlineSegments(second.body).map((f) => decodeRowsSegment(f.payload).table),
  ).toEqual(['notes']);
  expect(second.end).toEqual({ type: 'SUB_END', nextCursor: 4 });
  expect(replica.idle).toBe(true);
  // A token whose tables differ from the covered tables restarts (§4.7).
  const restarted = section(
    await sync(
      t,
      pullFrames([unit], {
        progress: [
          progressFrame(
            unit,
            4,
            JSON.stringify({
              asOfCommitSeq: 4,
              tables: ['tasks'],
              tableIndex: 0,
              rowCursor: null,
            }),
          ),
        ],
      }),
    ),
    unit,
  );
  expect(
    inlineSegments(restarted.body).map(
      (f) => decodeRowsSegment(f.payload).table,
    ),
  ).toEqual(['tasks', 'notes']);
});

describe('segment delivery negotiation (§4.2, §5.4, §5.7)', () => {
  test('segments above the inline threshold become SEGMENT_REFs', async () => {
    const t = makeContext({ limits: { inlineSegmentMaxBytes: 1 } });
    await seedTask(t, 'c1', 't1', 'p1');
    const message = await sync(t, [...pullFrames([{ project_id: 'p1' }])]);
    const s = section(message, { project_id: 'p1' });
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
      ...pullFrames([{ project_id: 'p1' }], { accept: 0b0001 }),
    ]);
    const s = section(message, { project_id: 'p1' });
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
      ...pullFrames([{ project_id: 'p1' }], { accept: 0b1011 }),
    ]);
    const ref = refSegments(section(message, { project_id: 'p1' }).body)[0];
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

  test('a malformed token is sync.forbidden, never a decode exception', async () => {
    for (const token of ['%%%.@@@', 'a.b!', '.', 'no-dot']) {
      await expect(
        verifySegmentToken('key', token, {
          segmentId: `sha256:${'a'.repeat(64)}`,
          scopeDigest: 'digest-a',
          audience: 'aud-part-1',
          nowMs: 1_750_000_000_000,
        }),
      ).rejects.toMatchObject({ code: 'sync.forbidden' });
    }
  });

  test('a token verifies against any digest in the record set (§5.4)', async () => {
    const key = 'set-signing-key';
    const segmentId = `sha256:${'a'.repeat(64)}`;
    const issue = await issueSegmentUrl(
      {
        key,
        baseUrl: 'https://cdn.example/segments',
        ttlSeconds: 600,
        audience: (partition) => `aud-${partition}`,
      },
      {
        segmentId,
        partition: 'part-1',
        scopeDigest: 'digest-a',
        nowMs: 1_750_000_000_000,
      },
    );
    const token = new URL(issue.url).searchParams.get('st');
    if (token === null) throw new Error('missing st token');
    // The stored entry merged a second scope, so 'digest-a' is not primary.
    await expect(
      verifySegmentToken(key, token, {
        segmentId,
        scopeDigest: ['digest-b', 'digest-a'],
        audience: 'aud-part-1',
        nowMs: 1_750_000_000_000,
      }),
    ).resolves.toMatchObject({ sd: 'digest-a' });
    // The single-string shape keeps working.
    await expect(
      verifySegmentToken(key, token, {
        segmentId,
        scopeDigest: 'digest-a',
        audience: 'aud-part-1',
        nowMs: 1_750_000_000_000,
      }),
    ).resolves.toMatchObject({ sd: 'digest-a' });
    // An unrelated digest set is still forbidden.
    await expect(
      verifySegmentToken(key, token, {
        segmentId,
        scopeDigest: ['digest-b', 'digest-c'],
        audience: 'aud-part-1',
        nowMs: 1_750_000_000_000,
      }),
    ).rejects.toMatchObject({ code: 'sync.forbidden' });
  });

  test('a reused descriptor reports the caller digest, not the record primary', async () => {
    const key = 'frame-signing-key';
    const t = makeContext({
      signedUrls: {
        key,
        baseUrl: 'https://cdn.example/segments',
        ttlSeconds: 600,
        audience: (partition) => `aud-${partition}`,
      },
    });
    const callerDigest = await scopeDigest({ project_id: ['p1'] });
    // Two rows in scope put the snapshot past one rows page, which is the
    // §5.3 condition for consulting the store at all.
    await seedTask(t, 'seed-1', 't1', 'p1', 'one');
    const pin = await seedTask(t, 'seed-2', 't2', 'p1', 'two');
    // Two byte-identical sqlite publications merge into one entry under
    // different digests; the second digest becomes the record's primary.
    const bytes = new Uint8Array([1, 2, 3]);
    const meta = {
      partition: 'part-1',
      logEpoch: TEST_LOG_EPOCH,
      table: 'tasks',
      schemaVersion: 1,
      mediaType: 'sqlite' as const,
      asOfCommitSeq: pin,
      rowCount: 2,
      rowCursor: null,
      nextRowCursor: null,
    };
    await t.segments.put(
      { ...meta, scopeDigest: callerDigest },
      bytes,
      t.now.ms,
    );
    const record = await t.segments.put(
      { ...meta, scopeDigest: 'other-digest' },
      bytes,
      t.now.ms,
    );
    expect(record.scopeDigest).toBe('other-digest');
    expect(record.scopeDigests).toEqual(['other-digest', callerDigest]);

    const message = await sync(t, [
      ...pullFrames([{ project_id: 'p1' }], {
        accept: 0b1101,
        limitSnapshotRows: 1,
      }),
    ]);
    const ref = refSegments(section(message, { project_id: 'p1' }).body)[0];
    if (ref === undefined) throw new Error('expected SEGMENT_REF');
    expect(ref.segmentId).toBe(record.segmentId);
    // The frame and its signed URL carry the caller's digest.
    expect(ref.scopeDigest).toBe(callerDigest);
    const token = new URL(ref.url ?? '').searchParams.get('st');
    if (token === null) throw new Error('missing st token');
    await expect(
      verifySegmentToken(key, token, {
        segmentId: ref.segmentId,
        scopeDigest: record.scopeDigests,
        audience: 'aud-part-1',
        nowMs: t.now.ms,
      }),
    ).resolves.toMatchObject({ sd: callerDigest });
  });

  test('a token is bound to its partition publication, not the content union (§5.4)', async () => {
    const key = 'cross-partition-signing-key';
    const store = new MemorySegmentStore();
    const bytes = new Uint8Array([1, 2, 3]);
    const meta = {
      logEpoch: TEST_LOG_EPOCH,
      table: 'tasks',
      schemaVersion: 1,
      mediaType: 'rows' as const,
      asOfCommitSeq: 0,
      rowCount: 0,
      rowCursor: null,
      nextRowCursor: null,
    };
    await store.put(
      { ...meta, partition: 'part-1', scopeDigest: 'digest-a' },
      bytes,
      1_750_000_000_000,
    );
    await store.put(
      { ...meta, partition: 'part-2', scopeDigest: 'digest-b' },
      bytes,
      1_750_000_000_000,
    );
    const entry = await store.get(await segmentIdFor(bytes));
    if (entry === undefined) throw new Error('expected a stored segment');
    const digestsFor = (partition: string): string[] =>
      entry.record.publications
        .filter((publication) => publication.partition === partition)
        .map((publication) => publication.scopeDigest);
    const issue = await issueSegmentUrl(
      {
        key,
        baseUrl: 'https://cdn.example/segments',
        ttlSeconds: 600,
        audience: (partition) => `aud-${partition}`,
      },
      {
        segmentId: entry.record.segmentId,
        partition: 'part-1',
        scopeDigest: 'digest-a',
        nowMs: 1_750_000_000_000,
      },
    );
    const token = new URL(issue.url).searchParams.get('st');
    if (token === null) throw new Error('missing st token');
    await expect(
      verifySegmentToken(key, token, {
        segmentId: entry.record.segmentId,
        scopeDigest: digestsFor('part-1'),
        audience: 'aud-part-1',
        nowMs: 1_750_000_000_000,
      }),
    ).resolves.toMatchObject({ sd: 'digest-a' });
    // The same content address under another partition is not this host's
    // grant: the verifier must select the publication matching its context.
    await expect(
      verifySegmentToken(key, token, {
        segmentId: entry.record.segmentId,
        scopeDigest: digestsFor('part-2'),
        audience: 'aud-part-2',
        nowMs: 1_750_000_000_000,
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
            payload: encodeRow(TASK_COLUMNS, [
              rowId,
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
      ...pullFrames([{ project_id: 'p1' }], {
        accept: 0b1111,
        limitSnapshotRows: 1000,
      }),
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
      (response) =>
        refSegments(section(response, { project_id: 'p1' }).body)[0]!,
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
      ...pullFrames([{ project_id: 'p1' }], {
        accept: 0b0111,
        limitSnapshotRows: 1,
      }),
    ];
    await expect(sync(t, frames())).rejects.toThrow('injected build failure');
    const retried = await sync(t, frames());
    expect(
      refSegments(section(retried, { project_id: 'p1' }).body),
    ).toHaveLength(1);
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
      // The §4.7 scope pin: the newest change to this project at or
      // below the round's maxCommitSeq (part-2 holds rows but no commits).
      asOf: 2,
      partition: 'part-1',
      epoch: 'epoch1',
      pin: 4,
      project: 'p1',
      version: 1,
      segments: t.segments,
    },
    {
      asOf: 0,
      partition: 'part-2',
      epoch: 'epoch1',
      pin: 4,
      project: 'p1',
      version: 1,
      segments: t.segments,
    },
    {
      asOf: 2,
      partition: 'part-1',
      epoch: 'epoch2',
      pin: 4,
      project: 'p1',
      version: 1,
      segments: t.segments,
    },
    {
      asOf: 1,
      partition: 'part-1',
      epoch: 'epoch1',
      pin: 1,
      project: 'p1',
      version: 1,
      segments: t.segments,
    },
    {
      asOf: 4,
      partition: 'part-1',
      epoch: 'epoch1',
      pin: 4,
      project: 'p2',
      version: 1,
      segments: t.segments,
    },
    {
      asOf: 2,
      partition: 'part-1',
      epoch: 'epoch1',
      pin: 4,
      project: 'p1',
      version: 2,
      segments: t.segments,
    },
    {
      asOf: 2,
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
      const ctx = {
        ...t.ctx,
        partition: variant.partition,
        segments: variant.segments,
      };
      const limits = {
        accept: 7,
        limitSnapshotRows: 1,
        maxSnapshotPages: 1,
        limitCommits: 1000,
      };
      const unit = planUnit(
        { project_id: variant.project },
        [schema.tables.get('tasks')!],
        { ok: true, allowed: { project_id: ['*'] } },
      );
      const stream = bootstrapSegments(
        ctx,
        schema,
        limits,
        planBootstrap(
          ctx,
          schema,
          limits,
          unit,
          undefined,
          variant.pin,
          0,
          variant.epoch,
        ),
        undefined,
        variant.epoch,
      );
      const refs = [];
      for await (const frame of stream)
        if (frame.type === 'SEGMENT_REF') refs.push(frame);
      expect(refs).toHaveLength(1);
      expect(refs[0]?.asOfCommitSeq).toBe(variant.asOf);
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

test('returning one bootstrap stream does not cancel a build awaited by another', async () => {
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
  const limits = {
    accept: 7,
    limitSnapshotRows: 1,
    maxSnapshotPages: 1,
    limitCommits: 1000,
  };
  const unit = planUnit({ project_id: 'p1' }, [schema.tables.get('tasks')!], {
    ok: true,
    allowed: { project_id: ['p1'] },
  });
  const streams = [0, 1].map(() =>
    bootstrapSegments(
      t.ctx,
      schema,
      limits,
      planBootstrap(t.ctx, schema, limits, unit, undefined, 2, 0, 'epoch'),
      undefined,
      'epoch',
    ),
  );
  const first = streams[0]!.next();
  const second = streams[1]!.next();
  await building;
  const cancelled = streams[0]!.return(undefined);
  release();
  await first;
  await cancelled;
  expect((await second).value).toMatchObject({
    type: 'SEGMENT_REF',
    mediaType: 'sqlite',
    rowCount: 2,
  });
  expect(builds).toBe(1);
  await streams[1]!.return(undefined);
  t.storage.db.close();
});

test('a stored image survives commits outside its scope (§4.7 scope pin)', async () => {
  let builds = 0;
  const served: SyncularServerEvent[] = [];
  const t = makeContext({
    sqliteImageBuilder: async (input) => {
      builds += 1;
      return buildSqliteImage(input);
    },
    events: { emit: (event) => served.push(event) },
  });
  t.scopes.value = {
    project_id: ['p1', 'p2'],
    org_id: ['o1'],
    projectId: ['p1'],
  };
  await seedTask(t, 'one', 'r1', 'p1');
  const pin = await seedTask(t, 'two', 'r2', 'p1');
  const bootstrap = (clientId: string) =>
    sync(
      t,
      [
        ...pullFrames([{ project_id: 'p1' }], {
          accept: 0b0111,
          limitSnapshotRows: 1,
        }),
      ],
      { clientId },
    );
  const origins = () =>
    served.flatMap((event) =>
      event.type === 'pull.served'
        ? event.units.flatMap((unit) =>
            unit.segments.map((segment) => segment.origin),
          )
        : [],
    );
  const first = section(await bootstrap('client-a'), { project_id: 'p1' });
  const firstRef = refSegments(first.body)[0];
  expect(firstRef?.asOfCommitSeq).toBe(pin);
  expect(first.end.nextCursor).toBe(pin);
  expect(origins()).toEqual(['built']);

  // An unrelated table and another project of the same table move
  // maxCommitSeq, but no change reaches the p1 scope.
  await sync(t, [
    pushCommit('doc', [upsert('docs', 'd1', docRow('d1', 'o1', 'p1'))]),
  ]);
  const other = await seedTask(t, 'three', 'r3', 'p2');
  expect(other).toBeGreaterThan(pin);

  served.length = 0;
  const reply = await bootstrap('client-b');
  const second = section(reply, { project_id: 'p1' });
  expect(refSegments(second.body)[0]?.segmentId).toBe(firstRef?.segmentId);
  expect(refSegments(second.body)[0]?.asOfCommitSeq).toBe(pin);
  // The unit pins at maxCommitSeq; the image keeps its scope pin (§4.7).
  expect(second.end.nextCursor).toBe(other);
  expect(origins()).toEqual(['reused']);
  expect(builds).toBe(1);
  // The window (scope pin, maxCommitSeq] holds no change for the scope.
  expect(live(reply).commits).toEqual([]);
  expect(live(reply).end.throughSeq).toBe(other);

  // A change inside the scope moves the pin, so the next bootstrap builds.
  const moved = await seedTask(t, 'four', 'r4', 'p1');
  const third = section(await bootstrap('client-c'), { project_id: 'p1' });
  expect(refSegments(third.body)[0]?.asOfCommitSeq).toBe(moved);
  expect(builds).toBe(2);
  t.storage.db.close();
});

describe('the bootstrap decision (§4.7)', () => {
  /** t1, t2 in p1 (seq 1, 2) and t3 in p2 (seq 3). */
  async function seeded() {
    const t = makeContext();
    t.scopes.value = { project_id: ['p1', 'p2'] };
    await seedTask(t, 'c1', 't1', 'p1');
    await seedTask(t, 'c2', 't2', 'p1');
    await seedTask(t, 'c3', 't3', 'p2');
    return t;
  }

  function inlineRowIds(body: { type: string }[]): unknown[] {
    return inlineSegments(body)
      .flatMap((f) => decodeRowsSegment(f.payload).blocks.flat())
      .map((row) => row.values[0]);
  }

  test('a resume token outside the log or with a bad position restarts from a fresh pin', async () => {
    const t = await seeded();
    const token = (fields: Record<string, unknown>) =>
      JSON.stringify({
        asOfCommitSeq: 2,
        tables: ['tasks'],
        tableIndex: 0,
        rowCursor: 't1',
        ...fields,
      });
    for (const forged of [
      token({ asOfCommitSeq: 999 }),
      token({ asOfCommitSeq: 1.5 }),
      token({ asOfCommitSeq: -1 }),
      token({ tableIndex: 0.5 }),
      token({ tableIndex: 1 }),
    ]) {
      const s = section(
        await sync(t, [
          ...pullFrames([{ project_id: 'p1' }], {
            progress: [progressFrame({ project_id: 'p1' }, 2, forged)],
          }),
        ]),
        { project_id: 'p1' },
      );
      expect(s.start.bootstrap).toBe(true);
      expect(s.end.nextCursor).toBe(3);
      expect(inlineRowIds(s.body)).toEqual(['t1', 't2']);
    }
    // A usable token still resumes after its row cursor at its pin.
    const resumed = section(
      await sync(t, [
        ...pullFrames([{ project_id: 'p1' }], {
          progress: [progressFrame({ project_id: 'p1' }, 2, token({}))],
        }),
      ]),
      { project_id: 'p1' },
    );
    expect(resumed.end.nextCursor).toBe(2);
    expect(inlineRowIds(resumed.body)).toEqual(['t2']);
  });

  test('the sqlite image reuse key is the server pin, never a client token', async () => {
    const t = await seeded();
    const s = section(
      await sync(t, [
        ...pullFrames([{ project_id: 'p1' }], {
          accept: 0b0111,
          limitSnapshotRows: 1,
          progress: [
            progressFrame(
              { project_id: 'p1' },
              1,
              JSON.stringify({
                asOfCommitSeq: 1,
                tables: ['tasks'],
                tableIndex: 0,
                rowCursor: null,
              }),
            ),
          ],
        }),
      ]),
      { project_id: 'p1' },
    );
    // The image is served at p1's scope pin, its newest change at seq 2;
    // the unit keeps the token's pin (§4.7).
    const image = refSegments(s.body)[0];
    expect(image?.mediaType).toBe('sqlite');
    expect(image?.asOfCommitSeq).toBe(2);
    expect(s.end.nextCursor).toBe(1);
  });

  test('a present token of the wrong shape bootstraps even with an in-range cursor', async () => {
    const t = await seeded();
    const s = section(
      await sync(t, [
        ...pullFrames([{ project_id: 'p1' }], {
          progress: [
            progressFrame(
              { project_id: 'p1' },
              1,
              JSON.stringify({ resume: 'elsewhere' }),
            ),
          ],
        }),
      ]),
      { project_id: 'p1' },
    );
    expect(s.start.bootstrap).toBe(true);
    expect(inlineRowIds(s.body)).toEqual(['t1', 't2']);
    expect(s.end.nextCursor).toBe(3);
    expect(s.end.bootstrapState).toBeUndefined();
  });

  test('a rejecting first-page read fails the request once, with no unhandled rejection', async () => {
    // bun:test fails a test in which any promise rejects unhandled.
    const t = await seeded();
    const failing = new Proxy(t.storage, {
      get(target, property) {
        if (property === 'scanRows') {
          return () => Promise.reject(new Error('scan failed'));
        }
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    Object.assign(t.ctx, { storage: failing });
    await expect(
      sync(t, [
        ...pullFrames([{ project_id: 'p1' }, { project_id: 'p2' }], {
          accept: 0b0111,
          limitSnapshotRows: 1,
        }),
      ]),
    ).rejects.toThrow('scan failed');
  });

  test('first pages are read in windows bounded by rows, not by unit count', async () => {
    const t = await seeded();
    let inFlight = 0;
    let peak = 0;
    const counting = new Proxy(t.storage, {
      get(target, property) {
        if (property === 'scanRows') {
          return async (
            ...args: Parameters<typeof target.scanRows>
          ): ReturnType<typeof target.scanRows> => {
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            try {
              return await target.scanRows(...args);
            } finally {
              inFlight -= 1;
            }
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    Object.assign(t.ctx, { storage: counting });
    t.scopes.value = { project_id: ['*'] };
    const units = Array.from({ length: 6 }, (_, i) => ({
      project_id: `p${i}`,
    }));
    // Default 1,000-row pages: all six first pages share one window.
    await sync(t, pullFrames(units));
    expect(peak).toBe(6);
    // Maximal 50,000-row pages: one first page at a time.
    peak = 0;
    const message = await sync(
      t,
      pullFrames(units, { limitSnapshotRows: 50_000 }),
    );
    expect(peak).toBe(1);
    expect(sections(message).size).toBe(6);
  });
});
