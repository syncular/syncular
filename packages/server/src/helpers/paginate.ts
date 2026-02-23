/**
 * @syncular/server - Pagination helper
 *
 * Simplifies cursor-based pagination for snapshot queries.
 */

import type { SelectQueryBuilder } from 'kysely';

export interface PaginateOptions {
  /** Cursor value to start from (null for first page) */
  cursor: string | null;
  /** Number of rows per page */
  limit: number;
  /** Column to use for cursor-based pagination (default: 'id') */
  cursorColumn?: string;
}

export interface PaginateResult<T> {
  /** Rows for this page */
  rows: T[];
  /** Cursor for next page (null if no more pages) */
  nextCursor: string | null;
}

/**
 * Apply cursor-based pagination to a Kysely query.
 *
 * This helper simplifies implementing snapshot pagination by:
 * - Applying cursor filter if provided
 * - Ordering by the cursor column
 * - Fetching limit + 1 to determine if there's a next page
 * - Computing the next cursor
 *
 * @example
 * ```typescript
 * const handler: ServerTableHandler = {
 *   table: 'tasks',
 *   async snapshot(ctx) {
 *     const query = ctx.db
 *       .selectFrom('tasks')
 *       .selectAll()
 *       .where('user_id', '=', ctx.actorId);
 *
 *     return paginate(query, {
 *       cursor: ctx.cursor,
 *       limit: ctx.limit,
 *     });
 *   },
 * };
 * ```
 */
export async function paginate<T>(
  query: SelectQueryBuilder<any, any, T>,
  options: PaginateOptions
): Promise<PaginateResult<T>> {
  const { cursor, limit, cursorColumn = 'id' } = options;

  // Apply cursor filter if resuming from a previous page
  let q = query;
  if (cursor) {
    q = q.where(cursorColumn, '>', cursor) as typeof q;
  }

  // Order by cursor column and fetch limit + 1 to check for more pages
  const rows = await q
    .orderBy(cursorColumn, 'asc')
    .limit(limit + 1)
    .execute();

  // Determine if there are more pages
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;

  // Compute next cursor from last row
  const nextCursor = hasMore
    ? (((pageRows[pageRows.length - 1] as Record<string, unknown>)?.[
        cursorColumn
      ] as string) ?? null)
    : null;

  return { rows: pageRows, nextCursor };
}
