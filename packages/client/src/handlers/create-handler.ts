/**
 * @syncular/client - Declarative client handler helper
 */

import type { ScopeDefinition, SyncChange, SyncSnapshot } from '@syncular/core';
import { normalizeScopes } from '@syncular/core';
import { sql } from 'kysely';
import type { SyncClientDb } from '../schema';
import type {
  ClientClearContext,
  ClientHandlerContext,
  ClientSnapshotHookContext,
  ClientTableHandler,
} from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Coerce a value for SQL parameter binding.
 * PostgreSQL (PGlite) does not implicitly cast booleans to integers,
 * so we convert them to 0/1 before binding.
 */
function coerceForSql(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

/**
 * Options for creating a declarative client handler.
 */
export interface CreateClientHandlerOptions<
  DB extends SyncClientDb,
  TableName extends keyof DB & string,
> {
  /** Table name in the database */
  table: TableName;

  /**
   * Scope definitions for this table.
   * Can be simple strings (column auto-derived) or objects with explicit mapping.
   *
   * @example
   * ```typescript
   * // Simple: column auto-derived from placeholder
   * scopes: ['user:{user_id}', 'org:{org_id}']
   *
   * // Explicit: when column differs from pattern variable
   * scopes: [
   *   { pattern: 'user:{user_id}', column: 'owner_id' }
   * ]
   * ```
   */
  scopes: ScopeDefinition[];

  /**
   * Subscription configuration for this table.
   * - `true` (default): Subscribe to this table with default scopes/params
   * - `false`: Don't subscribe (handler only for local mutations)
   * - Object: Subscribe with custom scopes and params
   */
  subscribe?:
    | boolean
    | {
        scopes?: Record<string, string | string[]>;
        params?: Record<string, unknown>;
      };

  /** Primary key column name (default: 'id') */
  primaryKey?: keyof DB[TableName] & string;

  /**
   * Optional version column name (e.g. 'server_version') to store `change.row_version`.
   * If omitted, row_version is ignored by the default handler.
   */
  versionColumn?: keyof DB[TableName] & string;

  /**
   * Override: Apply a snapshot.
   * Default: upsert all rows (no delete on isFirstPage).
   */
  applySnapshot?: (
    ctx: ClientHandlerContext<DB>,
    snapshot: SyncSnapshot
  ) => Promise<void>;

  /**
   * Override: Apply a single change.
   * Default: upsert on upsert, delete on delete.
   */
  applyChange?: (
    ctx: ClientHandlerContext<DB>,
    change: SyncChange
  ) => Promise<void>;

  /**
   * Override: Clear all data for this table.
   * Default: delete all rows from the table.
   */
  clearAll?: (ctx: ClientClearContext<DB>) => Promise<void>;

  /**
   * Hook: Called when a snapshot begins (isFirstPage = true).
   * Default: no-op.
   */
  onSnapshotStart?: (ctx: ClientSnapshotHookContext<DB>) => Promise<void>;

  /**
   * Hook: Called when a snapshot ends (isLastPage = true).
   * Default: no-op.
   */
  onSnapshotEnd?: (ctx: ClientSnapshotHookContext<DB>) => Promise<void>;
}

/**
 * Create a declarative client table handler with sensible defaults.
 *
 * @example
 * ```typescript
 * import { createClientHandler } from '@syncular/client';
 * import type { ClientDb } from './db.generated';
 *
 * export const tasksHandler = createClientHandler<ClientDb, 'tasks'>({
 *   table: 'tasks',
 *   scopes: ['user:{user_id}'],  // column auto-derived from placeholder
 * });
 *
 * // With custom column mapping:
 * export const tasksHandler = createClientHandler<ClientDb, 'tasks'>({
 *   table: 'tasks',
 *   scopes: [{ pattern: 'user:{user_id}', column: 'owner_id' }],
 * });
 *
 * // With soft delete pattern:
 * export const tasksHandler = createClientHandler<ClientDb, 'tasks'>({
 *   table: 'tasks',
 *   scopes: ['user:{user_id}'],
 *   onSnapshotStart: async (ctx) => {
 *     await ctx.trx.updateTable('tasks')
 *       .set({ _sync_stale: 1 })
 *       .where('user_id', '=', ctx.scopeKey.split(':')[1])
 *       .execute();
 *   },
 *   onSnapshotEnd: async (ctx) => {
 *     await ctx.trx.deleteFrom('tasks')
 *       .where('_sync_stale', '=', 1)
 *       .execute();
 *   },
 * });
 * ```
 */
export function createClientHandler<
  DB extends SyncClientDb,
  TableName extends keyof DB & string,
>(
  options: CreateClientHandlerOptions<DB, TableName>
): ClientTableHandler<DB, TableName> {
  const { table, scopes: scopeDefs } = options;
  const primaryKey =
    options.primaryKey ?? ('id' as keyof DB[TableName] & string);
  const versionColumn = options.versionColumn;

  // Normalize scopes to pattern map (stored for metadata)
  const scopeColumnMap = normalizeScopes(scopeDefs);
  const scopePatterns = Object.keys(scopeColumnMap);

  // Default applySnapshot: upsert all rows
  const defaultApplySnapshot = async (
    ctx: ClientHandlerContext<DB>,
    snapshot: SyncSnapshot
  ): Promise<void> => {
    const rows: Array<Record<string, unknown>> = [];
    for (const row of snapshot.rows ?? []) {
      if (!isRecord(row)) continue;
      rows.push(row);
    }

    if (rows.length === 0) return;

    // Get column names from first row
    const columns = Object.keys(rows[0]!);
    if (columns.length === 0) return;
    const updateColumns = columns.filter((c) => c !== primaryKey);

    const onConflict =
      updateColumns.length === 0
        ? sql`do nothing`
        : sql`do update set ${sql.join(
            updateColumns.map(
              (col) => sql`${sql.ref(col)} = ${sql.ref(`excluded.${col}`)}`
            ),
            sql`, `
          )}`;

    await sql`
      insert into ${sql.table(table)} (${sql.join(columns.map((c) => sql.ref(c)))})
      values ${sql.join(
        rows.map(
          (row) =>
            sql`(${sql.join(
              columns.map((col) => sql.val(coerceForSql(row[col]))),
              sql`, `
            )})`
        ),
        sql`, `
      )}
      on conflict (${sql.ref(primaryKey)}) ${onConflict}
    `.execute(ctx.trx);
  };

  // Default applyChange: upsert on upsert, delete on delete
  const defaultApplyChange = async (
    ctx: ClientHandlerContext<DB>,
    change: SyncChange
  ): Promise<void> => {
    if (change.op === 'delete') {
      await sql`
        delete from ${sql.table(table)}
        where ${sql.ref(primaryKey)} = ${sql.val(change.row_id)}
      `.execute(ctx.trx);
      return;
    }

    const row = isRecord(change.row_json) ? change.row_json : {};
    const insertRow: Record<string, unknown> = {
      ...row,
      [primaryKey]: change.row_id,
    };

    if (
      versionColumn &&
      change.row_version !== null &&
      change.row_version !== undefined
    ) {
      insertRow[versionColumn] = change.row_version;
    }

    const columns = Object.keys(insertRow);
    const updateColumns = columns.filter((c) => c !== primaryKey);
    const onConflict =
      updateColumns.length === 0
        ? sql`do nothing`
        : sql`do update set ${sql.join(
            updateColumns.map(
              (col) => sql`${sql.ref(col)} = ${sql.ref(`excluded.${col}`)}`
            ),
            sql`, `
          )}`;

    await sql`
      insert into ${sql.table(table)} (${sql.join(columns.map((c) => sql.ref(c)))})
      values (${sql.join(
        columns.map((col) => sql.val(coerceForSql(insertRow[col]))),
        sql`, `
      )})
      on conflict (${sql.ref(primaryKey)}) ${onConflict}
    `.execute(ctx.trx);
  };

  // Default clearAll: delete all rows from the table
  const defaultClearAll = async (
    ctx: ClientClearContext<DB>
  ): Promise<void> => {
    await sql`delete from ${sql.table(table)}`.execute(ctx.trx);
  };

  return {
    table,
    scopePatterns,
    subscribe: options.subscribe,

    applySnapshot: options.applySnapshot ?? defaultApplySnapshot,
    applyChange: options.applyChange ?? defaultApplyChange,
    clearAll: options.clearAll ?? defaultClearAll,

    onSnapshotStart: options.onSnapshotStart,
    onSnapshotEnd: options.onSnapshotEnd,
  };
}
