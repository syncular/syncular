/**
 * RFC 0007 phase 1: backfill checkpoint and writer-fence storage primitives.
 *
 * Runs against all three in-tree backends so the Postgres row-lock claim and
 * the D1 single-statement compare-and-set are held to the SQLite reference
 * (`storage.ts:462-473`: a SQLite-only pass conceals the Postgres race).
 */
import { expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import {
  D1ServerStorage,
  PostgresServerStorage,
  SqliteServerStorage,
  StorageQueryError,
  type ServerStorage,
  compileSchema,
} from '@syncular/server';
import { pgliteExecutor } from '@syncular/server/pglite';
import { BunSqliteDatabase } from '@syncular/server/sqlite';
import { D1DatabaseDouble } from './d1-double';
import { CONTRACT_SCHEMA } from './storage-contract';

const PARTITION = 'part-1';
const NOW = 1_750_000_000_000;
const SCHEMA = compileSchema(CONTRACT_SCHEMA);

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
  /** Raw insert: `?` placeholders for SQLite/D1, `$n` for Postgres. */
  insert(sqliteSql: string, pgSql: string, params: unknown[]): Promise<void>;
  close(): Promise<void>;
}

async function harness(
  backend: 'sqlite' | 'postgres' | 'd1',
): Promise<Harness> {
  if (backend === 'sqlite') {
    const db = new BunSqliteDatabase();
    const storage = new SqliteServerStorage(db);
    await storage.ensureSchema(SCHEMA);
    return {
      storage,
      insert: async (sqliteSql, _pgSql, params) => {
        db.query(sqliteSql).run(...(params as never[]));
      },
      close: async () => db.close(),
    };
  }
  if (backend === 'postgres') {
    const pg = await PGlite.create();
    const storage = new PostgresServerStorage(pgliteExecutor(pg));
    await storage.ensureSchema(SCHEMA);
    return {
      storage,
      insert: async (_sqliteSql, pgSql, params) => {
        await pg.query(pgSql, params);
      },
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
    insert: async (sqliteSql, _pgSql, params) => {
      await d1
        .prepare(sqliteSql)
        .bind(...params)
        .run();
    },
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
    const { storage, insert, close } = await harness(key);
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
    const { storage, insert, close } = await harness(key);
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
    const { storage, close } = await harness(key);
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
    const { storage, close } = await harness(key);
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
    const { storage, insert, close } = await harness(key);
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
    const { storage, close } = await harness(key);
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
  const { storage, close } = await harness('d1');
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
