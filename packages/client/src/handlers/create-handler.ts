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
  createSingleVariableScopeMetadata,
  createTableColumnCodecsResolver,
  isRecord,
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
  codecs?: ColumnCodecSource;

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
   * Override: Apply multiple changes in order.
   * Default: batches contiguous compatible deletes/upserts.
   */
  applyChanges?: (
    ctx: ClientHandlerContext<DB>,
    changes: SyncChange[]
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
  const resolveRowCodecs = createTableColumnCodecsResolver(options.codecs, {
    dialect: codecDialect,
  });
  const resolveTableCodecs = (row: Record<string, unknown>) =>
    resolveRowCodecs(table, row);

  const { scopePatterns, scopeColumnsByVariable } =
    createSingleVariableScopeMetadata(scopeDefs);

  const clearRowsForScopes = async (
    ctx: ClientClearContext<DB> | ClientSnapshotHookContext<DB>
  ): Promise<void> => {
    const scopeFilters = Object.entries(ctx.scopes).flatMap(
      ([scopeKey, raw]) => {
        const column = scopeColumnsByVariable[scopeKey];
        if (!column) return [];
        if (Array.isArray(raw)) {
          const values = raw.filter((value) => value.length > 0);
          if (values.length === 0) return [];
          return [
            sql`${sql.ref(column)} in ${sql`(${sql.join(values.map((value) => sql.val(value)))})`}`,
          ];
        }
        if (raw.length === 0) return [];
        return [sql`${sql.ref(column)} = ${sql.val(raw)}`];
      }
    );

    if (scopeFilters.length === 0) {
      await sql`delete from ${sql.table(table)}`.execute(ctx.trx);
      return;
    }

    await sql`
      delete from ${sql.table(table)}
      where ${sql.join(scopeFilters, sql` and `)}
    `.execute(ctx.trx);
  };

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
      await ctx.yieldToMainThread?.();
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

  const defaultApplyChanges = async (
    ctx: ClientHandlerContext<DB>,
    changes: SyncChange[]
  ): Promise<void> => {
    if (changes.length === 0) return;

    const flushDeleteBatch = async (rowIds: string[]): Promise<void> => {
      if (rowIds.length === 0) return;

      const maxRowsPerDelete = Math.max(1, MAX_INSERT_BIND_PARAMETERS);
      for (
        let startIndex = 0;
        startIndex < rowIds.length;
        startIndex += maxRowsPerDelete
      ) {
        const batchIds = rowIds.slice(
          startIndex,
          startIndex + maxRowsPerDelete
        );
        await sql`
          delete from ${sql.table(table)}
          where ${sql.ref(primaryKey)} in ${sql`(${sql.join(batchIds.map((rowId) => sql.val(rowId)))})`}
        `.execute(ctx.trx);
        await ctx.yieldToMainThread?.();
      }
    };

    const flushUpsertBatch = async (
      rows: Array<Record<string, unknown>>,
      columns: string[]
    ): Promise<void> => {
      if (rows.length === 0 || columns.length === 0) return;

      const updateColumns = columns.filter((column) => column !== primaryKey);
      const onConflict =
        updateColumns.length === 0
          ? sql`do nothing`
          : sql`do update set ${sql.join(
              updateColumns.map(
                (column) =>
                  sql`${sql.ref(column)} = ${sql.ref(`excluded.${column}`)}`
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
          insert into ${sql.table(table)} (${sql.join(columns.map((column) => sql.ref(column)))})
          values ${sql.join(
            batchRows.map(
              (row) =>
                sql`(${sql.join(
                  columns.map((column) => sql.val(row[column] ?? null)),
                  sql`, `
                )})`
            ),
            sql`, `
          )}
          on conflict (${sql.ref(primaryKey)}) ${onConflict}
        `.execute(ctx.trx);
        await ctx.yieldToMainThread?.();
      }
    };

    const createInsertRow = (
      change: SyncChange
    ): { columns: string[]; row: Record<string, unknown> } => {
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

      return { columns: Object.keys(insertRow), row: insertRow };
    };

    let pendingDeletes: string[] = [];
    let pendingUpserts: Array<Record<string, unknown>> = [];
    let pendingUpsertColumns: string[] = [];
    let pendingUpsertColumnsKey = '';
    let pendingUpsertRowIds = new Set<string>();

    const flushPendingDeletes = async (): Promise<void> => {
      if (pendingDeletes.length === 0) return;
      await flushDeleteBatch(pendingDeletes);
      pendingDeletes = [];
    };

    const flushPendingUpserts = async (): Promise<void> => {
      if (pendingUpserts.length === 0) return;
      await flushUpsertBatch(pendingUpserts, pendingUpsertColumns);
      pendingUpserts = [];
      pendingUpsertColumns = [];
      pendingUpsertColumnsKey = '';
      pendingUpsertRowIds = new Set<string>();
    };

    for (const change of changes) {
      if (change.op === 'delete') {
        await flushPendingUpserts();
        pendingDeletes.push(change.row_id);
        continue;
      }

      const insertRow = createInsertRow(change);
      const columnsKey = insertRow.columns.join('\u001f');

      await flushPendingDeletes();

      if (
        pendingUpserts.length > 0 &&
        (pendingUpsertColumnsKey !== columnsKey ||
          pendingUpsertRowIds.has(change.row_id))
      ) {
        await flushPendingUpserts();
      }

      pendingUpsertColumns = insertRow.columns;
      pendingUpsertColumnsKey = columnsKey;
      pendingUpserts.push(insertRow.row);
      pendingUpsertRowIds.add(change.row_id);
    }

    await flushPendingDeletes();
    await flushPendingUpserts();
  };

  // Default clearAll: delete all rows from the table
  const defaultClearAll = async (
    ctx: ClientClearContext<DB>
  ): Promise<void> => {
    await clearRowsForScopes(ctx);
  };

  return {
    table,
    scopePatterns,
    subscribe: options.subscribe,

    applySnapshot: options.applySnapshot ?? defaultApplySnapshot,
    applyChange: options.applyChange ?? defaultApplyChange,
    applyChanges: options.applyChanges ?? defaultApplyChanges,
    clearAll: options.clearAll ?? defaultClearAll,

    onSnapshotStart:
      options.onSnapshotStart ??
      (async (ctx) => {
        await clearRowsForScopes(ctx);
      }),
    onSnapshotEnd: options.onSnapshotEnd,
  };
}
