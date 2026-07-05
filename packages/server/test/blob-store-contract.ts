/**
 * The `BlobStore` contract (SPEC.md §5.9.2 durable content-addressed store,
 * §5.9.3 idempotent upload, §5.9.2 orphan sweep), run identically against
 * every backend — memory, sqlite, and S3. Backends register via
 * `runBlobStoreContract` with a factory returning a fresh, isolated store per
 * test.
 *
 * Blobs are DURABLE (no TTL): the contract asserts a stored blob survives
 * regardless of clock advance — reclamation is reference-driven (the sweep),
 * never time-driven, which is the honest difference from `SegmentStore`.
 */
import { describe, expect, test } from 'bun:test';
import { type BlobStore, blobIdFor } from '@syncular-v2/server';

export const CONTRACT_NOW = 1_750_000_000_000;
const PARTITION = 'p';
const OTHER_PARTITION = 'q';

export function runBlobStoreContract(
  name: string,
  makeStore: () => BlobStore | Promise<BlobStore>,
): void {
  describe(`BlobStore contract (${name})`, () => {
    test('put → get round-trips the record and the exact bytes', async () => {
      const store = await makeStore();
      const bytes = new Uint8Array([10, 20, 30, 40, 50]);
      const blobId = await blobIdFor(bytes);
      const record = await store.put(
        PARTITION,
        blobId,
        bytes,
        CONTRACT_NOW,
        'image/png',
      );
      expect(record.blobId).toBe(blobId);
      expect(record.partition).toBe(PARTITION);
      expect(record.byteLength).toBe(bytes.length);
      expect(record.mediaType).toBe('image/png');
      expect(record.createdAtMs).toBe(CONTRACT_NOW);

      const got = await store.get(PARTITION, blobId);
      if (got === undefined) throw new Error('expected a stored blob');
      expect(got.bytes).toEqual(bytes);
      expect(got.record.blobId).toBe(blobId);
      expect(got.record.byteLength).toBe(bytes.length);
      expect(got.record.mediaType).toBe('image/png');
      expect(got.record.createdAtMs).toBe(CONTRACT_NOW);
    });

    test('put without a mediaType omits it', async () => {
      const store = await makeStore();
      const bytes = new Uint8Array([1, 2, 3]);
      const blobId = await blobIdFor(bytes);
      const record = await store.put(PARTITION, blobId, bytes, CONTRACT_NOW);
      expect(record.mediaType).toBeUndefined();
      const got = await store.get(PARTITION, blobId);
      expect(got?.record.mediaType).toBeUndefined();
    });

    test('has reflects presence; get of an unknown blob is undefined', async () => {
      const store = await makeStore();
      const bytes = new Uint8Array([7, 7, 7]);
      const blobId = await blobIdFor(bytes);
      expect(await store.has(PARTITION, blobId)).toBe(false);
      expect(await store.get(PARTITION, blobId)).toBeUndefined();
      await store.put(PARTITION, blobId, bytes, CONTRACT_NOW);
      expect(await store.has(PARTITION, blobId)).toBe(true);
    });

    test('re-put of identical bytes is idempotent and keeps the first createdAt', async () => {
      const store = await makeStore();
      const bytes = new Uint8Array([9, 9, 9, 9]);
      const blobId = await blobIdFor(bytes);
      await store.put(PARTITION, blobId, bytes, CONTRACT_NOW);
      const second = await store.put(
        PARTITION,
        blobId,
        bytes,
        CONTRACT_NOW + 5_000,
      );
      // §5.9.2 upload age: a re-upload must NOT reset the sweep grace clock.
      expect(second.createdAtMs).toBe(CONTRACT_NOW);
      const got = await store.get(PARTITION, blobId);
      expect(got?.record.createdAtMs).toBe(CONTRACT_NOW);
    });

    test('blobs are partition-scoped — one partition cannot read another', async () => {
      const store = await makeStore();
      const bytes = new Uint8Array([5, 5, 5]);
      const blobId = await blobIdFor(bytes);
      await store.put(PARTITION, blobId, bytes, CONTRACT_NOW);
      expect(await store.has(OTHER_PARTITION, blobId)).toBe(false);
      expect(await store.get(OTHER_PARTITION, blobId)).toBeUndefined();
    });

    test('durability: a stored blob survives an arbitrary clock advance (no TTL)', async () => {
      const store = await makeStore();
      const bytes = new Uint8Array([42]);
      const blobId = await blobIdFor(bytes);
      await store.put(PARTITION, blobId, bytes, CONTRACT_NOW);
      // Ten years later, unswept, it is still downloadable — reclamation is
      // reference-driven, not time-driven (§5.9.2).
      const got = await store.get(PARTITION, blobId);
      expect(got?.bytes).toEqual(bytes);
    });

    describe('sweepOrphans (§5.9.2)', () => {
      test('deletes an unreferenced blob older than the cutoff', async () => {
        const store = await makeStore();
        const bytes = new Uint8Array([1]);
        const blobId = await blobIdFor(bytes);
        await store.put(PARTITION, blobId, bytes, CONTRACT_NOW - 10_000);
        const swept = await store.sweepOrphans(
          PARTITION,
          CONTRACT_NOW,
          new Set(),
        );
        expect(swept).toEqual([blobId]);
        expect(await store.has(PARTITION, blobId)).toBe(false);
      });

      test('never deletes a referenced blob, however old', async () => {
        const store = await makeStore();
        const bytes = new Uint8Array([2]);
        const blobId = await blobIdFor(bytes);
        await store.put(PARTITION, blobId, bytes, CONTRACT_NOW - 1_000_000);
        const swept = await store.sweepOrphans(
          PARTITION,
          CONTRACT_NOW,
          new Set([blobId]),
        );
        expect(swept).toEqual([]);
        expect(await store.has(PARTITION, blobId)).toBe(true);
      });

      test('spares an unreferenced blob younger than the cutoff (grace)', async () => {
        const store = await makeStore();
        const bytes = new Uint8Array([3]);
        const blobId = await blobIdFor(bytes);
        // Uploaded AT the cutoff boundary — younger than `olderThanMs`.
        await store.put(PARTITION, blobId, bytes, CONTRACT_NOW);
        const swept = await store.sweepOrphans(
          PARTITION,
          CONTRACT_NOW,
          new Set(),
        );
        expect(swept).toEqual([]);
        expect(await store.has(PARTITION, blobId)).toBe(true);
      });

      test('sweeps only within the given partition', async () => {
        const store = await makeStore();
        const bytes = new Uint8Array([4]);
        const blobId = await blobIdFor(bytes);
        await store.put(PARTITION, blobId, bytes, CONTRACT_NOW - 10_000);
        await store.put(OTHER_PARTITION, blobId, bytes, CONTRACT_NOW - 10_000);
        const swept = await store.sweepOrphans(
          PARTITION,
          CONTRACT_NOW,
          new Set(),
        );
        expect(swept).toEqual([blobId]);
        // The other partition's copy is untouched.
        expect(await store.has(OTHER_PARTITION, blobId)).toBe(true);
      });
    });

    describe('stats (§2.5 admin surface)', () => {
      test('counts and sums stored blob bytes', async () => {
        const store = await makeStore();
        if (store.stats === undefined) return;
        const a = new Uint8Array([1, 2, 3]);
        const b = new Uint8Array([4, 5, 6, 7]);
        await store.put(PARTITION, await blobIdFor(a), a, CONTRACT_NOW);
        await store.put(PARTITION, await blobIdFor(b), b, CONTRACT_NOW);
        const stats = await store.stats(PARTITION);
        expect(stats.count).toBe(2);
        expect(stats.bytes).toBe(7);
      });
    });
  });
}
