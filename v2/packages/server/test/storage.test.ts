/**
 * Both in-tree server storages against the shared `ServerStorage` contract:
 * `SqliteServerStorage` (bun:sqlite, the reference) and
 * `PostgresServerStorage` (pglite, embedded WASM Postgres — hermetic, no
 * docker). The two run identical assertions so the Postgres path matches the
 * reference key-for-key (index-first fanout, dense commitSeq, §4.6 horizon).
 */
import { PGlite } from '@electric-sql/pglite';
import {
  PostgresServerStorage,
  SqliteServerStorage,
} from '@syncular-v2/server';
import { pgliteExecutor } from '@syncular-v2/server/pglite';
import { runStorageContract } from './storage-contract';

runStorageContract('sqlite', () => new SqliteServerStorage());

runStorageContract('postgres/pglite', async () => {
  const db = await PGlite.create();
  const storage = new PostgresServerStorage(pgliteExecutor(db));
  await storage.migrate();
  return storage;
});
