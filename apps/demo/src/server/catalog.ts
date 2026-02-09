/**
 * @syncular/demo - Large catalog utilities
 *
 * Dialect-agnostic catalog seed using Kysely + JS batch inserts.
 * Works on both Postgres (PGlite) and SQLite (D1).
 */

import type { Kysely } from 'kysely';
import type { ServerDb } from './db';

interface CatalogSeedResult {
  targetRows: number;
  insertedRows: number;
  totalRows: number;
  durationMs: number;
}

function coerceNumber(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

export async function getCatalogRowCount(
  db: Kysely<ServerDb>
): Promise<number> {
  const row = await db
    .selectFrom('catalog_items')
    .select(({ fn }) => fn.countAll().as('count'))
    .executeTakeFirst();
  return coerceNumber(row?.count);
}

export async function clearCatalog(db: Kysely<ServerDb>): Promise<void> {
  await db.deleteFrom('catalog_items').execute();
}

export async function seedCatalog(
  db: Kysely<ServerDb>,
  args: {
    rows: number;
    force?: boolean;
    prefix?: string;
    batchSize?: number;
    maxInsert?: number;
  }
): Promise<CatalogSeedResult> {
  const targetRows = Math.max(0, Math.floor(args.rows));
  const force = args.force === true;
  const prefix = args.prefix ?? 'Item ';

  const startAtMs = Date.now();

  if (force) {
    await clearCatalog(db);
  }

  const existing = await getCatalogRowCount(db);
  if (existing >= targetRows) {
    return {
      targetRows,
      insertedRows: 0,
      totalRows: existing,
      durationMs: Date.now() - startAtMs,
    };
  }

  // Use zero-padded ids so lexical ordering matches numeric ordering.
  const width = Math.max(1, String(targetRows).length);
  const start = Math.max(1, existing + 1);
  const batchSize = args.batchSize ?? 500;
  const insertLimit = args.maxInsert
    ? Math.min(start + args.maxInsert - 1, targetRows)
    : targetRows;

  for (let i = start; i <= insertLimit; i += batchSize) {
    const end = Math.min(i + batchSize - 1, insertLimit);
    const rows: { id: string; name: string }[] = [];

    for (let j = i; j <= end; j++) {
      const padded = String(j).padStart(width, '0');
      rows.push({ id: padded, name: `${prefix}${padded}` });
    }

    await db
      .insertInto('catalog_items')
      .values(rows)
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();
  }

  const totalRows = await getCatalogRowCount(db);

  return {
    targetRows,
    insertedRows: Math.max(0, totalRows - existing),
    totalRows,
    durationMs: Date.now() - startAtMs,
  };
}
