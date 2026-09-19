/**
 * RFC 0007 real-PostgreSQL concurrency receipts — env-gated on
 * `SYNCULAR_PG_URL`, exactly like `postgres-fanout.integration.test.ts`.
 *
 * pglite globally FIFOs `transaction()`, so acceptance 11, 12 and 16 are
 * only evidence against a real Postgres reachable at `SYNCULAR_PG_URL`;
 * without it the whole block skips cleanly (a clean skip is not a pass).
 *
 *   SYNCULAR_PG_URL=postgres://user:pass@localhost:5432/db \
 *     bun test packages/server/test/postgres-checkpoints.integration.test.ts
 */
import { afterAll, describe, expect, test } from 'bun:test';
import {
  compileSchema,
  type PgExecutor,
  type PgQueryable,
  PostgresServerStorage,
  type ServerSchema,
} from '@syncular/server';

const PG_URL = process.env.SYNCULAR_PG_URL;

// oxlint-disable-next-line typescript/no-explicit-any -- Bun.sql is version-fluid.
const BunSQL = (Bun as any).SQL as undefined | (new (url: string) => any);

const gate =
  PG_URL !== undefined && BunSQL !== undefined ? describe : describe.skip;

const SCHEMA: ServerSchema = {
  version: 1,
  tables: [
    {
      name: 'tasks',
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'project_id', type: 'string', nullable: false },
        { name: 'title', type: 'string', nullable: false },
      ],
      primaryKey: 'id',
      scopes: ['project:{project_id}'],
    },
  ],
};

// oxlint-disable-next-line typescript/no-explicit-any -- driver handle is dynamic.
function queryableOver(handle: any): PgQueryable {
  return {
    async query<Row = Record<string, unknown>>(
      text: string,
      params?: readonly unknown[],
    ) {
      const rows = (await handle.unsafe(
        text,
        params ? [...params] : [],
      )) as Row[];
      return { rows, rowCount: rows.length };
    },
  };
}

// oxlint-disable-next-line typescript/no-explicit-any -- driver handle is dynamic.
function bunSqlExecutor(sql: any): PgExecutor {
  const q = queryableOver(sql);
  return {
    query: q.query,
    async transaction<T>(fn: (client: PgQueryable) => Promise<T>): Promise<T> {
      // oxlint-disable-next-line typescript/no-explicit-any -- dynamic tx handle.
      return sql.begin(async (tx: any) => fn(queryableOver(tx)));
    },
    async close() {
      await sql.end();
    },
  };
}

/** A raw commit-log insert that bypasses the storage's writer_version. */
async function rawAppend(
  executor: PgExecutor,
  partition: string,
  commitSeq: number,
  writerVersion: number | null,
): Promise<void> {
  await executor.query(
    `INSERT INTO sync_commits(
       partition, commit_seq, client_id, client_commit_id, actor_id,
       created_at_ms, writer_version)
     VALUES ($1,$2,'old','old-1','a1',$3,$4)`,
    [partition, commitSeq, Date.now(), writerVersion],
  );
}

gate('RFC 0007 real-Postgres receipts (SYNCULAR_PG_URL)', () => {
  // oxlint-disable-next-line typescript/no-explicit-any -- dynamic Bun.sql handles.
  const handles: any[] = [];
  afterAll(async () => {
    for (const handle of handles) await handle.end?.().catch(() => {});
  });

  async function fresh(): Promise<{
    storage: PostgresServerStorage;
    partition: string;
    executor: PgExecutor;
  }> {
    const sql = new (BunSQL as new (url: string) => unknown)(PG_URL as string);
    handles.push(sql);
    const executor = bunSqlExecutor(sql);
    const storage = new PostgresServerStorage(executor);
    await storage.migrate();
    // The three receipts share one real database. The phase-2a declaration
    // coverage check is whole-server, not partition-scoped, so a checkpoint
    // (and its fence) left declared by an earlier receipt would refuse this
    // one's declaration-free `ensureSchema`. Clear the barrier tables for test
    // isolation; the gate itself is unchanged.
    await executor.query('DELETE FROM sync_backfill_checkpoints');
    await executor.query('DELETE FROM sync_writer_fence');
    const partition = `rfc0007-${crypto.randomUUID()}`;
    await storage.ensureSchema(compileSchema(SCHEMA));
    return { storage, partition, executor };
  }

  test('acceptance 16: an old writer is denied immediately after a current append', async () => {
    const { storage, partition, executor } = await fresh();
    await storage.declareCheckpoint(
      partition,
      'tasks-projection',
      1,
      Date.now(),
    );
    const tx = await storage.begin(partition);
    await tx.appendCommit({
      clientId: 'current',
      clientCommitId: 'current-1',
      actorId: 'a1',
      createdAtMs: Date.now(),
      changes: [
        {
          table: 'tasks',
          rowId: 'r1',
          op: 'upsert',
          rowVersion: 1,
          scopes: { project_id: 'p1' },
          payload: new Uint8Array([1]),
        },
      ],
    });
    await tx.commit();
    // The current writer's append is committed; an old writer's raw insert and
    // one that omits writer_version entirely (NULL) are both rejected by the
    // database-side trigger.
    await expect(rawAppend(executor, partition, 99, 0)).rejects.toThrow(
      /writer_fence_rejected/,
    );
    await expect(rawAppend(executor, partition, 97, null)).rejects.toThrow(
      /writer_fence_rejected/,
    );
  });

  test('acceptance 12: an old writer after activation cannot commit a source mutation', async () => {
    const { storage, partition, executor } = await fresh();
    await storage.declareCheckpoint(
      partition,
      'tasks-projection',
      1,
      Date.now(),
    );
    await storage.claimCheckpoint(partition, 'tasks-projection', 1, Date.now());
    expect(
      await storage.activateCheckpoint(
        partition,
        'tasks-projection',
        1,
        0,
        ['tasks'],
        Date.now(),
      ),
    ).toBe('activated');
    await expect(rawAppend(executor, partition, 98, 0)).rejects.toThrow(
      /writer_fence_rejected/,
    );
    // A current writer still commits after activation.
    const tx = await storage.begin(partition);
    const seq = await tx.appendCommit({
      clientId: 'current',
      clientCommitId: 'current-2',
      actorId: 'a1',
      createdAtMs: Date.now(),
      changes: [
        {
          table: 'tasks',
          rowId: 'r2',
          op: 'upsert',
          rowVersion: 1,
          scopes: { project_id: 'p1' },
          payload: new Uint8Array([2]),
        },
      ],
    });
    await tx.commit();
    expect(seq).toBeGreaterThan(0);
  });

  test('acceptance 11: activation loses to a concurrent source write, then retry activates', async () => {
    const { storage, partition } = await fresh();
    await storage.declareCheckpoint(
      partition,
      'tasks-projection',
      1,
      Date.now(),
    );
    const owner = await storage.claimCheckpoint(
      partition,
      'tasks-projection',
      1,
      Date.now(),
    );
    // A source write lands after the claim and before activation.
    const tx = await storage.begin(partition);
    await tx.appendCommit({
      clientId: 'current',
      clientCommitId: 'current-3',
      actorId: 'a1',
      createdAtMs: Date.now(),
      changes: [
        {
          table: 'tasks',
          rowId: 'r3',
          op: 'upsert',
          rowVersion: 1,
          scopes: { project_id: 'p1' },
          payload: new Uint8Array([3]),
        },
      ],
    });
    await tx.commit();
    // The stale watermark loses; no false complete.
    expect(
      await storage.activateCheckpoint(
        partition,
        'tasks-projection',
        owner.ownerEpoch,
        0,
        ['tasks'],
        Date.now(),
      ),
    ).toBe('stale');
    // Catch up to the observed coverage and retry.
    expect(
      await storage.activateCheckpoint(
        partition,
        'tasks-projection',
        owner.ownerEpoch,
        1,
        ['tasks'],
        Date.now(),
      ),
    ).toBe('activated');
    const after = (await storage.readCheckpoints(partition))[0];
    expect(after?.state).toBe('activated');
    expect(after?.watermark).toBe(1);
  });

  test('B1: the migration transaction blocks a raw old writer at its first statement', async () => {
    // Three real connections, ZERO advisory calls, genuine interleaving:
    //  - `sqlA` runs the schema-bump transaction, held open after its first
    //    statement (`LOCK TABLE sync_partitions IN EXCLUSIVE MODE`);
    //  - `sqlB` runs the exact pre-migration (base 8b22d819) writer path with
    //    raw SQL: `SELECT max_commit_seq … FOR UPDATE`, a pre-migration app-row
    //    upsert, then a raw `sync_commits` insert that omits `writer_version`;
    //  - `sqlC` observes `pg_locks` / `pg_stat_activity`.
    // The old writer must block on the relation lock before any write. Once the
    // migration commits the raised fence, the trigger rejects the append, the
    // whole old-writer transaction rolls back (no stale source row), and the
    // fence is visible. Against `d1468ede` (no migration lock) the writer is
    // never blocked: `observedWaiting` is 0 and the append lands.
    const sqlA = new (BunSQL as new (url: string) => unknown)(PG_URL as string);
    const sqlB = new (BunSQL as new (url: string) => unknown)(PG_URL as string);
    const sqlC = new (BunSQL as new (url: string) => unknown)(PG_URL as string);
    handles.push(sqlA, sqlB, sqlC);
    const observer = queryableOver(sqlC);
    const partition = `rfc0007-b1-${crypto.randomUUID()}`;

    // Bootstrap the pre-migration database state on a plain connection. Clear
    // any barrier rows another receipt left behind; the phase-2a coverage check
    // is whole-server.
    const bootstrap = new PostgresServerStorage(bunSqlExecutor(sqlB));
    await observer.query('DELETE FROM sync_backfill_checkpoints');
    await observer.query('DELETE FROM sync_writer_fence');
    await bootstrap.ensureSchema(compileSchema(SCHEMA));

    const paused = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const baseA = bunSqlExecutor(sqlA);
    const gatedA: PgExecutor = {
      query: baseA.query,
      async transaction<T>(fn: (client: PgQueryable) => Promise<T>) {
        return baseA.transaction(async (client) => {
          let first = true;
          const gated: PgQueryable = {
            async query<Row = Record<string, unknown>>(
              text: string,
              params?: readonly unknown[],
            ) {
              const result = await client.query<Row>(text, params);
              if (first) {
                first = false;
                paused.resolve();
                await release.promise;
              }
              return result;
            },
          };
          return fn(gated);
        });
      },
      close: () => baseA.close?.() ?? Promise.resolve(),
    };

    const migration = new PostgresServerStorage(gatedA).ensureSchema(
      compileSchema({ ...SCHEMA, version: 2 }),
      [{ partition, name: 'tasks-projection', schemaVersion: 2 }],
    );
    await paused.promise;

    // The migration holds `sync_partitions` EXCLUSIVE as a relation lock.
    const migrationHoldsExclusive = Number(
      (
        await observer.query<{ n: unknown }>(
          `SELECT count(*) AS n FROM pg_locks
            WHERE locktype='relation'
              AND relation='sync_partitions'::regclass
              AND mode='ExclusiveLock' AND granted`,
        )
      ).rows[0]?.n,
    );
    expect(migrationHoldsExclusive).toBeGreaterThan(0);

    // The exact old writer path: raw SQL, no advisory call anywhere.
    const writerStarted = Promise.withResolvers<void>();
    const writer = (async (): Promise<void> => {
      // oxlint-disable-next-line typescript/no-explicit-any -- dynamic tx handle.
      await (sqlB as any).begin(async (tx: any) => {
        writerStarted.resolve();
        await tx.unsafe(
          'SELECT max_commit_seq FROM sync_partitions WHERE partition=$1 FOR UPDATE',
          [partition],
        );
        await tx.unsafe(
          `INSERT INTO tasks(
             _sync_partition, _sync_row_id, id, project_id, title,
             _sync_server_version, _sync_scopes, _sync_payload)
           VALUES ($1,'old-row','old-row','p1','old',1,'{}'::jsonb,'\\x0100'::bytea)
           ON CONFLICT (_sync_partition, _sync_row_id)
           DO UPDATE SET title=EXCLUDED.title`,
          [partition],
        );
        await tx.unsafe(
          `INSERT INTO sync_commits(
             partition, commit_seq, client_id, client_commit_id, actor_id,
             created_at_ms)
           VALUES ($1, 999, 'old', 'old-1', 'a1', $2)`,
          [partition, Date.now()],
        );
      });
    })();
    await writerStarted.promise;

    const relationWaiter = async (): Promise<number> =>
      Number(
        (
          await observer.query<{ n: unknown }>(
            `SELECT count(*) AS n FROM pg_locks
              WHERE locktype='relation'
                AND relation='sync_partitions'::regclass
                AND NOT granted`,
          )
        ).rows[0]?.n,
      );
    const lockWaiter = async (): Promise<number> =>
      Number(
        (
          await observer.query<{ n: unknown }>(
            "SELECT count(*) AS n FROM pg_stat_activity WHERE wait_event_type='Lock'",
          )
        ).rows[0]?.n,
      );
    let observedWaiting = 0;
    let observedLockWaits = 0;
    for (let attempt = 0; attempt < 500 && observedWaiting === 0; attempt++) {
      observedWaiting = await relationWaiter();
      observedLockWaits = await lockWaiter();
    }
    // Always release the migration before asserting so a failed run never
    // leaves the migration transaction open.
    release.resolve();
    await migration;
    let writerError: unknown;
    try {
      await writer;
    } catch (error) {
      writerError = error;
    }

    // The raw old writer was actually blocked on the migration's relation lock.
    expect(observedWaiting).toBeGreaterThan(0);
    expect(observedLockWaits).toBeGreaterThan(0);

    // The migration committed the raised fence; the old append was rejected and
    // the whole old-writer transaction rolled back.
    const fence = await observer.query<{ required_writer_version: unknown }>(
      'SELECT required_writer_version FROM sync_writer_fence WHERE partition=$1',
      [partition],
    );
    expect(Number(fence.rows[0]?.required_writer_version)).toBe(2);
    expect(String(writerError)).toMatch(/writer_fence_rejected/);
    const sourceRows = await observer.query<{ n: unknown }>(
      'SELECT count(*) AS n FROM tasks WHERE _sync_partition=$1',
      [partition],
    );
    expect(Number(sourceRows.rows[0]?.n)).toBe(0);
    const commits = await observer.query<{ n: unknown }>(
      'SELECT count(*) AS n FROM sync_commits WHERE partition=$1',
      [partition],
    );
    expect(Number(commits.rows[0]?.n)).toBe(0);
  });
});
