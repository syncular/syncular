/**
 * Both in-tree server storages against the shared `ServerStorage` contract:
 * `SqliteServerStorage` (bun:sqlite, the reference) and
 * `PostgresServerStorage` (pglite, embedded WASM Postgres — hermetic, no
 * docker). The two run identical assertions so the Postgres path matches the
 * reference key-for-key (index-first fanout, dense commitSeq, §4.6 horizon).
 */

import { expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { encodeRow } from '@syncular/core';
import {
  compileSchema,
  type D1PreparedStatement,
  D1ServerStorage,
  PostgresServerStorage,
  SqliteServerStorage,
  type StoredPushResult,
} from '@syncular/server';
import { pgliteExecutor } from '@syncular/server/pglite';
import { StorageConstraintError } from '../src/storage-errors';
import { D1DatabaseDouble } from './d1-double';
import { CONTRACT_SCHEMA, runStorageContract } from './storage-contract';

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

function appliedResult(): StoredPushResult {
  return {
    status: 'applied',
    commitSeq: 1,
    results: [{ opIndex: 0, status: 'applied' }],
  };
}

test('SQLite: a failed COMMIT rolls back and later transactions proceed', async () => {
  const storage = new SqliteServerStorage();
  const realExec = storage.db.exec.bind(storage.db);
  let failNextCommit = true;
  (storage.db as unknown as { exec: (sql: string) => unknown }).exec = (
    sql: string,
  ) => {
    if (failNextCommit && sql === 'COMMIT') {
      failNextCommit = false;
      throw Object.assign(new Error('SQLITE_BUSY: database is locked'), {
        code: 'SQLITE_BUSY',
      });
    }
    return realExec(sql);
  };

  const tx = await storage.begin('partition');
  await tx.putPushResult('c1', 'lost-commit', appliedResult());
  await expect(tx.commit()).rejects.toThrow('SQLITE_BUSY');

  // Regression: before the ROLLBACK-on-failed-COMMIT the connection stayed
  // inside BEGIN IMMEDIATE and every later transaction errored with
  // "cannot start a transaction within a transaction".
  const tx2 = await storage.begin('partition');
  await tx2.putPushResult('c1', 'landed-commit', appliedResult());
  await tx2.commit();
  expect(
    await storage.getPushResult('partition', 'c1', 'lost-commit'),
  ).toBeUndefined();
  expect(
    await storage.getPushResult('partition', 'c1', 'landed-commit'),
  ).toBeDefined();
});

test('pglite executor serializes overlapping transaction scopes', async () => {
  const db = await PGlite.create();
  const exec = pgliteExecutor(db);
  try {
    const order: string[] = [];
    await Promise.all([
      exec.transaction(async () => {
        order.push('first:start');
        await new Promise((resolve) => setTimeout(resolve, 25));
        order.push('first:end');
      }),
      exec.transaction(async () => {
        order.push('second:start');
        order.push('second:end');
      }),
    ]);
    // Interleaved scopes would collapse into one SQL transaction (a nested
    // BEGIN is a warning-level no-op on Postgres).
    expect(order).toEqual([
      'first:start',
      'first:end',
      'second:start',
      'second:end',
    ]);
  } finally {
    await exec.close?.();
  }
});

/** A D1 double whose batch() fails commit-time with a constraint error. */
class ConstraintAtBatchDouble extends D1DatabaseDouble {
  failNextBatch = false;

  override async batch(statements: D1PreparedStatement[]): Promise<unknown[]> {
    if (this.failNextBatch) {
      this.failNextBatch = false;
      throw new Error('D1_ERROR: NOT NULL constraint failed: tasks.data');
    }
    return super.batch(statements);
  }
}

test('D1: a batch-commit constraint attributes the opIndex only when it is unambiguous', async () => {
  const db = new ConstraintAtBatchDouble();
  const storage = new D1ServerStorage(db, { pushApplySerialized: true });
  await storage.migrate();
  await storage.ensureSchema(compileSchema(CONTRACT_SCHEMA));
  const taskRow = (id: string) => ({
    rowId: id,
    serverVersion: 1,
    scopes: { project: 'p1' },
    payload: encodeRow(
      [
        { name: 'id', type: 'string', nullable: false },
        { name: 'project_id', type: 'string', nullable: false },
        { name: 'data', type: 'bytes', nullable: true },
      ] as const,
      [id, 'p1', null],
    ),
  });

  // Several buffered application ops: the violating one is unknowable from
  // the batch error, so the rejection omits the opIndex.
  const ambiguous = await storage.begin('partition');
  await ambiguous.lockPartitionForPush?.();
  await ambiguous.upsertRow('tasks', taskRow('t-0'), { opIndex: 0 });
  await ambiguous.upsertRow('tasks', taskRow('t-2'), { opIndex: 2 });
  db.failNextBatch = true;
  const ambiguousError = await ambiguous.commit().then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(ambiguousError).toBeInstanceOf(StorageConstraintError);
  expect((ambiguousError as StorageConstraintError).opIndex).toBeUndefined();
  await ambiguous.rollback();

  // One buffered application op: the attribution is exact.
  const exact = await storage.begin('partition');
  await exact.lockPartitionForPush?.();
  await exact.upsertRow('tasks', taskRow('t-solo'), { opIndex: 3 });
  db.failNextBatch = true;
  const exactError = await exact.commit().then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(exactError).toBeInstanceOf(StorageConstraintError);
  expect((exactError as StorageConstraintError).opIndex).toBe(3);
  await exact.rollback();
});
