import {
  buildSqliteImage,
  SqliteBlobStore,
  SqliteLeaseStore,
  SqliteSegmentStore,
  SqliteServerStorage,
} from '../../src/sqlite-node.ts';
import { runServerSqliteContract } from './adapter-contract.ts';

await runServerSqliteContract({
  storage: (path) => new SqliteServerStorage(path),
  segments: () => new SqliteSegmentStore(),
  blobs: () => new SqliteBlobStore(),
  leases: () => new SqliteLeaseStore(),
  buildImage: buildSqliteImage,
});
console.log('server-sqlite: node:sqlite adapter passes the runtime contract');
