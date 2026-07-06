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
import { encodeRow, type RowColumn } from '@syncular/core';
import {
  compileSchema,
  PostgresServerStorage,
  type ServerSchema,
  scanRowPageSql,
} from '@syncular/server';
import { pgliteExecutor } from '@syncular/server/pglite';

const PARTITION = 'part-1';
const NOW = 1_750_000_000_000;
const PROJECTS = 20;
const ROWS = 2_000;

const COLUMNS: readonly RowColumn[] = [
  { name: 'id', type: 'string', nullable: false },
  { name: 'project_id', type: 'string', nullable: false },
];
const SCHEMA: ServerSchema = {
  version: 1,
  tables: [
    {
      name: 'tasks',
      columns: COLUMNS,
      primaryKey: 'id',
      scopes: ['project:{project_id}'],
    },
  ],
};

async function seededStorage(): Promise<{
  storage: PostgresServerStorage;
  db: PGlite;
}> {
  const db = await PGlite.create();
  const storage = new PostgresServerStorage(pgliteExecutor(db));
  await storage.ensureSchema(compileSchema(SCHEMA));
  // Spread rows/commits across PROJECTS scope values so a single value is a
  // small, index-worthy slice of the whole.
  for (let i = 0; i < ROWS; i++) {
    const project = `p${i % PROJECTS}`;
    const tx = await storage.begin(PARTITION);
    const rowId = `r${String(i).padStart(6, '0')}`;
    await tx.upsertRow('tasks', {
      rowId,
      serverVersion: 1,
      scopes: { project_id: project },
      payload: encodeRow(COLUMNS, [rowId, project]),
    });
    // Spread blob references across PROJECTS distinct blobIds so a single
    // blobId is a small, index-worthy slice of sync_blob_refs.
    await tx.setBlobRefs?.('tasks', `r${String(i).padStart(6, '0')}`, [
      `sha256:${String(i % PROJECTS).padStart(64, '0')}`,
    ]);
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

test('scanRows page scan is index-driven (no Seq Scan)', async () => {
  const { db } = await seededStorage();
  // The real page query (candidate subquery + row-table LEFT JOIN): the
  // candidate side must stay an index range on the sync_row_scopes PK, and
  // the join side must hit the row table's (partition, row_id) PK.
  const table = compileSchema(SCHEMA).tables.get('tasks');
  if (table === undefined) throw new Error('tasks not compiled');
  const plan = await explain(db, scanRowPageSql(table, 1, 'postgres'), [
    PARTITION,
    'tasks',
    'project_id',
    'p3',
    '',
    64,
  ]);
  expect(plan).toContain('Index');
  expect(plan).not.toContain('Seq Scan on sync_row_scopes');
  expect(plan).not.toContain('Seq Scan on tasks');
  await db.close();
});

test('listRowsReferencingBlob candidate scan is index-driven (no Seq Scan)', async () => {
  const { db } = await seededStorage();
  // The by-blob secondary index (partition, blob_id) drives the §5.9.5
  // download-authorization candidate set; it must be an index range, not a
  // scan of every reference in the partition.
  const plan = await explain(
    db,
    `SELECT tbl, row_id FROM sync_blob_refs WHERE partition=$1 AND blob_id=$2`,
    [PARTITION, `sha256:${String(3).padStart(64, '0')}`],
  );
  expect(plan).toContain('Index');
  expect(plan).not.toContain('Seq Scan on sync_blob_refs');
  await db.close();
});
