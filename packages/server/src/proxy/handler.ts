/**
 * @syncular/server - Proxy Query Handler
 *
 * Executes proxied queries with automatic oplog generation for mutations.
 */

import type { Kysely, RawBuilder } from 'kysely';
import { sql } from 'kysely';
import type { ServerSyncDialect } from '../dialect/types';
import type { SyncCoreDb } from '../schema';
import { getProxyHandler, type ProxyHandlerCollection } from './collection';
import {
  appendReturning,
  detectMutation,
  hasReturningClause,
  hasReturningWildcard,
} from './mutation-detector';
import { createOplogEntries } from './oplog';
import type { ProxyQueryContext } from './types';

export interface ExecuteProxyQueryArgs<DB extends SyncCoreDb = SyncCoreDb> {
  /** Database connection or transaction */
  db: Kysely<DB>;
  /** Server sync dialect */
  dialect: ServerSyncDialect;
  /** Proxy table handlers for oplog generation */
  handlers: ProxyHandlerCollection;
  /** Query context (actor/client IDs) */
  ctx: ProxyQueryContext;
  /** SQL query string */
  sqlQuery: string;
  /** Query parameters */
  parameters: readonly unknown[];
}

export interface ExecuteProxyQueryResult {
  /** Query result rows (for SELECT or RETURNING) */
  rows?: unknown[];
  /** Number of affected rows (for mutations) */
  rowCount?: number;
  /** Commit sequence if oplog was created */
  commitSeq?: number;
  /** Affected tables if oplog was created */
  affectedTables?: string[];
}

/**
 * Build a raw SQL query with parameters using Kysely's sql helper.
 *
 * This converts parameterized SQL (using $1, $2, etc.) to Kysely's format.
 */
function buildRawQuery(
  sqlQuery: string,
  parameters: readonly unknown[]
): RawBuilder<unknown> {
  // If no parameters, just use sql.raw
  if (parameters.length === 0) {
    return sql.raw(sqlQuery);
  }

  // Parse the SQL and split by parameter placeholders ($1, $2, etc.)
  // Then use sql.join to build the query with proper parameter binding
  const parts: RawBuilder<unknown>[] = [];
  let lastIndex = 0;
  const paramRegex = /\$(\d+)/g;
  let match: RegExpExecArray | null;

  while ((match = paramRegex.exec(sqlQuery)) !== null) {
    // Add the SQL before this parameter
    if (match.index > lastIndex) {
      parts.push(sql.raw(sqlQuery.slice(lastIndex, match.index)));
    }
    // Add the parameter value (1-indexed in SQL, 0-indexed in array)
    const paramIndex = Number.parseInt(match[1]!, 10) - 1;
    if (paramIndex >= 0 && paramIndex < parameters.length) {
      // Use sql.value to create a proper parameter binding
      parts.push(sql.val(parameters[paramIndex]));
    } else {
      // Keep the original placeholder if out of bounds (shouldn't happen)
      parts.push(sql.raw(match[0]));
    }
    lastIndex = match.index + match[0].length;
  }

  // Add remaining SQL after last parameter
  if (lastIndex < sqlQuery.length) {
    parts.push(sql.raw(sqlQuery.slice(lastIndex)));
  }

  // Join all parts together
  return sql.join(parts, sql.raw(''));
}

/**
 * Execute a proxied query with automatic oplog generation for mutations.
 *
 * - Read queries: Execute directly and return rows
 * - Mutations: Append RETURNING *, execute, create oplog entries
 */
export async function executeProxyQuery<DB extends SyncCoreDb>(
  args: ExecuteProxyQueryArgs<DB>
): Promise<ExecuteProxyQueryResult> {
  const { db, dialect, handlers, ctx, sqlQuery, parameters } = args;

  const mutation = detectMutation(sqlQuery);

  if (!mutation) {
    // Read query - execute directly
    const result = await buildRawQuery(sqlQuery, parameters).execute(db);
    return { rows: result.rows };
  }

  // Check if this table has a registered handler
  const handler = getProxyHandler(handlers, mutation.tableName);
  if (!handler) {
    // No handler registered - execute without oplog
    // This allows proxy operations on non-synced tables
    const result = await buildRawQuery(sqlQuery, parameters).execute(db);
    return {
      rows: result.rows,
      rowCount: Number(result.numAffectedRows ?? 0),
    };
  }

  // Mutation with registered handler - append RETURNING * and create oplog
  const hasReturning = hasReturningClause(sqlQuery);
  if (hasReturning && !hasReturningWildcard(sqlQuery)) {
    throw new Error(
      `Proxy mutation on synced table "${mutation.tableName}" must use RETURNING * (or omit RETURNING)`
    );
  }

  const finalSql = hasReturning ? sqlQuery : appendReturning(sqlQuery);

  const result = await buildRawQuery(finalSql, parameters).execute(db);
  const affectedRows = result.rows as Record<string, unknown>[];

  if (affectedRows.length === 0) {
    return { rowCount: 0 };
  }

  // Create oplog entries
  const { commitSeq, affectedTables } = await createOplogEntries({
    trx: db,
    dialect,
    actorId: ctx.actorId,
    clientId: ctx.clientId,
    partitionId: ctx.partitionId,
    handler,
    operation: mutation.operation,
    rows: affectedRows,
  });

  return {
    rowCount: affectedRows.length,
    commitSeq,
    affectedTables,
  };
}
