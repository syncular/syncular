/**
 * `S3BlobStore` against the hermetic in-process S3 stub: the shared
 * `BlobStore` contract, the content-addressed key layout, presigned GET
 * round-trips with stub-clock expiry (§5.9.5 delegated presign), and the
 * orphan sweep over `ListObjectsV2` (§5.9.2) — including the multi-page
 * pagination path.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import {
  blobIdFor,
  issueBlobUrl,
  S3BlobStore,
  s3PresignedBlobUrls,
} from '@syncular-v2/server';
import { runBlobStoreContract } from './blob-store-contract';
import { startS3Stub } from './s3-stub';

const NOW = 1_750_000_000_000;
const clock = { ms: NOW };
const stub = startS3Stub({
  bucket: 'blobs',
  region: 'auto',
  accessKeyId: 'SYNCULARTESTAKID',
  secretAccessKey: 'syncular-test-secret',
  now: () => clock.ms,
});
afterAll(() => stub.stop());

let storeCount = 0;
function makeStore(): S3BlobStore {
  storeCount += 1;
  return new S3BlobStore({
    endpoint: stub.url,
    region: 'auto',
    bucket: 'blobs',
    accessKeyId: 'SYNCULARTESTAKID',
    secretAccessKey: 'syncular-test-secret',
    keyPrefix: `t${storeCount}/`,
  });
}

const PARTITION = 'p';

runBlobStoreContract('s3', () => makeStore());

describe('S3BlobStore specifics', () => {
  test('objects land under a deterministic partition-scoped content key', async () => {
    const store = makeStore();
    const bytes = new Uint8Array([1, 2, 3]);
    const blobId = await blobIdFor(bytes);
    await store.put(PARTITION, blobId, bytes, NOW);
    const hex = blobId.slice('sha256:'.length);
    expect(store.objectKeyFor(PARTITION, blobId)).toBe(
      `t${storeCount}/blob/${PARTITION}/sha256/${hex}`,
    );
    expect(stub.objects.has(store.objectKeyFor(PARTITION, blobId))).toBe(true);
  });

  test('get/has reject malformed blob ids without touching the bucket', async () => {
    const store = makeStore();
    expect(await store.get(PARTITION, '../../etc/passwd')).toBeUndefined();
    expect(await store.has(PARTITION, 'sha256:short')).toBe(false);
  });

  test('the stored object body is exactly the content-addressed bytes', async () => {
    const store = makeStore();
    const bytes = new Uint8Array([11, 22, 33, 44]);
    const blobId = await blobIdFor(bytes);
    await store.put(PARTITION, blobId, bytes, NOW);
    const stored = stub.objects.get(store.objectKeyFor(PARTITION, blobId));
    expect(stored?.bytes).toEqual(bytes);
    expect(await blobIdFor(stored?.bytes ?? new Uint8Array())).toBe(blobId);
  });

  test('stats are store-wide and flagged approximate', async () => {
    const store = makeStore();
    expect(await store.stats(PARTITION)).toEqual({
      count: 0,
      bytes: 0,
      approximate: true,
    });
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([4, 5, 6, 7]);
    await store.put(PARTITION, await blobIdFor(a), a, NOW);
    await store.put(PARTITION, await blobIdFor(b), b, NOW);
    expect(await store.stats(PARTITION)).toEqual({
      count: 2,
      bytes: 7,
      approximate: true,
    });
  });

  test('an idempotent re-put is not double-counted', async () => {
    const store = makeStore();
    const bytes = new Uint8Array([9, 9, 9]);
    const blobId = await blobIdFor(bytes);
    await store.put(PARTITION, blobId, bytes, NOW);
    await store.put(PARTITION, blobId, bytes, NOW + 1);
    const stats = await store.stats(PARTITION);
    expect(stats.count).toBe(1);
    expect(stats.bytes).toBe(3);
  });

  test('sweep decrements stats for deleted blobs', async () => {
    const store = makeStore();
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const blobId = await blobIdFor(bytes);
    await store.put(PARTITION, blobId, bytes, NOW - 10_000);
    expect((await store.stats(PARTITION)).count).toBe(1);
    await store.sweepOrphans(PARTITION, NOW, new Set());
    expect(await store.stats(PARTITION)).toEqual({
      count: 0,
      bytes: 0,
      approximate: true,
    });
  });

  test('sweep pages through a multi-page ListObjectsV2 (pagination)', async () => {
    const store = makeStore();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const bytes = new Uint8Array([i, i, i]);
      const blobId = await blobIdFor(bytes);
      ids.push(blobId);
      await store.put(PARTITION, blobId, bytes, NOW - 10_000);
    }
    // Reference the third one; the other four are orphans across >2 pages.
    const keep = new Set([ids[2] as string]);
    const swept = await store.sweepOrphans(PARTITION, NOW, keep);
    expect(swept.sort()).toEqual(ids.filter((id) => id !== ids[2]).sort());
    expect(await store.has(PARTITION, ids[2] as string)).toBe(true);
    for (const id of swept) {
      expect(await store.has(PARTITION, id)).toBe(false);
    }
  });
});

describe('presigned GET (§5.9.5 delegated presign)', () => {
  test('a bare fetch redeems the URL and the bytes hash to the blobId', async () => {
    const store = makeStore();
    const bytes = new Uint8Array([11, 22, 33, 44, 55, 66]);
    const blobId = await blobIdFor(bytes);
    await store.put(PARTITION, blobId, bytes, clock.ms);
    const { url, urlExpiresAtMs } = await store.presignBlobGet(
      PARTITION,
      blobId,
      { ttlSeconds: 600, nowMs: clock.ms },
    );
    expect(urlExpiresAtMs).toBe((Math.floor(clock.ms / 1000) + 600) * 1000);
    // §5.9.5 equivalence: the signed object key embeds the blobId.
    expect(new URL(url).pathname).toContain(blobId.replace(':', '/'));

    const response = await fetch(url);
    expect(response.status).toBe(200);
    const got = new Uint8Array(await response.arrayBuffer());
    expect(got).toEqual(bytes);
    expect(await blobIdFor(got)).toBe(blobId);
  });

  test('expiry is enforced by the provider clock', async () => {
    const store = makeStore();
    const bytes = new Uint8Array([1, 2, 3]);
    const blobId = await blobIdFor(bytes);
    await store.put(PARTITION, blobId, bytes, clock.ms);
    const { url } = await store.presignBlobGet(PARTITION, blobId, {
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

  test('issueBlobUrl routes a BlobPresignConfig to the store', async () => {
    const store = makeStore();
    const bytes = new Uint8Array([9, 8]);
    const blobId = await blobIdFor(bytes);
    await store.put(PARTITION, blobId, bytes, clock.ms);
    const issue = await issueBlobUrl(s3PresignedBlobUrls(store), {
      partition: PARTITION,
      blobId,
      nowMs: clock.ms,
    });
    // Default 900 s, second floor — the §5.9.5 TTL shape.
    expect(issue.urlExpiresAtMs).toBe(
      (Math.floor(clock.ms / 1000) + 900) * 1000,
    );
    expect((await fetch(issue.url)).status).toBe(200);
  });

  test('a URL minted for one partition does not serve another partition', async () => {
    const store = makeStore();
    const bytes = new Uint8Array([7, 7]);
    const blobId = await blobIdFor(bytes);
    await store.put('p1', blobId, bytes, clock.ms);
    // Presign for p2 where the blob does not exist → 404 on redemption.
    const { url } = await store.presignBlobGet('p2', blobId, {
      nowMs: clock.ms,
    });
    expect((await fetch(url)).status).toBe(404);
  });
});
