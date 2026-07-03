/**
 * Segment-store `find` — the §5.3 reuse key (whole-table segments only,
 * unexpired only), on both in-tree stores.
 */
import { describe, expect, test } from 'bun:test';
import {
  MemorySegmentStore,
  type SegmentMetadata,
  type SegmentStore,
  SqliteSegmentStore,
} from '@syncular-v2/server';

const NOW = 1_750_000_000_000;

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

const KEY = {
  partition: 'p',
  table: 'tasks',
  schemaVersion: 1,
  mediaType: 'sqlite',
  scopeDigest: 'digest-a',
  asOfCommitSeq: 42,
} as const;

function stores(): Array<[string, SegmentStore]> {
  return [
    ['memory', new MemorySegmentStore()],
    ['sqlite', new SqliteSegmentStore()],
  ];
}

describe('SegmentStore.find (§5.3 reuse)', () => {
  for (const [name, store] of stores()) {
    test(`${name}: returns the unexpired whole-table record for the key`, async () => {
      const record = await store.put(IMAGE_META, new Uint8Array([1, 2]), NOW);
      const found = await store.find(KEY, NOW + 1);
      expect(found?.segmentId).toBe(record.segmentId);
      expect(found?.rowCount).toBe(5);
    });
  }

  for (const [name, store] of stores()) {
    test(`${name}: never returns expired, paged, or differently-keyed records`, async () => {
      await store.put(IMAGE_META, new Uint8Array([1, 2]), NOW);
      // Paged rows segment under the same scope/pin: not a reuse hit.
      await store.put(
        { ...IMAGE_META, mediaType: 'rows', rowCursor: 'row-1' },
        new Uint8Array([3, 4]),
        NOW,
      );
      const expired = await store.find(KEY, NOW + 25 * 60 * 60 * 1000);
      expect(expired).toBeUndefined();
      const otherDigest = await store.find(
        { ...KEY, scopeDigest: 'digest-b' },
        NOW + 1,
      );
      expect(otherDigest).toBeUndefined();
      const otherPin = await store.find({ ...KEY, asOfCommitSeq: 41 }, NOW + 1);
      expect(otherPin).toBeUndefined();
      const rows = await store.find({ ...KEY, mediaType: 'rows' }, NOW + 1);
      expect(rows).toBeUndefined();
    });
  }
});
