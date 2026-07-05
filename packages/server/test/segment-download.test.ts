/**
 * Direct segment download re-authorization (SPEC.md §5.5) and expiry.
 */
import { describe, expect, test } from 'bun:test';
import {
  canonicalScopeJson,
  decodeRowsSegment,
  type SegmentRefFrame,
} from '@syncular/core';
import { handleSegmentDownload } from '@syncular/server';
import {
  makeContext,
  pullHeader,
  section,
  seedTask,
  subFrame,
  sync,
  type TestContext,
} from './helpers';

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
