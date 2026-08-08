import { expect, test } from 'bun:test';
import {
  buildSqliteImage,
  SqliteBlobStore,
  SqliteLeaseStore,
  SqliteSegmentStore,
  SqliteServerStorage,
} from '@syncular/server/sqlite';
import { runServerSqliteContract } from './sqlite-runtime/adapter-contract';

test('the server SQLite runtime contract passes on Bun', async () => {
  await expect(
    runServerSqliteContract({
      storage: (path) => new SqliteServerStorage(path),
      segments: () => new SqliteSegmentStore(),
      blobs: () => new SqliteBlobStore(),
      leases: () => new SqliteLeaseStore(),
      buildImage: buildSqliteImage,
    }),
  ).resolves.toBeUndefined();
});
