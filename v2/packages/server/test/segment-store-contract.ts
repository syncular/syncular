/**
 * The `SegmentStore` contract (SPEC.md §5.1 cache semantics, §5.3 reuse,
 * §5.5 caller-side expiry), run identically against every backend —
 * memory, sqlite, and S3. Backends register via `runSegmentStoreContract`
 * with a factory returning a fresh, isolated store per test; stores must
 * use the default 24 h TTL so expiry assertions hold.
 */
import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_SEGMENT_TTL_MS,
  type SegmentFindKey,
  type SegmentMetadata,
  type SegmentStore,
  segmentIdFor,
} from '@syncular-v2/server';

export const CONTRACT_NOW = 1_750_000_000_000;

const IMAGE_META: SegmentMetadata = {
  partition: 'p',
  table: 'tasks',
  schemaVersion: 1,
  mediaType: 'sqlite',
  scopeDigest: 'digest-a',
  asOfCommitSeq: 42,
  rowCount: 5,
  rowCursor: null,
  nextRowCursor: null,
};

const PAGED_META: SegmentMetadata = {
  ...IMAGE_META,
  mediaType: 'rows',
  rowCount: 3,
  rowCursor: 'row-100',
  nextRowCursor: 'row-200',
};

const KEY: SegmentFindKey = {
  partition: 'p',
  table: 'tasks',
  schemaVersion: 1,
  mediaType: 'sqlite',
  scopeDigest: 'digest-a',
  asOfCommitSeq: 42,
};

export function runSegmentStoreContract(
  name: string,
  makeStore: () => SegmentStore | Promise<SegmentStore>,
): void {
  describe(`SegmentStore contract (${name})`, () => {
    test('put → get round-trips the record and the exact bytes', async () => {
      const store = await makeStore();
      const bytes = new Uint8Array([10, 20, 30, 40, 50]);
      const record = await store.put(IMAGE_META, bytes, CONTRACT_NOW);
      expect(record.segmentId).toBe(await segmentIdFor(bytes));
      expect(record.byteLength).toBe(bytes.length);
      expect(record.createdAtMs).toBe(CONTRACT_NOW);
      expect(record.expiresAtMs).toBe(CONTRACT_NOW + DEFAULT_SEGMENT_TTL_MS);

      const got = await store.get(record.segmentId);
      if (got === undefined) throw new Error('expected a stored segment');
      expect(got.bytes).toEqual(bytes);
      expect(got.record).toEqual(record);
    });

    test('paged rows records round-trip their cursors', async () => {
      const store = await makeStore();
      const bytes = new Uint8Array([7, 7, 7]);
      const record = await store.put(PAGED_META, bytes, CONTRACT_NOW);
      const got = await store.get(record.segmentId);
      expect(got?.record.mediaType).toBe('rows');
      expect(got?.record.rowCursor).toBe('row-100');
      expect(got?.record.nextRowCursor).toBe('row-200');
    });

    test('get of an unknown segmentId is undefined', async () => {
      const store = await makeStore();
      expect(await store.get(`sha256:${'0'.repeat(64)}`)).toBeUndefined();
    });

    test('get returns expired records — expiry is the caller check (§5.5)', async () => {
      const store = await makeStore();
      const bytes = new Uint8Array([1]);
      // Backdate the put so the record is expired relative to CONTRACT_NOW.
      const record = await store.put(
        IMAGE_META,
        bytes,
        CONTRACT_NOW - DEFAULT_SEGMENT_TTL_MS - 1,
      );
      expect(record.expiresAtMs).toBeLessThan(CONTRACT_NOW);
      const got = await store.get(record.segmentId);
      expect(got?.record.expiresAtMs).toBe(record.expiresAtMs);
      expect(got?.bytes).toEqual(bytes);
    });

    test('identical bytes collapse to one segmentId; re-put refreshes the record', async () => {
      const store = await makeStore();
      const bytes = new Uint8Array([9, 9, 9, 9]);
      const first = await store.put(IMAGE_META, bytes, CONTRACT_NOW);
      const second = await store.put(IMAGE_META, bytes, CONTRACT_NOW + 5_000);
      expect(second.segmentId).toBe(first.segmentId);
      const got = await store.get(first.segmentId);
      expect(got?.record.createdAtMs).toBe(CONTRACT_NOW + 5_000);
    });

    test('find returns the unexpired whole-table record for the key (§5.3)', async () => {
      const store = await makeStore();
      const record = await store.put(
        IMAGE_META,
        new Uint8Array([1, 2]),
        CONTRACT_NOW,
      );
      const found = await store.find(KEY, CONTRACT_NOW + 1);
      expect(found?.segmentId).toBe(record.segmentId);
      expect(found?.rowCount).toBe(5);
      expect(found?.rowCursor).toBeNull();
    });

    test('find never returns expired, paged, or differently-keyed records', async () => {
      const store = await makeStore();
      await store.put(IMAGE_META, new Uint8Array([1, 2]), CONTRACT_NOW);
      // Paged rows segment under the same scope/pin: not a reuse hit.
      await store.put(
        { ...IMAGE_META, mediaType: 'rows', rowCursor: 'row-1' },
        new Uint8Array([3, 4]),
        CONTRACT_NOW,
      );
      const expired = await store.find(
        KEY,
        CONTRACT_NOW + DEFAULT_SEGMENT_TTL_MS + 1,
      );
      expect(expired).toBeUndefined();
      const otherDigest = await store.find(
        { ...KEY, scopeDigest: 'digest-b' },
        CONTRACT_NOW + 1,
      );
      expect(otherDigest).toBeUndefined();
      const otherPin = await store.find(
        { ...KEY, asOfCommitSeq: 41 },
        CONTRACT_NOW + 1,
      );
      expect(otherPin).toBeUndefined();
      const rows = await store.find(
        { ...KEY, mediaType: 'rows' },
        CONTRACT_NOW + 1,
      );
      expect(rows).toBeUndefined();
    });
  });
}
