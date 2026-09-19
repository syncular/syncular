/**
 * RFC 0007 phase 1: backfill checkpoint and writer-fence storage primitives.
 *
 * Runs against all three in-tree backends so the Postgres row-lock claim and
 * the D1 single-statement compare-and-set are held to the SQLite reference
 * (`storage.ts:462-473`: a SQLite-only pass conceals the Postgres race).
 */
import { expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { encodeSparseRow } from '@syncular/core';
import {
  D1ServerStorage,
  ensureSyncServerReady,
  MemorySegmentStore,
  PostgresServerStorage,
  processPushOperationsWithTrace,
  SqliteServerStorage,
  StorageQueryError,
  type ServerStorage,
  type SyncRequestContext,
  compileSchema,
} from '@syncular/server';
import { pgliteExecutor } from '@syncular/server/pglite';
import { BunSqliteDatabase } from '@syncular/server/sqlite';
import { D1DatabaseDouble } from './d1-double';
import { CONTRACT_SCHEMA } from './storage-contract';

const PARTITION = 'part-1';
const NOW = 1_750_000_000_000;
const SCHEMA = compileSchema(CONTRACT_SCHEMA);
const SCHEMA_V2 = compileSchema({ ...CONTRACT_SCHEMA, version: 2 });

const CHECKPOINT_INSERT = `INSERT INTO sync_backfill_checkpoints(
  partition, name, schema_version, state, watermark, owner_epoch, observed_rows, updated_at_ms
) VALUES (?,?,?,?,?,?,?,?)`;
const CHECKPOINT_INSERT_PG = `INSERT INTO sync_backfill_checkpoints(
  partition, name, schema_version, state, watermark, owner_epoch, observed_rows, updated_at_ms
) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`;
const FENCE_INSERT =
  'INSERT INTO sync_writer_fence(partition, required_writer_version) VALUES (?,?)';
const FENCE_INSERT_PG =
  'INSERT INTO sync_writer_fence(partition, required_writer_version) VALUES ($1,$2)';

interface Harness {
  readonly storage: ServerStorage;
  /** A second process on the same database: a fresh storage instance. */
  storageAgain(): ServerStorage;
  /** Raw insert: `?` placeholders for SQLite/D1, `$n` for Postgres. */
  insert(sqliteSql: string, pgSql: string, params: unknown[]): Promise<void>;
  /** Raw select: `?` placeholders for SQLite/D1, `$n` for Postgres. */
  query<Row>(
    sqliteSql: string,
    pgSql: string,
    params: unknown[],
  ): Promise<Row[]>;
  close(): Promise<void>;
}

async function harnessFn(
  backend: 'sqlite' | 'postgres' | 'd1',
): Promise<Harness> {
  if (backend === 'sqlite') {
    const db = new BunSqliteDatabase();
    const storage = new SqliteServerStorage(db);
    await storage.ensureSchema(SCHEMA);
    return {
      storage,
      storageAgain: () => new SqliteServerStorage(db),
      insert: async (sqliteSql, _pgSql, params) => {
        db.query(sqliteSql).run(...(params as never[]));
      },
      query: async <Row>(
        sqliteSql: string,
        _pgSql: string,
        params: unknown[],
      ) => db.query<Row, never[]>(sqliteSql).all(...(params as never[])),
      close: async () => db.close(),
    };
  }
  if (backend === 'postgres') {
    const pg = await PGlite.create();
    const storage = new PostgresServerStorage(pgliteExecutor(pg));
    await storage.ensureSchema(SCHEMA);
    return {
      storage,
      storageAgain: () => new PostgresServerStorage(pgliteExecutor(pg)),
      insert: async (_sqliteSql, pgSql, params) => {
        await pg.query(pgSql, params);
      },
      query: async <Row>(
        _sqliteSql: string,
        pgSql: string,
        params: unknown[],
      ) => (await pg.query<Row>(pgSql, params)).rows,
      close: async () => pg.close(),
    };
  }
  const d1 = new D1DatabaseDouble();
  const storage = new D1ServerStorage(d1, { pushApplySerialized: true });
  while (!(await storage.migrateSchema(SCHEMA)).complete) {
    // Resume the resumable D1 migration until it lands.
  }
  await storage.ensureSchema(SCHEMA);
  return {
    storage,
    storageAgain: () => new D1ServerStorage(d1, { pushApplySerialized: true }),
    insert: async (sqliteSql, _pgSql, params) => {
      await d1
        .prepare(sqliteSql)
        .bind(...params)
        .run();
    },
    query: async <Row>(sqliteSql: string, _pgSql: string, params: unknown[]) =>
      (
        await d1
          .prepare(sqliteSql)
          .bind(...params)
          .all<Row>()
      ).results,
    close: async () => undefined,
  };
}

async function append(
  storage: ServerStorage,
  table: 'tasks' | 'docs',
  rowId: string,
): Promise<number> {
  const tx = await storage.begin(PARTITION);
  const seq = await tx.appendCommit({
    clientId: 'c1',
    clientCommitId: rowId,
    actorId: 'a1',
    createdAtMs: NOW,
    changes: [
      {
        table,
        rowId,
        op: 'upsert',
        rowVersion: 1,
        scopes: { project_id: 'p1' },
        payload: new Uint8Array([1]),
      },
    ],
  });
  await tx.commit();
  return seq;
}

for (const backend of ['sqlite', 'postgres/pglite', 'd1/double'] as const) {
  const key =
    backend === 'postgres/pglite'
      ? 'postgres'
      : backend === 'd1/double'
        ? 'd1'
        : 'sqlite';

  test(`${backend} claimCheckpoint increments owner_epoch without a shared epoch`, async () => {
    const { storage, insert, close } = await harnessFn(key);
    try {
      if (key === 'd1') {
        // D1 supports no declared checkpoint; nothing can exist or be claimed.
        expect(await storage.readCheckpoints(PARTITION)).toEqual([]);
        await expect(
          storage.claimCheckpoint(PARTITION, 'x', 7, NOW),
        ).rejects.toMatchObject({
          code: 'sync.storage.checkpoint_unsupported',
        });
        return;
      }
      await insert(CHECKPOINT_INSERT, CHECKPOINT_INSERT_PG, [
        PARTITION,
        'tasks-projection',
        7,
        'declared',
        0,
        0,
        0,
        NOW,
      ]);
      const [left, right] = await Promise.all([
        storage.claimCheckpoint(PARTITION, 'tasks-projection', 7, NOW + 1),
        storage.claimCheckpoint(PARTITION, 'tasks-projection', 7, NOW + 2),
      ]);
      expect(new Set([left.ownerEpoch, right.ownerEpoch])).toEqual(
        new Set([1, 2]),
      );
      expect(left.state).toBe('backfilling');
      expect(right.state).toBe('backfilling');
      const rows = await storage.readCheckpoints(PARTITION);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.ownerEpoch).toBe(2);
      expect(rows[0]?.state).toBe('backfilling');
      // A missing row is a declared-row precondition, not silent creation.
      await expect(
        storage.claimCheckpoint(PARTITION, 'absent', 7, NOW),
      ).rejects.toBeInstanceOf(StorageQueryError);
    } finally {
      await close();
    }
  });

  test(`${backend} advanceCheckpoint rejects a superseded epoch and leaves the row unchanged`, async () => {
    const { storage, insert, close } = await harnessFn(key);
    try {
      if (key === 'd1') {
        await expect(
          storage.advanceCheckpoint(PARTITION, 'x', 1, 5, 1, NOW),
        ).rejects.toMatchObject({
          code: 'sync.storage.checkpoint_unsupported',
        });
        return;
      }
      await insert(CHECKPOINT_INSERT, CHECKPOINT_INSERT_PG, [
        PARTITION,
        'p',
        1,
        'declared',
        0,
        0,
        0,
        NOW,
      ]);
      const stale = await storage.claimCheckpoint(PARTITION, 'p', 1, NOW + 1);
      const winner = await storage.claimCheckpoint(PARTITION, 'p', 1, NOW + 2);
      expect(winner.ownerEpoch).toBe(stale.ownerEpoch + 1);

      const before = (await storage.readCheckpoints(PARTITION))[0];
      expect(
        await storage.advanceCheckpoint(
          PARTITION,
          'p',
          stale.ownerEpoch,
          9,
          3,
          NOW + 3,
        ),
      ).toBe(false);
      expect((await storage.readCheckpoints(PARTITION))[0]).toEqual(before);

      expect(
        await storage.advanceCheckpoint(
          PARTITION,
          'p',
          winner.ownerEpoch,
          9,
          3,
          NOW + 4,
        ),
      ).toBe(true);
      const after = (await storage.readCheckpoints(PARTITION))[0];
      expect(after?.watermark).toBe(9);
      expect(after?.observedRows).toBe(3);
      expect(after?.updatedAtMs).toBe(NOW + 4);
      expect(after?.state).toBe('backfilling');
    } finally {
      await close();
    }
  });

  test(`${backend} source coverage ignores non-source tables`, async () => {
    const { storage, close } = await harnessFn(key);
    try {
      const taskSeq = await append(storage, 'tasks', 't1');
      const docSeq = await append(storage, 'docs', 'd1');
      expect(docSeq).toBe(taskSeq + 1);

      expect(await storage.sourceCoverageSeq(PARTITION, ['tasks'])).toBe(
        taskSeq,
      );
      expect(await storage.sourceCoverageSeq(PARTITION, ['docs'])).toBe(docSeq);
      expect(
        await storage.sourceCoverageSeq(PARTITION, ['tasks', 'docs']),
      ).toBe(docSeq);
      expect(await storage.sourceCoverageSeq(PARTITION, [])).toBe(0);

      // The property that stops a backfill invalidating its own activation:
      // a later non-source write is invisible to the source check.
      await append(storage, 'docs', 'd2');
      expect(
        await storage.hasSourceChangesAbove(PARTITION, ['tasks'], taskSeq),
      ).toBe('clean');
      expect(
        await storage.hasSourceChangesAbove(PARTITION, ['docs'], taskSeq),
      ).toBe('changed');
      expect(
        await storage.hasSourceChangesAbove(PARTITION, ['tasks'], docSeq),
      ).toBe('clean');
      expect(await storage.hasSourceChangesAbove(PARTITION, ['tasks'], 0)).toBe(
        'changed',
      );
    } finally {
      await close();
    }
  });

  test(`${backend} a pruned window is unverifiable, never clean`, async () => {
    const { storage, close } = await harnessFn(key);
    try {
      const { logEpoch } = await storage.touchPartition(
        PARTITION,
        NOW,
        'epoch',
      );
      const taskSeq = await append(storage, 'tasks', 't1');
      expect(await storage.hasSourceChangesAbove(PARTITION, ['tasks'], 0)).toBe(
        'changed',
      );

      await storage.pruneCommitsThrough(PARTITION, {
        logEpoch,
        throughSeq: taskSeq,
      });
      expect(await storage.getHorizonSeq(PARTITION)).toBe(taskSeq);
      // Horizon has passed seq 0; the history that would answer is gone.
      expect(await storage.hasSourceChangesAbove(PARTITION, ['tasks'], 0)).toBe(
        'unverifiable',
      );
      // Horizon equals seq: the window above seq is still intact.
      expect(
        await storage.hasSourceChangesAbove(PARTITION, ['tasks'], taskSeq),
      ).toBe('clean');
    } finally {
      await close();
    }
  });

  test(`${backend} an absent writer fence allows writes and a lower requirement still does`, async () => {
    const { storage, insert, close } = await harnessFn(key);
    try {
      // No row: no barrier on this partition.
      expect(await storage.writerFenceAllows(PARTITION, 1)).toBe(true);
      expect(await storage.writerFenceAllows('untouched', 1)).toBe(true);
      if (key === 'd1') {
        // D1 installs no fence; every partition keeps the no-barrier path.
        expect(await storage.writerFenceAllows(PARTITION, 0)).toBe(true);
        return;
      }

      await insert(FENCE_INSERT, FENCE_INSERT_PG, [PARTITION, 2]);
      expect(await storage.writerFenceAllows(PARTITION, 1)).toBe(false);
      expect(await storage.writerFenceAllows(PARTITION, 2)).toBe(true);
      expect(await storage.writerFenceAllows(PARTITION, 3)).toBe(true);
      // A different partition is unaffected by this partition's fence.
      expect(await storage.writerFenceAllows('other', 1)).toBe(true);
    } finally {
      await close();
    }
  });

  test(`${backend} the checkpoint table is not served as a synced table`, async () => {
    const { storage, close } = await harnessFn(key);
    try {
      await expect(
        Promise.resolve().then(() =>
          storage.getRow(PARTITION, 'sync_backfill_checkpoints', 'x'),
        ),
      ).rejects.toThrow(/unknown table/);
      await expect(
        Promise.resolve().then(() =>
          storage.getRow(PARTITION, 'sync_writer_fence', PARTITION),
        ),
      ).rejects.toThrow(/unknown table/);
    } finally {
      await close();
    }
  });
}

test('D1 never declares a checkpoint and the no-barrier path is unchanged', async () => {
  const { storage, close } = await harnessFn('d1');
  try {
    expect(await storage.readCheckpoints(PARTITION)).toEqual([]);
    expect(await storage.writerFenceAllows(PARTITION, 1)).toBe(true);
    // A normal commit still lands exactly as it does today.
    expect(await append(storage, 'tasks', 't1')).toBe(1);
    expect(await storage.getMaxCommitSeq(PARTITION)).toBe(1);
    expect(await storage.sourceCoverageSeq(PARTITION, ['tasks'])).toBe(1);
  } finally {
    await close();
  }
});

test('SQLite source-coverage queries run on sync_changes_by_table', () => {
  const db = new BunSqliteDatabase();
  const storage = new SqliteServerStorage(db);
  try {
    const plan = db
      .query<{ detail: string }, (string | number)[]>(
        'EXPLAIN QUERY PLAN SELECT max(commit_seq) AS seq FROM sync_changes WHERE partition=? AND tbl IN (?)',
      )
      .all('p', 'tasks');
    const above = db
      .query<{ detail: string }, (string | number)[]>(
        'EXPLAIN QUERY PLAN SELECT 1 AS hit FROM sync_changes WHERE partition=? AND tbl IN (?) AND commit_seq>? LIMIT 1',
      )
      .all('p', 'tasks', 100);
    const detail = [...plan, ...above].map((row) => row.detail).join('\n');
    expect(detail).toContain('sync_changes_by_table');
  } finally {
    storage.db.close();
  }
});

// -- RFC 0007 phase 2a: database-side writer fence and activation -----------

const COMMIT_OLD = `INSERT INTO sync_commits(
  partition, commit_seq, client_id, client_commit_id, actor_id, created_at_ms
) VALUES (?,?,?,?,?,?)`;
const COMMIT_OLD_PG = `INSERT INTO sync_commits(
  partition, commit_seq, client_id, client_commit_id, actor_id, created_at_ms
) VALUES ($1,$2,$3,$4,$5,$6)`;
const COMMIT_VERSIONED = `INSERT INTO sync_commits(
  partition, commit_seq, client_id, client_commit_id, actor_id,
  created_at_ms, writer_version
) VALUES (?,?,?,?,?,?,?)`;
const COMMIT_VERSIONED_PG = `INSERT INTO sync_commits(
  partition, commit_seq, client_id, client_commit_id, actor_id,
  created_at_ms, writer_version
) VALUES ($1,$2,$3,$4,$5,$6,$7)`;
const FENCE_UPSERT =
  'INSERT INTO sync_writer_fence(partition, required_writer_version) VALUES (?,?) ON CONFLICT(partition) DO UPDATE SET required_writer_version=excluded.required_writer_version';
const FENCE_UPSERT_PG =
  'INSERT INTO sync_writer_fence(partition, required_writer_version) VALUES ($1,$2) ON CONFLICT(partition) DO UPDATE SET required_writer_version=EXCLUDED.required_writer_version';
const SELECT_WRITER_VERSION =
  'SELECT writer_version FROM sync_commits WHERE partition=? AND commit_seq=?';
const SELECT_WRITER_VERSION_PG =
  'SELECT writer_version FROM sync_commits WHERE partition=$1 AND commit_seq=$2';

/** Raw commit-log append simulating a writer that omits `writer_version`. */
async function rawCommit(
  harness: Harness,
  seq: number,
  writerVersion: number | null,
): Promise<void> {
  if (writerVersion === null) {
    await harness.insert(COMMIT_OLD, COMMIT_OLD_PG, [
      PARTITION,
      seq,
      'c1',
      `cc-${seq}`,
      'a1',
      NOW,
    ]);
    return;
  }
  await harness.insert(COMMIT_VERSIONED, COMMIT_VERSIONED_PG, [
    PARTITION,
    seq,
    'c1',
    `cc-${seq}`,
    'a1',
    NOW,
    writerVersion,
  ]);
}

for (const backend of ['sqlite', 'postgres/pglite'] as const) {
  const key = backend === 'postgres/pglite' ? 'postgres' : 'sqlite';

  test(`${backend} absent fence allows an old writer; raised fence denies`, async () => {
    const harness = await harnessFn(key);
    try {
      // No fence row: the pre-RFC-0007 behaviour for every existing deployment.
      await rawCommit(harness, 1, null);
      // A requirement at or below the writer version allows the write.
      await harness.insert(FENCE_UPSERT, FENCE_UPSERT_PG, [PARTITION, 1]);
      await rawCommit(harness, 2, 1);
      // An explicit NULL is rejected while a fence exists, never bypassed by
      // a NULL comparison.
      await expect(rawCommit(harness, 3, null)).rejects.toThrow(
        /writer_fence_rejected/,
      );
      // A higher requirement denies a current-version row.
      await harness.insert(FENCE_UPSERT, FENCE_UPSERT_PG, [PARTITION, 99]);
      await expect(rawCommit(harness, 4, 1)).rejects.toThrow(
        /writer_fence_rejected/,
      );
    } finally {
      await harness.close();
    }
  });

  test(`${backend} acceptance 16: an old writer is denied right after a current append`, async () => {
    const harness = await harnessFn(key);
    try {
      await harness.insert(FENCE_UPSERT, FENCE_UPSERT_PG, [
        PARTITION,
        SCHEMA.version,
      ]);
      const seq = await append(harness.storage, 'tasks', 't1');
      const rows = await harness.query<{ writer_version: number | null }>(
        SELECT_WRITER_VERSION,
        SELECT_WRITER_VERSION_PG,
        [PARTITION, seq],
      );
      expect(rows[0]?.writer_version).toBe(SCHEMA.version);
      // Same database, immediately after the aware writer committed. A fence
      // whose declaration leaked between transactions would allow this.
      await expect(rawCommit(harness, seq + 1, null)).rejects.toThrow(
        /writer_fence_rejected/,
      );
    } finally {
      await harness.close();
    }
  });

  test(`${backend} declaration installs the checkpoint and the fence together`, async () => {
    const harness = await harnessFn(key);
    try {
      const declared = await harness.storage.declareCheckpoint(
        PARTITION,
        'tasks-projection',
        SCHEMA.version,
        NOW,
      );
      expect(declared.state).toBe('declared');
      const fence = await harness.query<{ required_writer_version: number }>(
        'SELECT required_writer_version FROM sync_writer_fence WHERE partition=?',
        'SELECT required_writer_version FROM sync_writer_fence WHERE partition=$1',
        [PARTITION],
      );
      expect(fence[0]?.required_writer_version).toBe(SCHEMA.version);
    } finally {
      await harness.close();
    }
  });

  test(`${backend} declaration raises the fence before any backfill`, async () => {
    const harness = await harnessFn(key);
    try {
      await harness.storage.declareCheckpoint(
        PARTITION,
        'tasks-projection',
        SCHEMA.version,
        NOW,
      );
      const claimed = await harness.storage.claimCheckpoint(
        PARTITION,
        'tasks-projection',
        SCHEMA.version,
        NOW,
      );
      expect(claimed.state).toBe('backfilling');
      // The backfill window: declared, not yet activated, old writers already
      // rejected. Raising the fence only at activation would pass here.
      await expect(rawCommit(harness, 1, null)).rejects.toThrow(
        /writer_fence_rejected/,
      );
    } finally {
      await harness.close();
    }
  });

  test(`${backend} acceptance 15: a pruned window never activates`, async () => {
    const harness = await harnessFn(key);
    try {
      const { logEpoch } = await harness.storage.touchPartition(
        PARTITION,
        NOW,
        'epoch',
      );
      const seq = await append(harness.storage, 'tasks', 't1');
      await harness.storage.pruneCommitsThrough(PARTITION, {
        logEpoch,
        throughSeq: seq,
      });
      await harness.storage.declareCheckpoint(
        PARTITION,
        'tasks-projection',
        SCHEMA.version,
        NOW,
      );
      const claimed = await harness.storage.claimCheckpoint(
        PARTITION,
        'tasks-projection',
        SCHEMA.version,
        NOW,
      );
      expect(
        await harness.storage.activateCheckpoint(
          PARTITION,
          'tasks-projection',
          claimed.ownerEpoch,
          0,
          ['tasks'],
          NOW,
        ),
      ).toBe('unverifiable');
      const after = (await harness.storage.readCheckpoints(PARTITION))[0];
      expect(after?.state).toBe('backfilling');
    } finally {
      await harness.close();
    }
  });

  test(`${backend} acceptance 5: reactivation applies nothing twice`, async () => {
    const harness = await harnessFn(key);
    try {
      const seq = await append(harness.storage, 'tasks', 't1');
      await harness.storage.declareCheckpoint(
        PARTITION,
        'tasks-projection',
        SCHEMA.version,
        NOW,
      );
      const claimed = await harness.storage.claimCheckpoint(
        PARTITION,
        'tasks-projection',
        SCHEMA.version,
        NOW,
      );
      expect(
        await harness.storage.activateCheckpoint(
          PARTITION,
          'tasks-projection',
          claimed.ownerEpoch,
          seq,
          ['tasks'],
          NOW + 1,
        ),
      ).toBe('activated');
      const activated = (await harness.storage.readCheckpoints(PARTITION))[0];
      expect(activated?.state).toBe('activated');
      expect(
        await harness.storage.activateCheckpoint(
          PARTITION,
          'tasks-projection',
          claimed.ownerEpoch,
          seq,
          ['tasks'],
          NOW + 2,
        ),
      ).toBe('stale');
      const after = (await harness.storage.readCheckpoints(PARTITION))[0];
      expect(after?.state).toBe('activated');
      expect(after?.watermark).toBe(seq);
      expect(after?.updatedAtMs).toBe(activated?.updatedAtMs);
    } finally {
      await harness.close();
    }
  });

  test(`${backend} acceptance 10: a superseded owner cannot activate`, async () => {
    const harness = await harnessFn(key);
    try {
      const seq = await append(harness.storage, 'tasks', 't1');
      await harness.storage.declareCheckpoint(
        PARTITION,
        'tasks-projection',
        SCHEMA.version,
        NOW,
      );
      const stale = await harness.storage.claimCheckpoint(
        PARTITION,
        'tasks-projection',
        SCHEMA.version,
        NOW,
      );
      const owner = await harness.storage.claimCheckpoint(
        PARTITION,
        'tasks-projection',
        SCHEMA.version,
        NOW,
      );
      expect(
        await harness.storage.activateCheckpoint(
          PARTITION,
          'tasks-projection',
          stale.ownerEpoch,
          seq,
          ['tasks'],
          NOW + 1,
        ),
      ).toBe('stale');
      expect(
        await harness.storage.advanceCheckpoint(
          PARTITION,
          'tasks-projection',
          stale.ownerEpoch,
          999,
          1,
          NOW + 1,
        ),
      ).toBe(false);
      const after = (await harness.storage.readCheckpoints(PARTITION))[0];
      expect(after?.state).toBe('backfilling');
      expect(after?.watermark).toBe(0);
      // The current owner can still activate the same row.
      expect(
        await harness.storage.activateCheckpoint(
          PARTITION,
          'tasks-projection',
          owner.ownerEpoch,
          seq,
          ['tasks'],
          NOW + 2,
        ),
      ).toBe('activated');
    } finally {
      await harness.close();
    }
  });

  test(`${backend} activation refuses when the fence was never raised`, async () => {
    const harness = await harnessFn(key);
    try {
      // A declared checkpoint without the matching fence is an inconsistent
      // database: activating it would certify a state old writers can decay.
      await harness.insert(CHECKPOINT_INSERT, CHECKPOINT_INSERT_PG, [
        PARTITION,
        'tasks-projection',
        SCHEMA.version,
        'declared',
        0,
        0,
        0,
        NOW,
      ]);
      const claimed = await harness.storage.claimCheckpoint(
        PARTITION,
        'tasks-projection',
        SCHEMA.version,
        NOW,
      );
      await expect(
        harness.storage.activateCheckpoint(
          PARTITION,
          'tasks-projection',
          claimed.ownerEpoch,
          0,
          ['tasks'],
          NOW,
        ),
      ).rejects.toMatchObject({
        code: 'sync.storage.checkpoint_fence_missing',
      });
      // A fence below the checkpoint's schema version is equally insufficient.
      await harness.insert(FENCE_UPSERT, FENCE_UPSERT_PG, [
        PARTITION,
        SCHEMA.version - 1,
      ]);
      await expect(
        harness.storage.activateCheckpoint(
          PARTITION,
          'tasks-projection',
          claimed.ownerEpoch,
          0,
          ['tasks'],
          NOW,
        ),
      ).rejects.toMatchObject({
        code: 'sync.storage.checkpoint_fence_missing',
      });
    } finally {
      await harness.close();
    }
  });

  test(`${backend} activation is one-way`, async () => {
    const harness = await harnessFn(key);
    try {
      const seq = await append(harness.storage, 'tasks', 't1');
      await harness.storage.declareCheckpoint(
        PARTITION,
        'tasks-projection',
        SCHEMA.version,
        NOW,
      );
      const claimed = await harness.storage.claimCheckpoint(
        PARTITION,
        'tasks-projection',
        SCHEMA.version,
        NOW,
      );
      expect(
        await harness.storage.activateCheckpoint(
          PARTITION,
          'tasks-projection',
          claimed.ownerEpoch,
          seq,
          ['tasks'],
          NOW,
        ),
      ).toBe('activated');
      // Claiming an activated checkpoint is refused, and re-declaring it
      // cannot move it back.
      await expect(
        harness.storage.claimCheckpoint(
          PARTITION,
          'tasks-projection',
          SCHEMA.version,
          NOW,
        ),
      ).rejects.toMatchObject({
        code: 'sync.storage.checkpoint_not_declared',
      });
      expect(
        (
          await harness.storage.declareCheckpoint(
            PARTITION,
            'tasks-projection',
            SCHEMA.version,
            NOW,
          )
        ).state,
      ).toBe('activated');
      expect(
        await harness.storage.activateCheckpoint(
          PARTITION,
          'tasks-projection',
          claimed.ownerEpoch,
          seq,
          ['tasks'],
          NOW + 1,
        ),
      ).toBe('stale');
      expect((await harness.storage.readCheckpoints(PARTITION))[0]?.state).toBe(
        'activated',
      );
    } finally {
      await harness.close();
    }
  });

  test(`${backend} acceptance 10: a superseded batch lands no projection rows`, async () => {
    const harness = await harnessFn(key);
    try {
      await harness.storage.declareCheckpoint(
        PARTITION,
        'tasks-projection',
        SCHEMA.version,
        NOW,
      );
      const stale = await harness.storage.claimCheckpoint(
        PARTITION,
        'tasks-projection',
        SCHEMA.version,
        NOW,
      );
      const owner = await harness.storage.claimCheckpoint(
        PARTITION,
        'tasks-projection',
        SCHEMA.version,
        NOW,
      );
      expect(owner.ownerEpoch).toBe(stale.ownerEpoch + 1);
      // A backfill batch: one transaction over the CAS and the row writes.
      const tx = await harness.storage.begin(PARTITION);
      await tx.lockPartitionForPush?.();
      const advanced = await tx.advanceCheckpoint(
        'tasks-projection',
        stale.ownerEpoch,
        0,
        1,
        NOW + 1,
      );
      if (advanced) {
        await tx.upsertRow('tasks', {
          rowId: 'proj-stale',
          serverVersion: 1,
          scopes: { project_id: 'p1' },
          payload: new Uint8Array([1]),
        });
        await tx.commit();
      } else {
        await tx.rollback();
      }
      expect(advanced).toBe(false);
      // The rows the stale owner would have written are absent, not merely
      // that the call returned false.
      expect(
        await harness.storage.getRow(PARTITION, 'tasks', 'proj-stale'),
      ).toBeUndefined();
      const after = (await harness.storage.readCheckpoints(PARTITION))[0];
      expect(after?.state).toBe('backfilling');
      expect(after?.watermark).toBe(0);
    } finally {
      await harness.close();
    }
  });
}

test('D1 refuses declaration and activation, and keeps the no-barrier path', async () => {
  const harness = await harnessFn('d1');
  try {
    await expect(
      harness.storage.declareCheckpoint(
        PARTITION,
        'tasks-projection',
        SCHEMA.version,
        NOW,
      ),
    ).rejects.toMatchObject({
      code: 'sync.storage.checkpoint_unsupported',
    });
    await expect(
      harness.storage.activateCheckpoint(
        PARTITION,
        'tasks-projection',
        1,
        0,
        ['tasks'],
        NOW,
      ),
    ).rejects.toMatchObject({
      code: 'sync.storage.checkpoint_unsupported',
    });
    // An old writer still appends: D1 installs no fence in this release.
    expect(await append(harness.storage, 'tasks', 't1')).toBe(1);
  } finally {
    await harness.close();
  }
});

for (const backend of ['sqlite', 'postgres/pglite'] as const) {
  const key = backend === 'postgres/pglite' ? 'postgres' : 'sqlite';

  test(`${backend} ensureSchema installs declarations inside the schema-bump transaction`, async () => {
    const harness = await harnessFn(key);
    const count = async (table: string): Promise<number> => {
      const rows = await harness.query<{ n: number }>(
        `SELECT count(*) AS n FROM ${table}`,
        `SELECT count(*) AS n FROM ${table}`,
        [],
      );
      return Number(rows[0]?.n);
    };
    const marker = async (): Promise<number | undefined> => {
      const rows = await harness.query<{ schema_version: number }>(
        'SELECT schema_version FROM sync_schema_meta WHERE id=1',
        'SELECT schema_version FROM sync_schema_meta WHERE id=1',
        [],
      );
      return rows[0]?.schema_version;
    };
    try {
      // Force a failure at the declaration insert, after the marker write has
      // already run inside the same transaction.
      await expect(
        harness.storage.ensureSchema(SCHEMA_V2, [
          { partition: PARTITION, name: 'boom', schemaVersion: Number.NaN },
        ]),
      ).rejects.toThrow();
      // Committed state after the forced failure: no bumped marker, no fence,
      // no declaration. No observer can see one side without the other.
      expect(await marker()).toBe(1);
      expect(await count('sync_backfill_checkpoints')).toBe(0);
      expect(await count('sync_writer_fence')).toBe(0);
      // The real bump commits marker, declaration and fence together.
      await harness.storage.ensureSchema(SCHEMA_V2, [
        { partition: PARTITION, name: 'ok', schemaVersion: 2 },
      ]);
      expect(await marker()).toBe(2);
      expect(await count('sync_backfill_checkpoints')).toBe(1);
      expect(await count('sync_writer_fence')).toBe(1);
    } finally {
      await harness.close();
    }
  });
}

for (const backend of ['sqlite', 'postgres/pglite'] as const) {
  const key = backend === 'postgres/pglite' ? 'postgres' : 'sqlite';
  const DECLARATION = {
    partition: PARTITION,
    name: 'tasks-projection',
    schemaVersion: SCHEMA.version,
  } as const;

  test(`${backend} acceptance: the authoritative path backfills under an idempotency key`, async () => {
    const harness = await harnessFn(key);
    try {
      const tasks = SCHEMA.tables.get('tasks');
      if (tasks === undefined) throw new Error('contract schema has no tasks');
      await harness.storage.declareCheckpoint(
        PARTITION,
        'tasks-projection',
        SCHEMA.version,
        NOW,
      );
      const claimed = await harness.storage.claimCheckpoint(
        PARTITION,
        'tasks-projection',
        SCHEMA.version,
        NOW,
      );
      const ctx: SyncRequestContext = {
        partition: PARTITION,
        actorId: 'a1',
        schema: CONTRACT_SCHEMA,
        storage: harness.storage,
        segments: new MemorySegmentStore(),
        resolveScopes: () => ({ project_id: ['p1'] }),
        clock: () => NOW,
      };
      const row = encodeSparseRow(tasks.columns, tasks.primaryKeyIndex, [
        'proj-1',
        'p1',
        null,
      ]);
      // The backfill is an ordinary server-authoritative write: the builder
      // reads the checkpoint CAS and returns the projection operations, so the
      // CAS, the row version, sync_changes, and the commit-log append all land
      // in one transaction under this idempotency key.
      const run = () =>
        processPushOperationsWithTrace(
          ctx,
          SCHEMA,
          { ok: true, allowed: { project_id: ['p1'] } },
          'backfill-client',
          'backfill-batch-1',
          async (tx) => {
            const advanced = await tx.advanceCheckpoint(
              'tasks-projection',
              claimed.ownerEpoch,
              0,
              1,
              NOW,
            );
            if (!advanced) throw new Error('superseded owner');
            return [
              {
                table: 'tasks',
                rowId: 'proj-1',
                op: 'upsert' as const,
                payload: row,
              },
            ];
          },
        );
      const first = await run();
      expect(first.replayed).toBe(false);
      const seq = first.frame.commitSeq;
      if (seq === undefined)
        throw new Error('applied commit has no commit_seq');
      expect(seq).toBeGreaterThan(0);

      const commits = await harness.query<{ writer_version: number | null }>(
        'SELECT writer_version FROM sync_commits WHERE partition=? AND commit_seq=?',
        'SELECT writer_version FROM sync_commits WHERE partition=$1 AND commit_seq=$2',
        [PARTITION, seq],
      );
      const fence = await harness.query<{ required_writer_version: number }>(
        'SELECT required_writer_version FROM sync_writer_fence WHERE partition=?',
        'SELECT required_writer_version FROM sync_writer_fence WHERE partition=$1',
        [PARTITION],
      );
      // The append recorded the writer version of an authoritative write, and
      // that version satisfies the fence the declaration raised.
      expect(Number(commits[0]?.writer_version)).toBe(SCHEMA.version);
      expect(Number(commits[0]?.writer_version)).toBeGreaterThanOrEqual(
        Number(fence[0]?.required_writer_version),
      );

      const changes = await harness.query<{ commit_seq: number }>(
        'SELECT commit_seq FROM sync_changes WHERE partition=? AND row_id=?',
        'SELECT commit_seq FROM sync_changes WHERE partition=$1 AND row_id=$2',
        [PARTITION, 'proj-1'],
      );
      expect(changes.map((change) => Number(change.commit_seq))).toEqual([seq]);
      expect(
        (await harness.storage.getRow(PARTITION, 'tasks', 'proj-1'))
          ?.serverVersion,
      ).toBe(1);

      expect(
        await harness.storage.activateCheckpoint(
          PARTITION,
          'tasks-projection',
          claimed.ownerEpoch,
          1,
          ['tasks'],
          NOW,
        ),
      ).toBe('activated');

      // RFC acceptance 5: the same batch under the same idempotency key
      // applies nothing twice, and the checkpoint stays activated.
      const second = await run();
      expect(second.replayed).toBe(true);
      expect(second.frame.commitSeq).toBe(seq);
      const after = await harness.query<{ n: number }>(
        `SELECT count(*) AS n FROM sync_changes
          WHERE partition=? AND row_id=?`,
        `SELECT count(*) AS n FROM sync_changes
          WHERE partition=$1 AND row_id=$2`,
        [PARTITION, 'proj-1'],
      );
      expect(Number(after[0]?.n)).toBe(1);
      expect((await harness.storage.readCheckpoints(PARTITION))[0]?.state).toBe(
        'activated',
      );
    } finally {
      await harness.close();
    }
  });

  test(`${backend} an omitted declaration against an incomplete checkpoint is refused`, async () => {
    const harness = await harnessFn(key);
    try {
      await harness.storage.declareCheckpoint(
        PARTITION,
        'tasks-projection',
        SCHEMA.version,
        NOW,
      );
      // A different process on the same database declares nothing.
      await expect(
        harness.storageAgain().ensureSchema(SCHEMA),
      ).rejects.toMatchObject({ code: 'sync.storage.checkpoint_incomplete' });
      await expect(
        harness.storageAgain().ensureSchema(SCHEMA, []),
      ).rejects.toMatchObject({ code: 'sync.storage.checkpoint_incomplete' });
      // The primary readiness path is refused too: the thrown storage error
      // surfaces as the whole-server `sync.schema_not_ready`.
      await expect(
        ensureSyncServerReady({
          schema: CONTRACT_SCHEMA,
          storage: harness.storageAgain(),
        }),
      ).rejects.toMatchObject({ code: 'sync.schema_not_ready' });
      // A process that declares the checkpoint is allowed to serve.
      await ensureSyncServerReady({
        schema: CONTRACT_SCHEMA,
        storage: harness.storageAgain(),
        checkpoints: [DECLARATION],
      });
      // Activated is terminal: a later process need declare nothing.
      expect(
        await harness.storage.activateCheckpoint(
          PARTITION,
          'tasks-projection',
          0,
          0,
          ['tasks'],
          NOW,
        ),
      ).toBe('activated');
      await harness.storageAgain().ensureSchema(SCHEMA);
    } finally {
      await harness.close();
    }
  });

  test(`${backend} a matching declaration restart is a no-op`, async () => {
    const harness = await harnessFn(key);
    try {
      await harness.storage.declareCheckpoint(
        PARTITION,
        'tasks-projection',
        SCHEMA.version,
        NOW,
      );
      const claimed = await harness.storage.claimCheckpoint(
        PARTITION,
        'tasks-projection',
        SCHEMA.version,
        NOW,
      );
      const fenceBefore = await harness.query<{
        required_writer_version: number;
      }>(
        'SELECT required_writer_version FROM sync_writer_fence WHERE partition=?',
        'SELECT required_writer_version FROM sync_writer_fence WHERE partition=$1',
        [PARTITION],
      );
      await harness.storageAgain().ensureSchema(SCHEMA, [DECLARATION]);
      const after = (await harness.storage.readCheckpoints(PARTITION))[0];
      expect(after?.state).toBe('backfilling');
      expect(after?.ownerEpoch).toBe(claimed.ownerEpoch);
      const fenceAfter = await harness.query<{
        required_writer_version: number;
      }>(
        'SELECT required_writer_version FROM sync_writer_fence WHERE partition=?',
        'SELECT required_writer_version FROM sync_writer_fence WHERE partition=$1',
        [PARTITION],
      );
      expect(Number(fenceAfter[0]?.required_writer_version)).toBe(
        Number(fenceBefore[0]?.required_writer_version),
      );
    } finally {
      await harness.close();
    }
  });

  test(`${backend} two processes declaring different sets coexist`, async () => {
    const harness = await harnessFn(key);
    try {
      await harness.storage.declareCheckpoint(
        PARTITION,
        'set-a',
        SCHEMA.version,
        NOW,
      );
      await harness
        .storageAgain()
        .declareCheckpoint(PARTITION, 'set-b', SCHEMA.version, NOW);
      const checkpoints = await harness.storage.readCheckpoints(PARTITION);
      expect(checkpoints.map((checkpoint) => checkpoint.name)).toEqual([
        'set-a',
        'set-b',
      ]);
      expect(
        checkpoints.every((checkpoint) => checkpoint.state === 'declared'),
      ).toBe(true);
      const fence = await harness.query<{ required_writer_version: number }>(
        'SELECT required_writer_version FROM sync_writer_fence WHERE partition=?',
        'SELECT required_writer_version FROM sync_writer_fence WHERE partition=$1',
        [PARTITION],
      );
      expect(Number(fence[0]?.required_writer_version)).toBe(SCHEMA.version);
      // A process is allowed only when it declares every incomplete checkpoint:
      // declaring one of two is refused, declaring both is allowed.
      await expect(
        harness
          .storageAgain()
          .ensureSchema(SCHEMA, [
            {
              partition: PARTITION,
              name: 'set-b',
              schemaVersion: SCHEMA.version,
            },
          ]),
      ).rejects.toMatchObject({ code: 'sync.storage.checkpoint_incomplete' });
      await harness.storageAgain().ensureSchema(SCHEMA, [
        { partition: PARTITION, name: 'set-a', schemaVersion: SCHEMA.version },
        { partition: PARTITION, name: 'set-b', schemaVersion: SCHEMA.version },
      ]);
    } finally {
      await harness.close();
    }
  });

  test(`${backend} a failed bump rolls back the fence and the declaration`, async () => {
    const harness = await harnessFn(key);
    try {
      await harness.storage.ensureSchema(SCHEMA_V2, [
        { partition: PARTITION, name: 'ok', schemaVersion: 2 },
      ]);
      const SCHEMA_V3 = compileSchema({ ...CONTRACT_SCHEMA, version: 3 });
      await expect(
        harness.storageAgain().ensureSchema(SCHEMA_V3, [
          { partition: PARTITION, name: 'half', schemaVersion: 3 },
          { partition: PARTITION, name: 'boom', schemaVersion: Number.NaN },
        ]),
      ).rejects.toThrow();
      expect(
        (await harness.storage.readCheckpoints(PARTITION)).map(
          (checkpoint) => checkpoint.name,
        ),
      ).toEqual(['ok']);
      const fence = await harness.query<{ required_writer_version: number }>(
        'SELECT required_writer_version FROM sync_writer_fence WHERE partition=?',
        'SELECT required_writer_version FROM sync_writer_fence WHERE partition=$1',
        [PARTITION],
      );
      expect(Number(fence[0]?.required_writer_version)).toBe(2);
      const marker = await harness.query<{ schema_version: number }>(
        'SELECT schema_version FROM sync_schema_meta WHERE id=1',
        'SELECT schema_version FROM sync_schema_meta WHERE id=1',
        [],
      );
      expect(Number(marker[0]?.schema_version)).toBe(2);
    } finally {
      await harness.close();
    }
  });
}
