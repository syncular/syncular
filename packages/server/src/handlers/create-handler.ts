/**
 * @syncular/server - Declarative server handler helper
 */

import type {
  ScopePattern,
  ScopeValues,
  ScopeValuesFromPatterns,
  ScopeDefinition as SimpleScopeDefinition,
  StoredScopes,
  SyncOperation,
} from '@syncular/core';
import {
  applyCodecsFromDbRow,
  applyCodecsToDbRow,
  type ColumnCodecDialect,
  type ColumnCodecSource,
  extractScopeVars,
  normalizeScopes,
  toTableColumnCodecs,
} from '@syncular/core';
import type {
  DeleteQueryBuilder,
  DeleteResult,
  Insertable,
  InsertQueryBuilder,
  InsertResult,
  Selectable,
  SelectQueryBuilder,
  Updateable,
  UpdateQueryBuilder,
  UpdateResult,
} from 'kysely';
import { sql } from 'kysely';
import type { SyncCoreDb } from '../schema';
import type {
  ApplyOperationResult,
  EmittedChange,
  ServerApplyOperationContext,
  ServerContext,
  ServerSnapshotContext,
  ServerTableHandler,
  SyncServerAuth,
} from './types';

/**
 * Authorization result from authorize callback.
 */
type AuthorizeResult =
  | true
  | { error: string; code: string; retriable?: boolean };

function classifyConstraintViolationCode(message: string): string {
  const normalized = message.toLowerCase();
  if (normalized.includes('not null')) return 'NOT_NULL_CONSTRAINT';
  if (normalized.includes('unique')) return 'UNIQUE_CONSTRAINT';
  if (normalized.includes('foreign key')) return 'FOREIGN_KEY_CONSTRAINT';
  return 'CONSTRAINT_VIOLATION';
}

function isConstraintViolationError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('constraint') ||
    normalized.includes('not null') ||
    normalized.includes('foreign key') ||
    normalized.includes('unique')
  );
}

function isMissingColumnReferenceError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('no such column') ||
    (normalized.includes('column') && normalized.includes('does not exist'))
  );
}

/**
 * Scope definition for a column - maps scope variable to column name.
 */
export type ScopeColumnMap = Record<string, string>;

/**
 * Options for creating a declarative server handler.
 */
export interface CreateServerHandlerOptions<
  ServerDB extends SyncCoreDb,
  ClientDB,
  TableName extends keyof ServerDB & keyof ClientDB & string,
  Auth extends SyncServerAuth = SyncServerAuth,
  ScopeDefs extends
    readonly SimpleScopeDefinition[] = readonly SimpleScopeDefinition[],
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

  /** Primary key column name (default: 'id') */
  primaryKey?: string;

  /** Version column name (default: 'server_version') */
  versionColumn?: string;

  /** Tables this handler depends on (for bootstrap ordering) */
  dependsOn?: string[];

  /** TTL for cached snapshot chunks in ms */
  snapshotChunkTtlMs?: number;

  /**
   * Resolve allowed scope values for the current actor.
   * Called per request to determine what the actor can access.
   *
   * @example
   * resolveScopes: async (ctx) => ({
   *   user_id: [ctx.actorId],
   *   project_id: await getProjectsForUser(ctx.db, ctx.actorId),
   * })
   */
  resolveScopes: (
    ctx: ServerContext<ServerDB, Auth>
  ) => Promise<ScopeValuesFromPatterns<ScopeDefs>>;

  /**
   * Transform inbound row from client to server format.
   * Use ctx.schemaVersion to handle older client versions.
   */
  transformInbound?: (
    row: Selectable<ClientDB[TableName]>,
    ctx: { schemaVersion?: number }
  ) => Updateable<ServerDB[TableName]>;

  /**
   * Transform outbound row from server to client format.
   */
  transformOutbound?: (
    row: Selectable<ServerDB[TableName]>
  ) => Selectable<ClientDB[TableName]>;

  /**
   * Optional column codec resolver.
   * Receives `{ table, column, sqlType?, dialect? }` and returns a codec.
   * Only used by default snapshot/apply paths when the corresponding
   * transform hook is not provided.
   */
  codecs?: ColumnCodecSource;

  /**
   * Dialect used for codec dialect overrides.
   * Default: 'sqlite'
   */
  codecDialect?: ColumnCodecDialect;

  /**
   * Authorize an operation before applying.
   * Return true to allow, or an error object to reject.
   */
  authorize?: (
    ctx: ServerApplyOperationContext<ServerDB, Auth>,
    op: SyncOperation
  ) => Promise<AuthorizeResult>;

  /**
   * Override: Build snapshot query.
   */
  snapshot?: ServerTableHandler<ServerDB, Auth>['snapshot'];

  /**
   * Override: Apply operation.
   */
  applyOperation?: ServerTableHandler<ServerDB, Auth>['applyOperation'];

  /**
   * Custom scope extraction from row (for complex scope logic).
   */
  extractScopes?: (row: Record<string, unknown>) => StoredScopes;
}

/**
 * Create a declarative server table handler with sensible defaults.
 *
 * @example
 * ```typescript
 * import { createServerHandler } from '@syncular/server';
 * import type { ServerDb } from '../db';
 * import type { ClientDb } from '../../shared/client-db.generated';
 *
 * export const tasksHandler = createServerHandler<ServerDb, ClientDb, 'tasks'>({
 *   table: 'tasks',
 *   scopes: ['user:{user_id}'],  // column auto-derived from placeholder
 *   resolveScopes: async (ctx) => ({
 *     user_id: [ctx.actorId],
 *   }),
 * });
 *
 * // With custom column mapping:
 * export const tasksHandler = createServerHandler<ServerDb, ClientDb, 'tasks'>({
 *   table: 'tasks',
 *   scopes: [{ pattern: 'user:{user_id}', column: 'owner_id' }],
 *   resolveScopes: async (ctx) => ({
 *     user_id: [ctx.actorId],
 *   }),
 * });
 * ```
 */
export function createServerHandler<
  ServerDB extends SyncCoreDb,
  ClientDB,
  TableName extends keyof ServerDB & keyof ClientDB & string,
  Auth extends SyncServerAuth = SyncServerAuth,
  ScopeDefs extends
    readonly SimpleScopeDefinition[] = readonly SimpleScopeDefinition[],
>(
  options: CreateServerHandlerOptions<
    ServerDB,
    ClientDB,
    TableName,
    Auth,
    ScopeDefs
  >
): ServerTableHandler<ServerDB, Auth> {
  type OverloadParameters<T> = T extends (...args: infer A) => unknown
    ? A
    : never;

  type UpdateSetObject = Extract<
    OverloadParameters<
      UpdateQueryBuilder<ServerDB, TableName, TableName, UpdateResult>['set']
    >,
    [unknown]
  >[0];

  const {
    table,
    scopes: scopeDefs,
    primaryKey = 'id',
    versionColumn = 'server_version',
    dependsOn,
    snapshotChunkTtlMs,
    resolveScopes,
    transformInbound,
    transformOutbound,
    codecs,
    codecDialect = 'sqlite',
    authorize,
    extractScopes: customExtractScopes,
  } = options;
  const codecCache = new Map<string, ReturnType<typeof toTableColumnCodecs>>();
  const resolveTableCodecs = (row: Record<string, unknown>) => {
    if (!codecs) return {};
    const columns = Object.keys(row);
    if (columns.length === 0) return {};
    const cacheKey = columns.slice().sort().join('\u0000');
    const cached = codecCache.get(cacheKey);
    if (cached) return cached;
    const resolved = toTableColumnCodecs(table, codecs, columns, {
      dialect: codecDialect,
    });
    codecCache.set(cacheKey, resolved);
    return resolved;
  };

  // Normalize scopes to pattern map and extract patterns/columns
  const scopeColumnMap = normalizeScopes(scopeDefs);
  const scopePatterns = Object.keys(scopeColumnMap) as ScopePattern[];
  const scopeColumns: ScopeColumnMap = {};

  for (const [pattern, columnName] of Object.entries(scopeColumnMap)) {
    const vars = extractScopeVars(pattern);
    if (vars.length !== 1) {
      throw new Error(
        `Scope pattern "${pattern}" must contain exactly one placeholder (got ${vars.length}).`
      );
    }
    const varName = vars[0]!;
    const existing = scopeColumns[varName];
    if (existing && existing !== columnName) {
      throw new Error(
        `Scope variable "${varName}" is mapped to multiple columns: "${existing}" and "${columnName}".`
      );
    }
    scopeColumns[varName] = columnName;
  }

  // Default extractScopes from scope columns
  const defaultExtractScopes = (row: Record<string, unknown>): StoredScopes => {
    const scopes: StoredScopes = {};
    for (const [varName, columnName] of Object.entries(scopeColumns)) {
      const raw = row[columnName];
      if (raw === null || raw === undefined) continue;
      const value = String(raw);
      if (value.length > 0) {
        scopes[varName] = value;
      }
    }
    return scopes;
  };

  const extractScopesImpl = customExtractScopes ?? defaultExtractScopes;

  const resolveScopesImpl = async (
    ctx: ServerContext<ServerDB, Auth>
  ): Promise<ScopeValues> => {
    const resolved = await resolveScopes(ctx);
    const normalized: ScopeValues = {};
    for (const [scopeKey, scopeValue] of Object.entries(resolved)) {
      if (typeof scopeValue === 'string' || Array.isArray(scopeValue)) {
        normalized[scopeKey] = scopeValue;
      }
    }
    return normalized;
  };

  const applyOutboundTransform = (
    row: Selectable<ServerDB[TableName]>
  ): Selectable<ClientDB[TableName]> => {
    if (transformOutbound) {
      return transformOutbound(row);
    }

    const recordRow = row as Record<string, unknown>;
    const transformed = applyCodecsFromDbRow(
      recordRow,
      resolveTableCodecs(recordRow),
      codecDialect
    );
    return transformed as Selectable<ClientDB[TableName]>;
  };

  const applyInboundTransform = (
    row: Record<string, unknown>,
    schemaVersion: number | undefined
  ): Updateable<ServerDB[TableName]> => {
    if (transformInbound) {
      return transformInbound(row as Selectable<ClientDB[TableName]>, {
        schemaVersion,
      });
    }

    const transformed = applyCodecsToDbRow(
      row,
      resolveTableCodecs(row),
      codecDialect
    );
    return transformed as Updateable<ServerDB[TableName]>;
  };

  // Default snapshot implementation
  const defaultSnapshot = async (
    ctx: ServerSnapshotContext<ServerDB, string, Auth>,
    _params: Record<string, unknown> | undefined
  ): Promise<{ rows: unknown[]; nextCursor: string | null }> => {
    const trx = ctx.db;
    const { ref } = trx.dynamic;
    const scopeValues = ctx.scopeValues;

    const pageSize = Math.max(1, Math.min(10_000, ctx.limit));

    // Build dynamic WHERE conditions
    const whereConditions: Array<{ column: string; values: string[] }> = [];
    for (const [varName, columnName] of Object.entries(scopeColumns)) {
      const values = scopeValues[varName];
      if (values === undefined) continue;
      const normalized = Array.isArray(values) ? values : [values];
      if (normalized.length === 0) continue;
      whereConditions.push({ column: columnName, values: normalized });
    }

    let q = trx.selectFrom(table).selectAll() as SelectQueryBuilder<
      ServerDB,
      keyof ServerDB & string,
      Record<string, unknown>
    >;

    for (const cond of whereConditions) {
      if (cond.values.length === 1) {
        q = q.where(ref<string>(cond.column), '=', cond.values[0]);
      } else {
        q = q.where(ref<string>(cond.column), 'in', cond.values);
      }
    }

    if (ctx.cursor !== null) {
      q = q.where(ref<string>(primaryKey), '>', ctx.cursor);
    }

    const rows = await q
      .orderBy(ref<string>(primaryKey), 'asc')
      .limit(pageSize + 1)
      .execute();

    const hasMore = rows.length > pageSize;
    const pageRows = hasMore ? rows.slice(0, pageSize) : rows;
    const lastRow = pageRows[pageRows.length - 1] as
      | (typeof rows)[number]
      | undefined;
    const nextCursor = hasMore
      ? ((lastRow as Record<string, unknown> | undefined)?.[primaryKey] as
          | string
          | undefined)
      : null;

    // Transform outbound if provided
    const outputRows = pageRows.map((r) =>
      applyOutboundTransform(r as Selectable<ServerDB[TableName]>)
    );

    return {
      rows: outputRows,
      nextCursor:
        typeof nextCursor === 'string' && nextCursor.length > 0
          ? nextCursor
          : null,
    };
  };

  // Default applyOperation implementation
  const defaultApplyOperation = async (
    ctx: ServerApplyOperationContext<ServerDB, Auth>,
    op: SyncOperation,
    opIndex: number
  ): Promise<ApplyOperationResult> => {
    const trx = ctx.trx;
    const { ref } = trx.dynamic;

    if (op.table !== table) {
      return {
        result: {
          opIndex,
          status: 'error',
          error: `UNKNOWN_TABLE:${op.table}`,
          code: 'UNKNOWN_TABLE',
          retriable: false,
        },
        emittedChanges: [],
      };
    }

    // Run authorization if provided
    if (authorize) {
      const authResult = await authorize(ctx, op);
      if (authResult !== true) {
        return {
          result: {
            opIndex,
            status: 'error',
            error: authResult.error,
            code: authResult.code,
            retriable: authResult.retriable ?? false,
          },
          emittedChanges: [],
        };
      }
    }

    // Handle delete
    if (op.op === 'delete') {
      const deleted = await (
        trx.deleteFrom(table) as DeleteQueryBuilder<
          ServerDB,
          keyof ServerDB & string,
          DeleteResult
        >
      )
        .where(ref<string>(primaryKey), '=', op.row_id)
        .returningAll()
        .executeTakeFirst();

      const deletedRow = deleted as Record<string, unknown> | undefined;
      if (!deletedRow) {
        return { result: { opIndex, status: 'applied' }, emittedChanges: [] };
      }

      // Extract scopes from existing row for the delete emission
      const scopes = extractScopesImpl(deletedRow);

      const emitted: EmittedChange = {
        table,
        row_id: op.row_id,
        op: 'delete',
        row_json: null,
        row_version: null,
        scopes,
      };

      return {
        result: { opIndex, status: 'applied' },
        emittedChanges: [emitted],
      };
    }

    // Handle upsert
    const rawPayload = op.payload ?? {};
    const payloadRecord =
      rawPayload !== null && typeof rawPayload === 'object'
        ? (rawPayload as Record<string, unknown>)
        : {};
    const payload = applyInboundTransform(payloadRecord, ctx.schemaVersion);

    let updated: Record<string, unknown> | undefined;
    let constraintError: { message: string; code: string } | null = null;

    try {
      if (op.base_version != null) {
        const expectedVersion = op.base_version;
        const conditionalUpdateSet: Record<string, unknown> = {
          ...payload,
          [versionColumn]: expectedVersion + 1,
        };
        delete conditionalUpdateSet[primaryKey];
        for (const col of Object.values(scopeColumns)) {
          delete conditionalUpdateSet[col];
        }

        updated = (await (
          trx.updateTable(table) as UpdateQueryBuilder<
            ServerDB,
            TableName,
            TableName,
            UpdateResult
          >
        )
          .set(conditionalUpdateSet as UpdateSetObject)
          .where(ref<string>(primaryKey), '=', op.row_id)
          .where(ref<string>(versionColumn), '=', expectedVersion)
          .returningAll()
          .executeTakeFirst()) as Record<string, unknown> | undefined;

        if (!updated) {
          const conflictRow = await (
            trx.selectFrom(table).selectAll() as SelectQueryBuilder<
              ServerDB,
              keyof ServerDB & string,
              Record<string, unknown>
            >
          )
            .where(ref<string>(primaryKey), '=', op.row_id)
            .executeTakeFirst();

          if (!conflictRow) {
            return {
              result: {
                opIndex,
                status: 'error',
                error: 'ROW_NOT_FOUND_FOR_BASE_VERSION',
                code: 'ROW_MISSING',
                retriable: false,
              },
              emittedChanges: [],
            };
          }

          const existingVersion =
            (conflictRow[versionColumn] as number | undefined) ?? 0;
          return {
            result: {
              opIndex,
              status: 'conflict',
              message: `Version conflict: server=${existingVersion}, base=${expectedVersion}`,
              server_version: existingVersion,
              server_row: applyOutboundTransform(
                conflictRow as Selectable<ServerDB[TableName]>
              ),
            },
            emittedChanges: [],
          };
        }
      } else {
        const updateSet: Record<string, unknown> = {
          ...payload,
          [versionColumn]: sql`${sql.ref(versionColumn)} + 1`,
        };
        delete updateSet[primaryKey];
        for (const col of Object.values(scopeColumns)) {
          delete updateSet[col];
        }

        updated = (await (
          trx.updateTable(table) as UpdateQueryBuilder<
            ServerDB,
            TableName,
            TableName,
            UpdateResult
          >
        )
          .set(updateSet as UpdateSetObject)
          .where(ref<string>(primaryKey), '=', op.row_id)
          .returningAll()
          .executeTakeFirst()) as Record<string, unknown> | undefined;

        if (!updated) {
          const insertValues: Record<string, unknown> = {
            ...payload,
            [primaryKey]: op.row_id,
            [versionColumn]: 1,
          };

          try {
            updated = (await (
              trx.insertInto(table) as InsertQueryBuilder<
                ServerDB,
                TableName,
                InsertResult
              >
            )
              .values(insertValues as Insertable<ServerDB[TableName]>)
              .returningAll()
              .executeTakeFirst()) as Record<string, unknown> | undefined;
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (!isConstraintViolationError(message)) {
              throw err;
            }
            updated = (await (
              trx.updateTable(table) as UpdateQueryBuilder<
                ServerDB,
                TableName,
                TableName,
                UpdateResult
              >
            )
              .set(updateSet as UpdateSetObject)
              .where(ref<string>(primaryKey), '=', op.row_id)
              .returningAll()
              .executeTakeFirst()) as Record<string, unknown> | undefined;
            if (!updated) {
              constraintError = {
                message,
                code: classifyConstraintViolationCode(message),
              };
            }
          }
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (op.base_version != null && isMissingColumnReferenceError(message)) {
        const row = await (
          trx.selectFrom(table).selectAll() as SelectQueryBuilder<
            ServerDB,
            keyof ServerDB & string,
            Record<string, unknown>
          >
        )
          .where(ref<string>(primaryKey), '=', op.row_id)
          .executeTakeFirst();
        if (!row) {
          return {
            result: {
              opIndex,
              status: 'error',
              error: 'ROW_NOT_FOUND_FOR_BASE_VERSION',
              code: 'ROW_MISSING',
              retriable: false,
            },
            emittedChanges: [],
          };
        }
      }

      if (!isConstraintViolationError(message)) {
        throw err;
      }

      constraintError = {
        message,
        code: classifyConstraintViolationCode(message),
      };
    }

    if (constraintError) {
      return {
        result: {
          opIndex,
          status: 'error',
          error: constraintError.message,
          code: constraintError.code,
          retriable: false,
        },
        emittedChanges: [],
      };
    }

    if (!updated) {
      throw new Error('Updated row is missing after applyOperation');
    }

    const updatedRow = updated;
    const rowVersion = (updatedRow[versionColumn] as number) ?? 1;

    // Extract scopes from updated row
    const scopes = extractScopesImpl(updatedRow);

    // Transform outbound for emitted change
    const rowJson = applyOutboundTransform(
      updated as Selectable<ServerDB[TableName]>
    );

    const emitted: EmittedChange = {
      table,
      row_id: op.row_id,
      op: 'upsert',
      row_json: rowJson,
      row_version: rowVersion,
      scopes,
    };

    return {
      result: { opIndex, status: 'applied' },
      emittedChanges: [emitted],
    };
  };

  return {
    table,
    scopePatterns,
    dependsOn,
    snapshotChunkTtlMs,
    resolveScopes: resolveScopesImpl,
    extractScopes: extractScopesImpl,
    snapshot: options.snapshot ?? defaultSnapshot,
    applyOperation: options.applyOperation ?? defaultApplyOperation,
  };
}
