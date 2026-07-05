/**
 * In-tree segment stores (memory, sqlite) against the shared backend
 * contract — put/get round-trips, caller-side expiry (§5.5), and the §5.3
 * reuse `find`. The S3 backend runs the same contract in
 * `s3-segment-store.test.ts`.
 */
import { MemorySegmentStore, SqliteSegmentStore } from '@syncular/server';
import { runSegmentStoreContract } from './segment-store-contract';

runSegmentStoreContract('memory', () => new MemorySegmentStore());
runSegmentStoreContract('sqlite', () => new SqliteSegmentStore());
