/**
 * Scope-pattern re-key lane (SPEC §3.1). Seeds one materialized table through
 * the storage API, then times two schema bumps on the same database:
 *
 * - a version-only bump, which rewrites no rows;
 * - a bump that maps the table's scope column to another variable, which
 *   decodes every payload, rewrites `_sync_scopes`, rebuilds the table's
 *   `sync_row_scopes` entries and raises the horizon.
 *
 * Backends: file-backed `bun:sqlite` (WAL, synchronous=NORMAL) and PGlite
 * (in-process Postgres compiled to WebAssembly; a native Postgres server is
 * not measured here).
 *
 * Run: `bun run --cwd bench bench:rekey -- [--rows 100000]`.
 */
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { encodeRow, type RowColumn } from '@syncular/core';
import {
  compileSchema,
  PostgresServerStorage,
  type ServerSchema,
  SqliteServerStorage,
} from '@syncular/server';
import { pgliteExecutor } from '@syncular/server/pglite';
import { BunSqliteDatabase } from '@syncular/server/sqlite';

const rowsArg = process.argv.indexOf('--rows');
const ROWS = rowsArg === -1 ? 100_000 : Number(process.argv[rowsArg + 1]);
const OWNERS = 500;
const BATCH = 1_000;

const COLUMNS: readonly RowColumn[] = [
  { name: 'id', type: 'string', nullable: false },
  { name: 'owner_id', type: 'string', nullable: false },
  { name: 'title', type: 'string', nullable: false },
  { name: 'status', type: 'string', nullable: true },
];

const schema = (version: number, pattern: string): ServerSchema => ({
  version,
  tables: [
    {
      name: 'assertions',
      columns: COLUMNS,
      primaryKey: 'id',
      scopes: [{ pattern, column: 'owner_id' }],
      indexes: [{ name: 'by_title', columns: ['title'] }],
    },
  ],
});

type Storage = SqliteServerStorage | PostgresServerStorage;

async function run(name: string, storage: Storage): Promise<void> {
  await storage.ensureSchema(compileSchema(schema(1, 'owner:{owner_id}')));
  let start = performance.now();
  for (let offset = 0; offset < ROWS; offset += BATCH) {
    const tx = await storage.begin('p1');
    for (let i = offset; i < Math.min(ROWS, offset + BATCH); i++) {
      const owner = `o${i % OWNERS}`;
      await tx.upsertRow('assertions', {
        rowId: `r${i}`,
        serverVersion: 1,
        scopes: { owner_id: owner },
        payload: encodeRow(COLUMNS, [`r${i}`, owner, `title ${i}`, 'done']),
      });
    }
    await tx.commit();
  }
  const seed = performance.now() - start;
  start = performance.now();
  await storage.ensureSchema(compileSchema(schema(2, 'owner:{owner_id}')));
  const versionOnly = performance.now() - start;
  start = performance.now();
  await storage.ensureSchema(compileSchema(schema(3, 'team:{team_id}')));
  const rekey = performance.now() - start;
  const row = await storage.getRow('p1', 'assertions', 'r1');
  if (row?.scopes.team_id !== 'o1') throw new Error('bench.rekey.not_rekeyed');
  console.log(
    `${name.padEnd(8)} rows=${ROWS} seed=${seed.toFixed(0)} ms ` +
      `version-only bump=${versionOnly.toFixed(1)} ms ` +
      `re-key bump=${rekey.toFixed(0)} ms ` +
      `(${((ROWS / rekey) * 1000).toFixed(0)} rows/s)`,
  );
}

const dir = mkdtempSync(join(tmpdir(), 'syncular-rekey-'));
const native = new Database(join(dir, 'sync.db'));
native.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL');
await run('sqlite', new SqliteServerStorage(new BunSqliteDatabase(native)));
native.close();
rmSync(dir, { recursive: true, force: true });

const pg = await PGlite.create();
await run('pglite', new PostgresServerStorage(pgliteExecutor(pg)));
await pg.close();
