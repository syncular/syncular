/**
 * The scan-before-LIMIT regression guard (REVISE B2). v1's production wound
 * was that scope fanout on Postgres scanned the commit log before applying
 * LIMIT. This test asserts, via `EXPLAIN`, that the candidate-selection
 * queries behind `readCommitWindow` and `scanRows` are driven by the
 * inverted-scope-index PRIMARY KEY — an `Index`/`Index Only Scan` node, never
 * a `Seq Scan` on the scope tables — so the regression cannot silently
 * return.
 *
 * We seed enough rows across enough scope values that the planner has a real
 * choice, and additionally pin the intent with `SET LOCAL enable_seqscan =
 * off` inside the EXPLAIN transaction: if the covering index were missing or
 * mis-ordered the planner could not satisfy the ORDER BY … LIMIT with an
 * index range scan and the assertion would fail.
 */

import { expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { PostgresServerStorage } from '@syncular-v2/server';
import { pgliteExecutor } from '@syncular-v2/server/pglite';

const PARTITION = 'part-1';
const NOW = 1_750_000_000_000;
const PROJECTS = 20;
const ROWS = 2_000;

async function seededStorage(): Promise<{
  storage: PostgresServerStorage;
  db: PGlite;
}> {
  const db = await PGlite.create();
  const storage = new PostgresServerStorage(pgliteExecutor(db));
  await storage.migrate();
  // Spread rows/commits across PROJECTS scope values so a single value is a
  // small, index-worthy slice of the whole.
  for (let i = 0; i < ROWS; i++) {
    const project = `p${i % PROJECTS}`;
    const tx = await storage.begin(PARTITION);
    await tx.upsertRow('tasks', {
      rowId: `r${String(i).padStart(6, '0')}`,
      serverVersion: 1,
      scopes: { project_id: project },
      payload: new Uint8Array([i & 0xff]),
    });
    await tx.appendCommit({
      clientId: 'c',
      clientCommitId: `k${i}`,
      actorId: 'a',
      createdAtMs: NOW + i,
      changes: [
        {
          table: 'tasks',
          rowId: `r${String(i).padStart(6, '0')}`,
          op: 'upsert',
          rowVersion: 1,
          scopes: { project_id: project },
          payload: new Uint8Array([i & 0xff]),
        },
      ],
    });
    await tx.commit();
  }
  await db.exec('ANALYZE');
  return { storage, db };
}

/** Run EXPLAIN with seqscan disabled and return the flattened plan text. */
async function explain(
  db: PGlite,
  sql: string,
  params: unknown[],
): Promise<string> {
  await db.exec('BEGIN');
  await db.exec('SET LOCAL enable_seqscan = off');
  const result = await db.query<{ 'QUERY PLAN': string }>(
    `EXPLAIN ${sql}`,
    params,
  );
  await db.exec('COMMIT');
  return result.rows.map((r) => r['QUERY PLAN']).join('\n');
}

test('readCommitWindow candidate scan is index-driven (no Seq Scan)', async () => {
  const { db } = await seededStorage();
  const plan = await explain(
    db,
    `SELECT DISTINCT commit_seq FROM sync_change_scopes
     WHERE partition=$1 AND tbl=$2 AND var=$3 AND value IN ($4)
       AND commit_seq>$5 AND commit_seq<=$6
     ORDER BY commit_seq LIMIT $7`,
    [PARTITION, 'tasks', 'project_id', 'p3', 0, ROWS, 64],
  );
  expect(plan).toContain('Index');
  expect(plan).not.toContain('Seq Scan on sync_change_scopes');
  await db.close();
});

test('scanRows candidate scan is index-driven (no Seq Scan)', async () => {
  const { db } = await seededStorage();
  const plan = await explain(
    db,
    `SELECT DISTINCT row_id FROM sync_row_scopes
     WHERE partition=$1 AND tbl=$2 AND var=$3 AND value IN ($4)
       AND row_id>$5
     ORDER BY row_id LIMIT $6`,
    [PARTITION, 'tasks', 'project_id', 'p3', '', 64],
  );
  expect(plan).toContain('Index');
  expect(plan).not.toContain('Seq Scan on sync_row_scopes');
  await db.close();
});
