/**
 * Bootstrap: inline rows segments, paging, resumable bootstrapState,
 * pinning (SPEC.md §4.7, §5) — driven through bytes.
 */
import { describe, expect, test } from 'bun:test';
import {
  decodeRowsSegment,
  type SegmentInlineFrame,
  type SegmentRefFrame,
} from '@syncular-v2/core';
import { verifySegmentToken } from '@syncular-v2/server';
import {
  makeContext,
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
    expect(rows.map((r) => r[0])).toEqual(['t1', 't2']); // p2 row excluded
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
    expect(seg1.blocks.flat().map((r) => r[0])).toEqual(['t1', 't2']);
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
    expect(seg2.blocks.flat().map((r) => r[0])).toEqual(['t3', 't4']);
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
    expect(segment.blocks.flat().map((r) => r[0])).toEqual(['t1', 't2']);
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
