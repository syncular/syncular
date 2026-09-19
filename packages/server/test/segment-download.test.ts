/**
 * Direct segment download re-authorization (SPEC.md §5.5) and expiry.
 */
import { describe, expect, test } from 'bun:test';
import {
  canonicalScopeJson,
  decodeRowsSegment,
  type ResponseMessage,
  type SegmentRefFrame,
} from '@syncular/core';
import {
  handleSegmentDownload,
  MemorySegmentStore,
  scopeDigest,
  type SegmentStore,
  SqliteSegmentStore,
} from '@syncular/server';
import {
  docRow,
  makeContext,
  pullHeader,
  pushCommit,
  section,
  seedTask,
  subFrame,
  sync,
  type TestContext,
  TEST_LOG_EPOCH,
  upsert,
} from './helpers';

function refOf(message: ResponseMessage, id: string): SegmentRefFrame {
  const ref = section(message, id).body.find(
    (f): f is SegmentRefFrame => f.type === 'SEGMENT_REF',
  );
  if (ref === undefined) throw new Error(`expected SEGMENT_REF for ${id}`);
  return ref;
}

async function bootstrapRef(t: TestContext): Promise<SegmentRefFrame> {
  await seedTask(t, 'seed', 't1', 'p1');
  const message = await sync(t, [
    pullHeader(),
    subFrame('s1', 'tasks', { project_id: ['p1'] }, -1),
  ]);
  const ref = section(message, 's1').body.find(
    (f): f is SegmentRefFrame => f.type === 'SEGMENT_REF',
  );
  if (ref === undefined) throw new Error('expected SEGMENT_REF');
  return ref;
}

describe('segment download (§5.5)', () => {
  test('re-authorizes and serves matching scopes with §5.5 headers', async () => {
    const t = makeContext({ limits: { inlineSegmentMaxBytes: 1 } });
    const ref = await bootstrapRef(t);
    const result = await handleSegmentDownload(t.ctx, {
      segmentId: ref.segmentId,
      scopesHeader: canonicalScopeJson({ project_id: ['p1'] }),
    });
    expect(result.record.segmentId).toBe(ref.segmentId);
    expect(result.headers.ETag).toBe(`"${ref.segmentId}"`);
    expect(result.headers['Cache-Control']).toBe('private, max-age=0');
    const segment = decodeRowsSegment(result.bytes);
    expect(segment.table).toBe('tasks');
    expect(segment.blocks.flat()).toHaveLength(1);
  });

  test('a scope-digest mismatch is forbidden — a ref is not a bearer capability', async () => {
    const t = makeContext({ limits: { inlineSegmentMaxBytes: 1 } });
    const ref = await bootstrapRef(t);
    t.scopes.value = { project_id: ['p1', 'p2'] };
    await expect(
      handleSegmentDownload(t.ctx, {
        segmentId: ref.segmentId,
        scopesHeader: canonicalScopeJson({ project_id: ['p1', 'p2'] }),
      }),
    ).rejects.toMatchObject({ code: 'sync.forbidden' });
  });

  test('revoked scopes at download time are forbidden (§3.2 rule 5)', async () => {
    const t = makeContext({ limits: { inlineSegmentMaxBytes: 1 } });
    const ref = await bootstrapRef(t);
    t.scopes.value = { org_id: ['o1'] }; // project access revoked
    await expect(
      handleSegmentDownload(t.ctx, {
        segmentId: ref.segmentId,
        scopesHeader: canonicalScopeJson({ project_id: ['p1'] }),
      }),
    ).rejects.toMatchObject({ code: 'sync.forbidden' });
  });

  test('a throwing resolver at download time is forbidden', async () => {
    const t = makeContext({ limits: { inlineSegmentMaxBytes: 1 } });
    const ref = await bootstrapRef(t);
    t.scopes.error = true;
    await expect(
      handleSegmentDownload(t.ctx, {
        segmentId: ref.segmentId,
        scopesHeader: canonicalScopeJson({ project_id: ['p1'] }),
      }),
    ).rejects.toMatchObject({ code: 'sync.forbidden' });
  });

  test('unknown segments are sync.not_found', async () => {
    const t = makeContext();
    await expect(
      handleSegmentDownload(t.ctx, {
        segmentId:
          'sha256:0000000000000000000000000000000000000000000000000000000000000000',
        scopesHeader: canonicalScopeJson({ project_id: ['p1'] }),
      }),
    ).rejects.toMatchObject({ code: 'sync.not_found' });
  });

  test('segments from another partition are sync.not_found (no existence leak)', async () => {
    const t = makeContext({ limits: { inlineSegmentMaxBytes: 1 } });
    const ref = await bootstrapRef(t);
    const otherPartition = { ...t.ctx, partition: 'part-2' };
    await expect(
      handleSegmentDownload(otherPartition, {
        segmentId: ref.segmentId,
        scopesHeader: canonicalScopeJson({ project_id: ['p1'] }),
      }),
    ).rejects.toMatchObject({ code: 'sync.not_found' });
  });

  test('identical empty segments from two partitions both download', async () => {
    const segments = new MemorySegmentStore();
    const emptyFirst = { project_id: ['p-empty-a'] };
    const emptySecond = { project_id: ['p-empty-b'] };
    const first = makeContext({
      segments,
      limits: { inlineSegmentMaxBytes: 1 },
    });
    const second = makeContext({
      segments,
      partition: 'part-2',
      limits: { inlineSegmentMaxBytes: 1 },
    });
    first.scopes.value = emptyFirst;
    second.scopes.value = emptySecond;
    const refOfPull = async (
      t: TestContext,
      scopes: Record<string, string[]>,
    ): Promise<SegmentRefFrame> => {
      const message = await sync(t, [
        pullHeader(),
        subFrame('s1', 'tasks', scopes, -1),
      ]);
      return refOf(message, 's1');
    };
    const firstRef = await refOfPull(first, emptyFirst);
    const secondRef = await refOfPull(second, emptySecond);
    // No rows in scope: both partitions encode the same bytes, so both
    // publications are one content address — but each partition keeps its
    // own grant.
    expect(firstRef.segmentId).toBe(secondRef.segmentId);
    const stored = await segments.get(firstRef.segmentId);
    expect(stored?.record.publications).toHaveLength(2);
    expect(stored?.record.scopeDigests).toHaveLength(2);

    const firstResult = await handleSegmentDownload(first.ctx, {
      segmentId: firstRef.segmentId,
      scopesHeader: canonicalScopeJson(emptyFirst),
    });
    const secondResult = await handleSegmentDownload(second.ctx, {
      segmentId: secondRef.segmentId,
      scopesHeader: canonicalScopeJson(emptySecond),
    });
    expect(decodeRowsSegment(firstResult.bytes).blocks.flat()).toHaveLength(0);
    expect(firstResult.bytes).toEqual(secondResult.bytes);
    // The returned record is projected onto the caller's publication.
    expect(firstResult.record.partition).toBe('part-1');
    expect(firstResult.record.scopeDigests).toEqual([firstRef.scopeDigest]);
    expect(secondResult.record.partition).toBe('part-2');
    expect(secondResult.record.scopeDigests).toEqual([secondRef.scopeDigest]);
  });

  test('a rotated log epoch denies the descriptor minted under the old one', async () => {
    const t = makeContext({ limits: { inlineSegmentMaxBytes: 1 } });
    const ref = await bootstrapRef(t);
    await t.storage.rotatePartitionLogEpoch(
      t.ctx.partition,
      'rotated-epoch',
      t.now.ms,
    );
    await expect(
      handleSegmentDownload(t.ctx, {
        segmentId: ref.segmentId,
        scopesHeader: canonicalScopeJson({ project_id: ['p1'] }),
      }),
    ).rejects.toMatchObject({ code: 'sync.not_found' });
  });

  test('a different actor without the publishing scope is forbidden', async () => {
    const t = makeContext({ limits: { inlineSegmentMaxBytes: 1 } });
    const ref = await bootstrapRef(t);
    t.scopes.value = { project_id: ['p2'] };
    await expect(
      handleSegmentDownload(t.ctx, {
        segmentId: ref.segmentId,
        scopesHeader: canonicalScopeJson({ project_id: ['p2'] }),
      }),
    ).rejects.toMatchObject({ code: 'sync.forbidden' });
  });

  test('a newer publication for another table does not hide the valid one', async () => {
    const t = makeContext({ limits: { inlineSegmentMaxBytes: 1 } });
    const digest = await scopeDigest({ project_id: ['p1'] });
    const bytes = new Uint8Array([9, 9, 9]);
    const meta = {
      partition: t.ctx.partition,
      logEpoch: TEST_LOG_EPOCH,
      schemaVersion: 1,
      mediaType: 'rows' as const,
      scopeDigest: digest,
      asOfCommitSeq: 0,
      rowCount: 0,
      rowCursor: null,
      nextRowCursor: null,
    };
    // Synthetic same-bytes record: the in-tree encoders put the table name in
    // the segment bytes, so this shape is reachable only from a malformed or
    // custom store entry. The newer publication (docs) does not declare
    // project_id; the earlier valid one (tasks) does.
    await t.segments.put({ ...meta, table: 'tasks' }, bytes, t.now.ms);
    const newest = await t.segments.put(
      { ...meta, table: 'docs' },
      bytes,
      t.now.ms + 1,
    );
    const result = await handleSegmentDownload(t.ctx, {
      segmentId: newest.segmentId,
      scopesHeader: canonicalScopeJson({ project_id: ['p1'] }),
    });
    expect(result.record.table).toBe('tasks');
    expect(result.record.scopeDigests).toEqual([digest]);
  });

  test('an expired pin does not shadow a live publication of the same bytes (§5.1)', async () => {
    const t = makeContext({ limits: { inlineSegmentMaxBytes: 1 } });
    const scopes = { project_id: ['p-none'] };
    // p-none drives the empty bootstrap; p1/o1 let the intervening commit
    // advance the pin without landing in that scope.
    t.scopes.value = {
      project_id: ['p-none'],
      projectId: ['p1'],
      org_id: ['o1'],
    };
    const pullEmpty = async (): Promise<SegmentRefFrame> => {
      const message = await sync(t, [
        pullHeader(),
        subFrame('s1', 'tasks', scopes, -1),
      ]);
      return refOf(message, 's1');
    };
    const firstRef = await pullEmpty();
    await sync(t, [
      pushCommit('c1', [upsert('docs', 'd1', docRow('d1', 'o1', 'p1'))]),
    ]);
    t.now.ms += 60 * 60 * 1000;
    const secondRef = await pullEmpty();
    expect(secondRef.segmentId).toBe(firstRef.segmentId);
    const stored = await t.ctx.segments.get(firstRef.segmentId);
    expect(stored?.record.publications).toHaveLength(2);
    const firstExpiry = stored?.record.publications[0]?.expiresAtMs;
    const secondExpiry = stored?.record.publications[1]?.expiresAtMs;
    expect(secondExpiry).toBeGreaterThan(firstExpiry ?? 0);

    // Past the first pin's 24 h TTL, inside the second's: the download
    // selects the live publication, not the expired first one.
    t.now.ms = (firstExpiry ?? 0) + 1;
    const result = await handleSegmentDownload(t.ctx, {
      segmentId: firstRef.segmentId,
      scopesHeader: canonicalScopeJson(scopes),
    });
    expect(result.record.asOfCommitSeq).toBe(secondRef.asOfCommitSeq);

    // An unrelated refresh is a NEW publication context. Prune-on-put forgets
    // the elapsed pin (SPEC §5.5 lets the cache forget expired grants), so no
    // stored publication carries its expiry any more; the still-live grant is
    // retained with its own expiry and is NOT extended by the unrelated
    // refresh.
    await sync(t, [
      pushCommit('c2', [upsert('docs', 'd2', docRow('d2', 'o1', 'p1'))]),
    ]);
    const thirdRef = await pullEmpty();
    const after = await t.ctx.segments.get(firstRef.segmentId);
    expect(
      after?.record.publications.some(
        (publication) => publication.expiresAtMs === firstExpiry,
      ),
    ).toBe(false);
    const liveAfter = after?.record.publications.find(
      (publication) => publication.asOfCommitSeq === secondRef.asOfCommitSeq,
    );
    expect(liveAfter?.expiresAtMs).toBe(secondExpiry);

    // The live grant for this context is still downloadable after the prune.
    const refreshed = await handleSegmentDownload(t.ctx, {
      segmentId: firstRef.segmentId,
      scopesHeader: canonicalScopeJson(scopes),
    });
    expect(refreshed.record.asOfCommitSeq).toBe(thirdRef.asOfCommitSeq);
  });

  test('expired segments are sync.segment_expired (retryable, §5.1)', async () => {
    const t = makeContext({ limits: { inlineSegmentMaxBytes: 1 } });
    const ref = await bootstrapRef(t);
    t.now.ms += 25 * 60 * 60 * 1000; // past the 24 h TTL
    await expect(
      handleSegmentDownload(t.ctx, {
        segmentId: ref.segmentId,
        scopesHeader: canonicalScopeJson({ project_id: ['p1'] }),
      }),
    ).rejects.toMatchObject({ code: 'sync.segment_expired', retryable: true });
  });
});

/**
 * Two scopes whose rows are byte-identical produce one content address
 * (§5.1). The store keeps every digest published for that content, so both
 * subscriptions download successfully (§5.5) and a third digest stays
 * forbidden.
 */
describe('byte-identical segments across scopes (§5.1, §5.5)', () => {
  const stores: ReadonlyArray<readonly [string, () => SegmentStore]> = [
    ['memory', () => new MemorySegmentStore()],
    ['sqlite', () => new SqliteSegmentStore()],
  ];

  for (const [name, makeSegments] of stores) {
    test(`${name}: identical non-empty rows under two scopes both download`, async () => {
      const t = makeContext({
        segments: makeSegments(),
        limits: { inlineSegmentMaxBytes: 1 },
      });
      await sync(t, [
        pushCommit('c1', [upsert('docs', 'd1', docRow('d1', 'o1', 'p1'))]),
      ]);
      const message = await sync(t, [
        pullHeader(),
        subFrame('s-org', 'docs', { org_id: ['o1'] }, -1),
        subFrame('s-project', 'docs', { projectId: ['p1'] }, -1),
      ]);
      const orgRef = refOf(message, 's-org');
      const projectRef = refOf(message, 's-project');
      // Different scopes, one content address: the digests differ.
      expect(orgRef.scopeDigest).not.toBe(projectRef.scopeDigest);
      expect(projectRef.segmentId).toBe(orgRef.segmentId);

      const org = await handleSegmentDownload(t.ctx, {
        segmentId: orgRef.segmentId,
        scopesHeader: canonicalScopeJson({ org_id: ['o1'] }),
      });
      const project = await handleSegmentDownload(t.ctx, {
        segmentId: projectRef.segmentId,
        scopesHeader: canonicalScopeJson({ projectId: ['p1'] }),
      });
      expect(org.bytes).toEqual(project.bytes);
      expect(decodeRowsSegment(org.bytes).blocks.flat()).toHaveLength(1);
      // Both digests are recorded on the one stored entry.
      expect(
        (await t.ctx.segments.get(orgRef.segmentId))?.record.scopeDigests,
      ).toHaveLength(2);
      // A digest under which the content was never published is still
      // forbidden (§5.5 fail closed).
      await expect(
        handleSegmentDownload(t.ctx, {
          segmentId: orgRef.segmentId,
          scopesHeader: canonicalScopeJson({
            org_id: ['o1'],
            projectId: ['p1'],
          }),
        }),
      ).rejects.toMatchObject({ code: 'sync.forbidden' });
    });

    test(`${name}: identical empty payloads under two scopes both download`, async () => {
      const t = makeContext({
        segments: makeSegments(),
        limits: { inlineSegmentMaxBytes: 1 },
      });
      t.scopes.value = { project_id: ['p1', 'p2'] };
      const message = await sync(t, [
        pullHeader(),
        subFrame('s-p1', 'tasks', { project_id: ['p1'] }, -1),
        subFrame('s-p2', 'tasks', { project_id: ['p2'] }, -1),
      ]);
      const p1Ref = refOf(message, 's-p1');
      const p2Ref = refOf(message, 's-p2');
      expect(p1Ref.scopeDigest).not.toBe(p2Ref.scopeDigest);
      expect(p2Ref.segmentId).toBe(p1Ref.segmentId);

      for (const [id, scope] of [
        [p1Ref, { project_id: ['p1'] }],
        [p2Ref, { project_id: ['p2'] }],
      ] as const) {
        const result = await handleSegmentDownload(t.ctx, {
          segmentId: id.segmentId,
          scopesHeader: canonicalScopeJson(scope),
        });
        expect(decodeRowsSegment(result.bytes).blocks.flat()).toHaveLength(0);
      }
      expect(
        (await t.ctx.segments.get(p1Ref.segmentId))?.record.scopeDigests,
      ).toHaveLength(2);
      await expect(
        handleSegmentDownload(t.ctx, {
          segmentId: p1Ref.segmentId,
          scopesHeader: canonicalScopeJson({ project_id: ['p1', 'p2'] }),
        }),
      ).rejects.toMatchObject({ code: 'sync.forbidden' });
    });
  }
});
