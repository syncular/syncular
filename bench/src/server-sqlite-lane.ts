/**
 * Server SQLite lane on a multi-million-row projection table (file-backed
 * `bun:sqlite`). It measures the three storage costs that grow with the
 * table:
 *
 * - a schema bump with unchanged, partly changed, and new declared indexes;
 * - an app-side lookup `WHERE owner_id=? AND id=?` without the partition,
 *   before and after a `serverIndexes` entry leads with those columns;
 * - authenticated-partition registry writes (`touchPartition`) per request.
 *
 * Run: `bun src/server-sqlite-lane.ts [--rows 3000000]`. Each bump reports the
 * wall time of `ensureSchema` for that schema version.
 */
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RowColumn } from '@syncular/core';
import {
  compileSchema,
  type ServerSchema,
  SqliteServerStorage,
} from '@syncular/server';
import { BunSqliteDatabase } from '@syncular/server/sqlite';

const rowsArg = process.argv.indexOf('--rows');
const ROWS = rowsArg === -1 ? 3_000_000 : Number(process.argv[rowsArg + 1]);
const OWNERS = 5_000;

const COLUMNS: readonly RowColumn[] = [
  { name: 'id', type: 'string', nullable: false },
  { name: 'owner_id', type: 'string', nullable: false },
  { name: 'title', type: 'string', nullable: false },
  { name: 'status', type: 'string', nullable: true },
];

type Table = ServerSchema['tables'][number];

function schema(
  version: number,
  indexes: NonNullable<Table['indexes']>,
  serverIndexes?: Table['serverIndexes'],
): ServerSchema {
  return {
    version,
    tables: [
      {
        name: 'assertions',
        columns: COLUMNS,
        primaryKey: 'id',
        scopes: ['owner:{owner_id}'],
        indexes,
        ...(serverIndexes === undefined ? {} : { serverIndexes }),
      },
    ],
  };
}

const declared = [
  { name: 'by_title', columns: ['title'] },
  { name: 'by_owner_title', columns: ['owner_id', 'title'] },
  { name: 'by_status', columns: ['status', 'owner_id'] },
];

const dir = mkdtempSync(join(tmpdir(), 'syncular-server-sqlite-'));
const native = new Database(join(dir, 'sync.db'));
native.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL');
const storage = new SqliteServerStorage(new BunSqliteDatabase(native));

const ms = (start: number): string => (performance.now() - start).toFixed(1);
const report = (label: string, value: string): void => {
  console.log(`${label.padEnd(58)} ${value}`);
};

async function bump(label: string, next: ServerSchema): Promise<void> {
  const start = performance.now();
  await storage.ensureSchema(compileSchema(next));
  report(label, `${ms(start)} ms`);
}

console.log(`rows=${ROWS} owners=${OWNERS}`);
await bump('v1 create table, no indexes', schema(1, []));
let start = performance.now();
native
  .query(
    `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i < ?)
     INSERT INTO assertions(_sync_partition, _sync_row_id, _sync_server_version,
       _sync_scopes, _sync_payload, id, owner_id, title, status)
     SELECT 'p1', 'r' || i, 1, '{}', x'00', 'r' || i, 'o' || (i % ${OWNERS}),
            'title ' || i, CASE WHEN i % 50 = 0 THEN 'pending' ELSE 'done' END
       FROM n`,
  )
  .run(ROWS - 1);
report('seed rows', `${ms(start)} ms`);

await bump('v2 first bump creates 3 declared indexes', schema(2, declared));
await bump('v3 bump, all 3 indexes unchanged', schema(3, declared));
await bump(
  'v4 bump, 1 of 3 indexes changed',
  schema(4, [
    declared[0]!,
    { name: 'by_owner_title', columns: ['owner_id'] },
    declared[2]!,
  ]),
);

const owners = Array.from({ length: 200 }, (_, i) => `o${(i * 37) % OWNERS}`);
const lookup = (sql: string, iterations: number, withPartition: boolean) => {
  const statement = native.query<unknown, string[]>(sql);
  start = performance.now();
  for (let i = 0; i < iterations; i++) {
    const owner = owners[i % owners.length]!;
    // `id` belongs to the owner: ids with i % OWNERS === owner number.
    const id = `r${Number(owner.slice(1)) + OWNERS * (i % 100)}`;
    if (withPartition) statement.get('p1', owner, id);
    else statement.get(owner, id);
  }
  const perQuery = (performance.now() - start) / iterations;
  // A stepped statement holds a table lock that blocks the next bump's DROP INDEX.
  statement.finalize();
  return perQuery;
};
const plan = (sql: string, ...params: string[]): string => {
  const statement = native.query<{ detail: string }, string[]>(
    `EXPLAIN QUERY PLAN ${sql}`,
  );
  const detail = statement
    .all(...params)
    .map((row) => row.detail)
    .join('; ');
  // A stepped EXPLAIN statement keeps its table lock until finalized.
  statement.finalize();
  return detail;
};

const bare = 'SELECT title FROM assertions WHERE owner_id=? AND id=?';
const named =
  'SELECT title FROM assertions WHERE _sync_partition=? AND owner_id=? AND id=?';
report('plan: without partition', plan(bare, 'o1', 'r1'));
report('plan: with partition', plan(named, 'p1', 'o1', 'r1'));
report(
  'lookup without partition, declared indexes only (ms/query)',
  lookup(bare, 20, false).toFixed(2),
);
report(
  'lookup with partition, declared indexes only (ms/query)',
  lookup(named, 2_000, true).toFixed(3),
);
await bump(
  'v5 bump adds serverIndexes lookup(owner_id, id)',
  schema(5, declared, [{ name: 'lookup', columns: ['owner_id', 'id'] }]),
);
report('plan: without partition', plan(bare, 'o1', 'r1'));
report(
  'lookup without partition, serverIndexes (ms/query)',
  lookup(bare, 2_000, false).toFixed(3),
);

const touches = 20_000;
const changesBefore = native
  .query<{ n: number }, []>('SELECT total_changes() AS n')
  .get()!.n;
start = performance.now();
const t0 = 1_750_000_000_000;
for (let i = 0; i < touches; i++) {
  await storage.touchPartition('p1', t0 + i, 'epoch-1');
}
const changes =
  native.query<{ n: number }, []>('SELECT total_changes() AS n').get()!.n -
  changesBefore;
report(
  `${touches} touchPartition calls over ${touches} ms of clock`,
  `${ms(start)} ms, ${changes} rows written`,
);

native.close();
rmSync(dir, { recursive: true, force: true });
