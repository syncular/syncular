/**
 * @syncular/server - Conflict result builder
 *
 * Helper for building conflict results in server table handlers.
 */

import type { ApplyOperationResult } from '../handlers/types';

export interface BuildConflictResultArgs {
  /** Index of the operation in the batch */
  opIndex: number;
  /** Current server row data */
  serverRow: unknown;
  /** Current server version */
  serverVersion: number;
  /** Client's base version (what they thought they were updating) */
  baseVersion: number | null;
}

/**
 * Build a conflict result for applyOperation.
 *
 * Use this when the client's base version doesn't match the server's current version,
 * indicating a concurrent modification conflict.
 *
 * @example
 * ```typescript
 * const handler: ServerTableHandler = {
 *   table: 'tasks',
 *   async applyOperation(ctx, op, opIndex) {
 *     const existing = await ctx.db
 *       .selectFrom('tasks')
 *       .selectAll()
 *       .where('id', '=', op.row_id)
 *       .executeTakeFirst();
 *
 *     // Check for version conflict
 *     if (existing && op.base_version !== null && existing.version !== op.base_version) {
 *       return {
 *         result: buildConflictResult({
 *           opIndex,
 *           serverRow: existing,
 *           serverVersion: existing.version,
 *           baseVersion: op.base_version,
 *         }),
 *       };
 *     }
 *
 *     // ... apply the operation
 *   },
 * };
 * ```
 */
export function buildConflictResult(
  args: BuildConflictResultArgs
): ApplyOperationResult['result'] {
  return {
    opIndex: args.opIndex,
    status: 'conflict',
    message: `Version conflict: server=${args.serverVersion}, base=${args.baseVersion}`,
    server_version: args.serverVersion,
    server_row: args.serverRow,
  };
}
