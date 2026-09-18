/**
 * In-tree segment stores (memory, sqlite) against the shared backend
 * contract — put/get round-trips, caller-side expiry (§5.5), and the §5.3
 * reuse `find`. The S3 backend runs the same contract in
 * `s3-segment-store.test.ts`.
 */
import { describe, expect, test } from 'bun:test';
import {
  MemorySegmentStore,
  type SegmentMetadata,
  SqliteSegmentStore,
} from '@syncular/server';
import { runSegmentStoreContract } from './segment-store-contract';

runSegmentStoreContract('memory', () => new MemorySegmentStore());
runSegmentStoreContract('sqlite', () => new SqliteSegmentStore());

describe('content-address collision guard (§5.1)', () => {
  const META: SegmentMetadata = {
    partition: 'p',
    logEpoch: 'epoch-1',
    table: 'tasks',
    schemaVersion: 1,
    mediaType: 'rows',
    scopeDigest: 'digest-a',
    asOfCommitSeq: 1,
    rowCount: 1,
    rowCursor: null,
    nextRowCursor: null,
  };

  test('bytes stored under an id that does not hash to them fail loudly', async () => {
    const store = new SqliteSegmentStore();
    const bytes = new Uint8Array([1, 2, 3]);
    const record = await store.put(META, bytes, 1_750_000_000_000);
    // Corrupt the cached bytes under the existing content address.
    store.db.run('UPDATE sync_segments SET bytes=? WHERE segment_id=?', [
      new Uint8Array([9]),
      record.segmentId,
    ]);
    await expect(
      store.put({ ...META, scopeDigest: 'digest-b' }, bytes, 1_750_000_000_000),
    ).rejects.toThrow('content-address collision');
  });
});
