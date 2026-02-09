/**
 * @syncular/server - Mutation Detector
 *
 * Detects whether a SQL query is a mutation (INSERT/UPDATE/DELETE).
 */

import type { SyncOp } from '@syncular/core';

export interface DetectedMutation {
  /** Operation type */
  operation: SyncOp;
  /** Table name being modified */
  tableName: string;
}

/**
 * Detect if a SQL query is a mutation and extract table info.
 *
 * @param sql - The SQL query string
 * @returns Mutation info if detected, null for read queries
 */
export function detectMutation(sql: string): DetectedMutation | null {
  const trimmed = sql.trim();

  // INSERT INTO [schema.]table
  const insertMatch = trimmed.match(
    /^\s*INSERT\s+INTO\s+(?:["']?(\w+)["']?\.)?["']?(\w+)["']?/i
  );
  if (insertMatch) {
    return {
      operation: 'upsert',
      tableName: insertMatch[2]!,
    };
  }

  // UPDATE [schema.]table
  const updateMatch = trimmed.match(
    /^\s*UPDATE\s+(?:["']?(\w+)["']?\.)?["']?(\w+)["']?/i
  );
  if (updateMatch) {
    return {
      operation: 'upsert',
      tableName: updateMatch[2]!,
    };
  }

  // DELETE FROM [schema.]table
  const deleteMatch = trimmed.match(
    /^\s*DELETE\s+FROM\s+(?:["']?(\w+)["']?\.)?["']?(\w+)["']?/i
  );
  if (deleteMatch) {
    return {
      operation: 'delete',
      tableName: deleteMatch[2]!,
    };
  }

  return null;
}

/**
 * Check if SQL already has a RETURNING clause.
 */
export function hasReturningClause(sql: string): boolean {
  // Simple check - look for RETURNING keyword not in a string
  return /\bRETURNING\b/i.test(sql);
}

/**
 * Append RETURNING * to a mutation query if not already present.
 *
 * @param sql - The SQL query string
 * @returns Modified SQL with RETURNING *
 */
export function appendReturning(sql: string): string {
  if (hasReturningClause(sql)) {
    return sql;
  }

  // Remove trailing semicolon if present
  const trimmed = sql.trim().replace(/;\s*$/, '');
  return `${trimmed} RETURNING *`;
}
