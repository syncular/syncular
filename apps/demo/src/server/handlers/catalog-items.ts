/**
 * @syncular/demo - Server-side catalog_items table handler
 *
 * Read-only large-table demo.
 * Scope: catalog:{catalog_id}
 */

import { createServerHandler } from '@syncular/server';
import { sql } from 'kysely';
import type { ClientDb } from '../../client/types.generated';
import type { ServerDb } from '../db';

export const catalogItemsServerHandler = createServerHandler<
  ServerDb,
  ClientDb,
  'catalog_items'
>({
  table: 'catalog_items',
  scopes: ['catalog:{catalog_id}'],
  resolveScopes: async () => ({
    // Global access - all catalogs accessible to everyone
    catalog_id: '*',
  }),
  snapshotChunkTtlMs: 10 * 60 * 1000,
  // Read-only: reject all write operations
  applyOperation: async (_ctx, _op, opIndex) => ({
    result: {
      opIndex,
      status: 'error',
      error: 'READ_ONLY',
      code: 'READ_ONLY',
      retriable: false,
    },
    emittedChanges: [],
  }),
  // Override snapshot to not filter by scope (global catalog)
  snapshot: async (ctx) => {
    const pageSize = Math.max(1, Math.min(50_000, ctx.limit));
    const cursorFilter =
      ctx.cursor && ctx.cursor.length > 0
        ? sql`where ${sql.ref('id')} > ${sql.val(ctx.cursor)}`
        : sql``;

    const res = await sql<{ id: string; name: string }>`
      select ${sql.ref('id')}, ${sql.ref('name')}
      from ${sql.table('catalog_items')}
      ${cursorFilter}
      order by ${sql.ref('id')} asc
      limit ${sql.val(pageSize + 1)}
    `.execute(ctx.db);
    const rows = res.rows;

    const hasMore = rows.length > pageSize;
    const pageRows = hasMore ? rows.slice(0, pageSize) : rows;
    const nextCursor = hasMore
      ? (pageRows[pageRows.length - 1]?.id ?? null)
      : null;

    return {
      rows: pageRows,
      nextCursor:
        typeof nextCursor === 'string' && nextCursor.length > 0
          ? nextCursor
          : null,
    };
  },
});
