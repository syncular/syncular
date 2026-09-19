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
  writerVersion: number,
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
    // The current writer's append is committed; the old writer's raw insert
    // is rejected by the database-side trigger.
    await expect(rawAppend(executor, partition, 99, 0)).rejects.toThrow(
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
    const activated = await storage.activateCheckpoint(
      partition,
      'tasks-projection',
      1,
      0,
      ['tasks'],
      Date.now(),
    );
    // RFC0007-DEBUG
    console.error(
      'RFC0007-DEBUG',
      JSON.stringify({
        activated,
        partition,
        coverage: await storage.sourceCoverageSeq(partition, ['tasks']),
        checkpoints: await storage.readCheckpoints(partition),
        changes: (
          await executor.query(
            'SELECT partition, tbl, commit_seq, row_id FROM sync_changes ORDER BY commit_seq',
          )
        ).rows,
        partitions: (
          await executor.query(
            'SELECT partition, max_commit_seq, horizon_seq FROM sync_partitions ORDER BY partition',
          )
        ).rows,
      }),
    );
    expect(activated).toBe('activated');
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
});
