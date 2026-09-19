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

  test('identical empty segments across partitions lose the earlier download (open defect)', async () => {
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
    // publications are one content address with two scope digests.
    expect(firstRef.segmentId).toBe(secondRef.segmentId);
    const stored = await segments.get(firstRef.segmentId);
    expect(stored?.record.scopeDigests).toHaveLength(2);
    // OPEN DEFECT (SYNCULAR-SEGMENT-PARTITION-001), pinned as evidence and
    // NOT claimed fixed: the merged entry carries the LATEST publisher's
    // partition, and §5.5 refuses a download whose partition differs (no
    // existence leak), so the first partition cannot download its own
    // descriptor even though its digest is recorded. The digest union is
    // correct and does not address this: the entry needs per-publication
    // provenance, or per-publication records keyed by (segmentId, scope
    // digest, partition, logEpoch).
    await expect(
      handleSegmentDownload(first.ctx, {
        segmentId: firstRef.segmentId,
        scopesHeader: canonicalScopeJson(emptyFirst),
      }),
    ).rejects.toMatchObject({ code: 'sync.not_found' });
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
