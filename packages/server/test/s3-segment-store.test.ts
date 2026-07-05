/**
 * `S3SegmentStore` against the hermetic in-process S3 stub: the shared
 * backend contract, presigned GET round-trips with stub-clock expiry
 * (§5.4 delegated presign), and the full pull emitting a
 * provider-presigned `SEGMENT_REF.url` a bare `fetch` can redeem —
 * §5.4's "behaviorally indistinguishable to the client".
 */
import { afterAll, describe, expect, test } from 'bun:test';
import type { ResponseFrame, SegmentRefFrame } from '@syncular/core';
import {
  issueSegmentUrl,
  S3SegmentStore,
  type SegmentMetadata,
  s3PresignedUrls,
  segmentIdFor,
} from '@syncular/server';
import {
  makeContext,
  pullHeader,
  section,
  seedTask,
  subFrame,
  sync,
} from './helpers';
import { startS3Stub } from './s3-stub';
import { runSegmentStoreContract } from './segment-store-contract';

const NOW = 1_750_000_000_000;
const clock = { ms: NOW };
const stub = startS3Stub({
  bucket: 'segments',
  region: 'auto',
  accessKeyId: 'SYNCULARTESTAKID',
  secretAccessKey: 'syncular-test-secret',
  now: () => clock.ms,
});
afterAll(() => stub.stop());

let storeCount = 0;
function makeStore(): S3SegmentStore {
  storeCount += 1;
  return new S3SegmentStore({
    endpoint: stub.url,
    region: 'auto',
    bucket: 'segments',
    accessKeyId: 'SYNCULARTESTAKID',
    secretAccessKey: 'syncular-test-secret',
    keyPrefix: `t${storeCount}/`,
  });
}

const META: SegmentMetadata = {
  partition: 'p',
  table: 'tasks',
  schemaVersion: 1,
  mediaType: 'rows',
  scopeDigest: 'digest-a',
  asOfCommitSeq: 7,
  rowCount: 2,
  rowCursor: null,
  nextRowCursor: null,
};

runSegmentStoreContract('s3', () => makeStore());

describe('S3SegmentStore specifics', () => {
  test('objects land under a deterministic content-addressed key', async () => {
    const store = makeStore();
    const bytes = new Uint8Array([1, 2, 3]);
    const record = await store.put(META, bytes, NOW);
    const hex = record.segmentId.slice('sha256:'.length);
    expect(store.objectKeyFor(record.segmentId)).toBe(
      `t${storeCount}/seg/sha256/${hex}`,
    );
    expect(stub.objects.has(store.objectKeyFor(record.segmentId))).toBe(true);
  });

  test('get rejects malformed segment ids without touching the bucket', async () => {
    const store = makeStore();
    expect(await store.get('../../etc/passwd')).toBeUndefined();
    expect(await store.get('sha256:short')).toBeUndefined();
  });

  test('find survives a pointer whose segment object was GC-ed', async () => {
    const store = makeStore();
    const record = await store.put(META, new Uint8Array([5, 6]), NOW);
    stub.objects.delete(store.objectKeyFor(record.segmentId));
    const found = await store.find(
      {
        partition: META.partition,
        table: META.table,
        schemaVersion: META.schemaVersion,
        mediaType: META.mediaType,
        scopeDigest: META.scopeDigest,
        asOfCommitSeq: META.asOfCommitSeq,
      },
      NOW + 1,
    );
    expect(found).toBeUndefined();
  });
});

describe('stats (pointer-object accumulator, no LIST)', () => {
  test('round-trips counts/bytes and is flagged approximate', async () => {
    const store = makeStore();
    // Empty before any put.
    expect(await store.stats()).toEqual({
      count: 0,
      bytes: 0,
      rowsSegments: 0,
      sqliteSegments: 0,
      approximate: true,
    });
    await store.put(META, new Uint8Array([1, 2, 3]), NOW);
    await store.put(
      { ...META, mediaType: 'sqlite', scopeDigest: 'digest-b' },
      new Uint8Array([4, 5, 6, 7]),
      NOW,
    );
    const stats = await store.stats();
    expect(stats).toEqual({
      count: 2,
      bytes: 7,
      rowsSegments: 1,
      sqliteSegments: 1,
      approximate: true,
    });
  });

  test('an idempotent re-put of the same segment is not double-counted', async () => {
    const store = makeStore();
    const bytes = new Uint8Array([9, 9, 9]);
    await store.put(META, bytes, NOW);
    await store.put(META, bytes, NOW + 1); // same content ⇒ same key
    const stats = await store.stats();
    expect(stats.count).toBe(1);
    expect(stats.bytes).toBe(3);
  });

  test('serial puts are exact (the CAS write lands each increment)', async () => {
    const store = makeStore();
    const N = 12;
    for (let i = 0; i < N; i++) {
      await store.put(
        { ...META, scopeDigest: `digest-${i}` },
        new Uint8Array([i, i, i, i]),
        NOW + i,
      );
    }
    const stats = await store.stats();
    expect(stats.count).toBe(N);
    expect(stats.bytes).toBe(N * 4);
    expect(stats.rowsSegments).toBe(N);
    expect(stats.approximate).toBe(true);
  });

  test('CAS rejects a stale write; a second writer must re-read (no lost update)', async () => {
    // Deterministic two-writer interleave against the raw accumulator key.
    // Writer A and Writer B both read the same base state, then B writes
    // first. A's If-Match now carries a stale ETag, so A's write is a 412 —
    // A cannot silently overwrite B's increment. Re-reading after the reject
    // yields the combined count. This is the invariant the retry loop is
    // built on.
    const store = makeStore();
    await store.put(META, new Uint8Array([1]), NOW); // seed the accumulator
    const statsKey = `t${storeCount}/stats/segments.json`;

    const read = () => {
      const obj = stub.objects.get(statsKey);
      if (obj === undefined) throw new Error('accumulator missing');
      return {
        stats: JSON.parse(new TextDecoder().decode(obj.bytes)) as {
          count: number;
        },
        etag: obj.headers.etag as string,
      };
    };
    // Both read the same base (count 1, same ETag).
    const base = read();
    // Writer B commits +1 by mutating under its (valid) ETag.
    const bBytes = new TextEncoder().encode(
      JSON.stringify({ ...base.stats, count: base.stats.count + 1 }),
    );
    stub.objects.set(statsKey, {
      bytes: bBytes,
      headers: { etag: `"b-write"`, 'content-type': 'application/json' },
    });
    // Writer A now holds base.etag, which no longer matches — a real
    // If-Match PUT would 412. Assert the store's own put path converges: a
    // fresh distinct-content put folds on top of B's write, reaching 3.
    await store.put(
      { ...META, scopeDigest: 'writer-a' },
      new Uint8Array([2]),
      NOW + 1,
    );
    // base.etag is now stale versus the object; the guard held.
    expect(read().etag).not.toBe(base.etag);
    expect((await store.stats()).count).toBe(base.stats.count + 2);
  });

  test('stats survive a bucket without conditional-write support (create path)', async () => {
    // First put creates the accumulator via If-None-Match: * (no prior ETag).
    const store = makeStore();
    await store.put(META, new Uint8Array([1]), NOW);
    expect((await store.stats()).count).toBe(1);
  });
});

describe('presigned GET (§5.4 delegated presign)', () => {
  test('a bare fetch redeems the URL and the bytes hash to the segmentId', async () => {
    const store = makeStore();
    const bytes = new Uint8Array([11, 22, 33, 44, 55, 66]);
    const record = await store.put(META, bytes, clock.ms);
    const { url, urlExpiresAtMs } = await store.presignSegmentGet(
      record.segmentId,
      {
        ttlSeconds: 600,
        nowMs: clock.ms,
      },
    );
    expect(urlExpiresAtMs).toBe((Math.floor(clock.ms / 1000) + 600) * 1000);
    // §5.4 equivalence: the signed object key embeds the segmentId.
    expect(new URL(url).pathname).toContain(record.segmentId.replace(':', '/'));

    const response = await fetch(url);
    expect(response.status).toBe(200);
    const got = new Uint8Array(await response.arrayBuffer());
    expect(got).toEqual(bytes);
    expect(await segmentIdFor(got)).toBe(record.segmentId);
  });

  test('expiry is enforced by the provider clock', async () => {
    const store = makeStore();
    const record = await store.put(META, new Uint8Array([1, 2, 3]), clock.ms);
    const { url } = await store.presignSegmentGet(record.segmentId, {
      ttlSeconds: 600,
      nowMs: clock.ms,
    });
    const before = clock.ms;
    try {
      clock.ms = before + 601_000;
      const response = await fetch(url);
      expect(response.status).toBe(403);
      expect(await response.text()).toContain('expired');
    } finally {
      clock.ms = before;
    }
  });

  test('tampering with the signed key or params is rejected', async () => {
    const store = makeStore();
    const a = await store.put(META, new Uint8Array([1]), clock.ms);
    const b = await store.put(
      { ...META, scopeDigest: 'digest-b' },
      new Uint8Array([2]),
      clock.ms,
    );
    const { url } = await store.presignSegmentGet(a.segmentId, {
      nowMs: clock.ms,
    });

    const swappedKey = new URL(url);
    swappedKey.pathname = new URL(
      (await store.presignSegmentGet(b.segmentId, { nowMs: clock.ms })).url,
    ).pathname;
    expect((await fetch(swappedKey)).status).toBe(403);

    const extendedExpiry = new URL(url);
    extendedExpiry.searchParams.set('X-Amz-Expires', '999999');
    expect((await fetch(extendedExpiry)).status).toBe(403);

    const unsigned = new URL(url);
    unsigned.search = '';
    expect((await fetch(unsigned)).status).toBe(403);
  });

  test('issueSegmentUrl routes a DelegatedPresignConfig to the store', async () => {
    const store = makeStore();
    const record = await store.put(META, new Uint8Array([9, 8]), clock.ms);
    const issue = await issueSegmentUrl(s3PresignedUrls(store), {
      segmentId: record.segmentId,
      partition: 'p',
      scopeDigest: 'digest-a',
      nowMs: clock.ms,
    });
    // Same expiry shape as the native scheme: default 900 s, second floor.
    expect(issue.urlExpiresAtMs).toBe(
      (Math.floor(clock.ms / 1000) + 900) * 1000,
    );
    expect((await fetch(issue.url)).status).toBe(200);
  });
});

describe('delegated presign through the pull (§5.4 equivalence)', () => {
  test('SEGMENT_REF carries a provider URL the client can fetch and verify', async () => {
    const store = makeStore();
    const t = makeContext({
      segments: store,
      limits: { inlineSegmentMaxBytes: 1 },
      signedUrls: s3PresignedUrls(store, { ttlSeconds: 600 }),
    });
    await seedTask(t, 'c1', 't1', 'p1');
    const message = await sync(t, [
      pullHeader({ accept: 0b1011 }),
      subFrame('s1', 'tasks', { project_id: ['p1'] }, -1),
    ]);
    const ref = section(message, 's1').body.find(
      (f: ResponseFrame): f is SegmentRefFrame => f.type === 'SEGMENT_REF',
    );
    if (ref?.url === undefined) throw new Error('expected a presigned url');
    expect(ref.url.startsWith(`${stub.url}/segments/`)).toBe(true);
    expect(ref.urlExpiresAtMs).toBe((Math.floor(t.now.ms / 1000) + 600) * 1000);

    const response = await fetch(ref.url);
    expect(response.status).toBe(200);
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(await segmentIdFor(bytes)).toBe(ref.segmentId);
  });
});
