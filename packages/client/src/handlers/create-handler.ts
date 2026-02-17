/**
 * @syncular/client - Declarative client handler helper
 */

import type {
  ColumnCodecDialect,
  ColumnCodecSource,
  ScopeDefinition,
  ScopeKeysFromDefinitions,
  ScopeValuesFromPatterns,
  SyncChange,
  SyncSnapshot,
} from '@syncular/core';
import {
  applyCodecsToDbRow,
  isRecord,
  normalizeScopes,
  toTableColumnCodecs,
} from '@syncular/core';
import { sql } from 'kysely';
import type { SyncClientDb } from '../schema';
import type {
  ClientClearContext,
  ClientHandlerContext,
  ClientSnapshotHookContext,
  ClientTableHandler,
} from './types';

const MAX_INSERT_BIND_PARAMETERS = 900;

/**
 * Options for creating a declarative client handler.
 */
export interface CreateClientHandlerOptions<
  DB extends SyncClientDb,
  TableName extends keyof DB & string,
  ScopeDefs extends readonly ScopeDefinition[] = readonly ScopeDefinition[],
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
  scopes: ScopeDefs;

  /**
   * Subscription configuration for this table.
   * - `true` (default): Subscribe to this table with default scopes/params
   * - `false`: Don't subscribe (handler only for local mutations)
   * - Object: Subscribe with custom scopes and params
   */
  subscribe?:
    | boolean
    | {
        scopes?: ScopeValuesFromPatterns<ScopeDefs>;
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
   * Optional column codec resolver.
   * Receives `{ table, column, sqlType?, dialect? }` and returns a codec.
   */
  columnCodecs?: ColumnCodecSource;

  /**
   * Dialect used for codec dialect overrides.
   * Default: 'sqlite'
   */
  codecDialect?: ColumnCodecDialect;

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
  ScopeDefs extends readonly ScopeDefinition[] = readonly ScopeDefinition[],
>(
  options: CreateClientHandlerOptions<DB, TableName, ScopeDefs>
): ClientTableHandler<DB, TableName, ScopeKeysFromDefinitions<ScopeDefs>> {
  const { table, scopes: scopeDefs } = options;
  const primaryKey =
    options.primaryKey ?? ('id' as keyof DB[TableName] & string);
  const versionColumn = options.versionColumn;
  const codecDialect = options.codecDialect ?? 'sqlite';
  const codecCache = new Map<string, ReturnType<typeof toTableColumnCodecs>>();
  const resolveTableCodecs = (row: Record<string, unknown>) => {
    const columnCodecs = options.columnCodecs;
    if (!columnCodecs) return {};
    const columns = Object.keys(row);
    if (columns.length === 0) return {};
    const cacheKey = columns.slice().sort().join('\u0000');
    const cached = codecCache.get(cacheKey);
    if (cached) return cached;
    const resolved = toTableColumnCodecs(table, columnCodecs, columns, {
      dialect: codecDialect,
    });
    codecCache.set(cacheKey, resolved);
    return resolved;
  };

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
      rows.push(applyCodecsToDbRow(row, resolveTableCodecs(row), codecDialect));
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

    const maxRowsPerInsert = Math.max(
      1,
      Math.floor(MAX_INSERT_BIND_PARAMETERS / columns.length)
    );

    for (
      let startIndex = 0;
      startIndex < rows.length;
      startIndex += maxRowsPerInsert
    ) {
      const batchRows = rows.slice(startIndex, startIndex + maxRowsPerInsert);

      await sql`
        insert into ${sql.table(table)} (${sql.join(columns.map((c) => sql.ref(c)))})
        values ${sql.join(
          batchRows.map(
            (row) =>
              sql`(${sql.join(
                columns.map((col) => sql.val(row[col] ?? null)),
                sql`, `
              )})`
          ),
          sql`, `
        )}
        on conflict (${sql.ref(primaryKey)}) ${onConflict}
      `.execute(ctx.trx);
    }
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

    const row = isRecord(change.row_json)
      ? applyCodecsToDbRow(
          change.row_json,
          resolveTableCodecs(change.row_json),
          codecDialect
        )
      : {};
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
        columns.map((col) => sql.val(insertRow[col] ?? null)),
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
