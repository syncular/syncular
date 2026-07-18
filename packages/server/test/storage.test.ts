/**
 * Both in-tree server storages against the shared `ServerStorage` contract:
 * `SqliteServerStorage` (bun:sqlite, the reference) and
 * `PostgresServerStorage` (pglite, embedded WASM Postgres — hermetic, no
 * docker). The two run identical assertions so the Postgres path matches the
 * reference key-for-key (index-first fanout, dense commitSeq, §4.6 horizon).
 */

import { expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import {
  D1ServerStorage,
  PostgresServerStorage,
  SqliteServerStorage,
} from '@syncular/server';
import { pgliteExecutor } from '@syncular/server/pglite';
import { D1DatabaseDouble } from './d1-double';
import { runStorageContract } from './storage-contract';

runStorageContract('sqlite', () => new SqliteServerStorage());

runStorageContract('postgres/pglite', async () => {
  const db = await PGlite.create();
  const storage = new PostgresServerStorage(pgliteExecutor(db));
  await storage.migrate();
  return storage;
});

// D1 (Cloudflare Workers) against the local bun:sqlite-backed double
// (test/d1-double.ts documents its fidelity limits). Same contract, so the
// D1 path is held to the reference behavior key-for-key.
runStorageContract('d1/double', async () => {
  const storage = new D1ServerStorage(new D1DatabaseDouble(), {
    pushApplySerialized: true,
  });
  await storage.migrate();
  return storage;
});

test('D1 push apply fails closed without external serialization', async () => {
  const storage = new D1ServerStorage(new D1DatabaseDouble());
  await storage.migrate();
  const tx = await storage.begin('partition');
  await expect(tx.lockPartitionForPush?.()).rejects.toThrow(
    'requires externally serialized partition writes',
  );
  await tx.rollback();
});
