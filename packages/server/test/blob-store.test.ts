/**
 * The in-process blob stores (memory + sqlite) against the shared
 * `BlobStore` contract, plus the `sweepOrphanBlobs` GC helper (§5.9.2) driven
 * over a real storage reference index.
 */
import { describe, expect, test } from 'bun:test';
import {
  blobIdFor,
  MemoryBlobStore,
  SqliteBlobStore,
  SqliteServerStorage,
  type SyncularServerEvent,
  sweepOrphanBlobs,
} from '@syncular-v2/server';
import { runBlobStoreContract } from './blob-store-contract';

runBlobStoreContract('memory', () => new MemoryBlobStore());
runBlobStoreContract('sqlite', () => new SqliteBlobStore(':memory:'));

const PARTITION = 'p';
const NOW = 1_750_000_000_000;
const GRACE_MS = 24 * 60 * 60 * 1000;

describe('sweepOrphanBlobs helper (§5.9.2)', () => {
  test('deletes an orphan uploaded before the grace window', async () => {
    const store = new MemoryBlobStore();
    const bytes = new Uint8Array([1]);
    const blobId = await blobIdFor(bytes);
    // Uploaded a full day + a bit before now, never referenced.
    await store.put(PARTITION, blobId, bytes, NOW - GRACE_MS - 1);

    const storage = referenceIndex([]); // no live rows reference it
    const result = await sweepOrphanBlobs(storage, store, PARTITION, {
      graceMs: GRACE_MS,
      nowMs: NOW,
    });
    expect(result.swept).toEqual([blobId]);
    expect(result.referencedCount).toBe(0);
    expect(await store.has(PARTITION, blobId)).toBe(false);
  });

  test('a referenced blob survives even when ancient', async () => {
    const store = new MemoryBlobStore();
    const bytes = new Uint8Array([2]);
    const blobId = await blobIdFor(bytes);
    await store.put(PARTITION, blobId, bytes, NOW - GRACE_MS * 365);

    const storage = referenceIndex([blobId]);
    const result = await sweepOrphanBlobs(storage, store, PARTITION, {
      graceMs: GRACE_MS,
      nowMs: NOW,
    });
    expect(result.swept).toEqual([]);
    expect(await store.has(PARTITION, blobId)).toBe(true);
  });

  test('a fresh unreferenced blob survives the grace period (upload→push race)', async () => {
    const store = new MemoryBlobStore();
    const bytes = new Uint8Array([3]);
    const blobId = await blobIdFor(bytes);
    // Uploaded 1 minute ago — its push has not landed yet, so it is
    // legitimately unreferenced. The grace period must protect it.
    await store.put(PARTITION, blobId, bytes, NOW - 60_000);

    const storage = referenceIndex([]);
    const result = await sweepOrphanBlobs(storage, store, PARTITION, {
      graceMs: GRACE_MS,
      nowMs: NOW,
    });
    expect(result.swept).toEqual([]);
    expect(await store.has(PARTITION, blobId)).toBe(true);
  });

  test('emits one blob.swept event with the counts', async () => {
    const store = new MemoryBlobStore();
    const orphan = new Uint8Array([4]);
    const referenced = new Uint8Array([5]);
    const orphanId = await blobIdFor(orphan);
    const referencedId = await blobIdFor(referenced);
    await store.put(PARTITION, orphanId, orphan, NOW - GRACE_MS - 1);
    await store.put(PARTITION, referencedId, referenced, NOW - GRACE_MS - 1);

    const events: SyncularServerEvent[] = [];
    const storage = referenceIndex([referencedId]);
    await sweepOrphanBlobs(storage, store, PARTITION, {
      graceMs: GRACE_MS,
      nowMs: NOW,
      events: { emit: (e) => events.push(e) },
    });
    const swept = events.filter((e) => e.type === 'blob.swept');
    expect(swept).toHaveLength(1);
    const e = swept[0];
    if (e?.type !== 'blob.swept') throw new Error('expected blob.swept');
    expect(e.partition).toBe(PARTITION);
    expect(e.swept).toBe(1);
    expect(e.referenced).toBe(1);
    expect(e.graceMs).toBe(GRACE_MS);
    expect(e.atMs).toBe(NOW);
  });

  test('defaults the grace period to 24 h', async () => {
    const store = new MemoryBlobStore();
    const bytes = new Uint8Array([6]);
    const blobId = await blobIdFor(bytes);
    // 23 h old — inside the default 24 h grace, must survive.
    await store.put(PARTITION, blobId, bytes, NOW - 23 * 60 * 60 * 1000);
    const storage = referenceIndex([]);
    const result = await sweepOrphanBlobs(storage, store, PARTITION, {
      nowMs: NOW,
    });
    expect(result.swept).toEqual([]);
  });

  test('drives the real sqlite reference index end-to-end', async () => {
    const store = new SqliteBlobStore(':memory:');
    const orphan = new Uint8Array([7]);
    const referenced = new Uint8Array([8]);
    const orphanId = await blobIdFor(orphan);
    const referencedId = await blobIdFor(referenced);
    await store.put(PARTITION, orphanId, orphan, NOW - GRACE_MS - 1);
    await store.put(PARTITION, referencedId, referenced, NOW - GRACE_MS - 1);

    const storage = new SqliteServerStorage(':memory:');
    const tx = await storage.begin(PARTITION);
    if (tx.setBlobRefs === undefined) throw new Error('no setBlobRefs');
    await tx.setBlobRefs('tasks', 'row-1', [referencedId]);
    await tx.commit();

    const result = await sweepOrphanBlobs(storage, store, PARTITION, {
      graceMs: GRACE_MS,
      nowMs: NOW,
    });
    expect(result.swept).toEqual([orphanId]);
    expect(await store.has(PARTITION, orphanId)).toBe(false);
    expect(await store.has(PARTITION, referencedId)).toBe(true);
  });

  test('throws when storage has no reference index (refuses unsafe sweep)', async () => {
    const store = new MemoryBlobStore();
    // A storage object missing listReferencedBlobIds.
    const storage = { listReferencedBlobIds: undefined } as never;
    await expect(sweepOrphanBlobs(storage, store, PARTITION)).rejects.toThrow(
      /reference index/,
    );
  });
});

/**
 * A minimal `ServerStorage` stub exposing only `listReferencedBlobIds` — the
 * single method `sweepOrphanBlobs` reads. The helper never touches the rest.
 */
function referenceIndex(blobIds: string[]): never {
  return {
    listReferencedBlobIds: async () => blobIds,
  } as never;
}
