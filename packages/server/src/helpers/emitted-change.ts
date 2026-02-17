/**
 * @syncular/server - Emitted change builder
 *
 * Helper for creating emitted changes in server table handlers.
 */

import type { StoredScopes } from '@syncular/core';
import type { EmittedChange } from '../handlers/types';

export interface CreateEmittedChangeArgs {
  /** Table name */
  table: string;
  /** Row primary key */
  rowId: string;
  /** Operation type */
  op: 'upsert' | 'delete';
  /** Row data (null for delete) */
  row: unknown | null;
  /** Row version (null if not versioned) */
  version: number | null;
  /**
   * Scope values for this change (stored as JSONB).
   * Example: { user_id: 'U1', project_id: 'P1' }
   */
  scopes: StoredScopes;
}

/**
 * Create an emitted change for broadcasting to subscribed clients.
 *
 * @example
 * ```typescript
 * const handler: ServerTableHandler = {
 *   table: 'tasks',
 *   async applyOperation(ctx, op, opIndex) {
 *     // ... apply the operation ...
 *
 *     const newVersion = await getTaskVersion(ctx.db, op.row_id);
 *     const updatedRow = await getTask(ctx.db, op.row_id);
 *
 *     return {
 *       result: { opIndex, status: 'applied', newVersion },
 *       emittedChanges: [
 *         createEmittedChange({
 *           table: 'tasks',
 *           rowId: op.row_id,
 *           op: 'upsert',
 *           row: updatedRow,
 *           version: newVersion,
 *           scopes: { user_id: updatedRow.user_id },
 *         }),
 *       ],
 *     };
 *   },
 * };
 * ```
 */
export function createEmittedChange(
  args: CreateEmittedChangeArgs
): EmittedChange {
  return {
    table: args.table,
    row_id: args.rowId,
    op: args.op,
    row_json: args.op === 'delete' ? null : args.row,
    row_version: args.version,
    scopes: args.scopes,
  };
}
