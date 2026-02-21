import type {
  ScopePattern,
  ScopeValues,
  ScopeValuesForKeys,
  StoredScopes,
  SyncOp,
  SyncOperation,
  SyncOperationResult,
} from '@syncular/core';
import type { ZodSchema, z } from 'zod';
import type { DbExecutor } from '../dialect/types';
import type { SyncCoreDb } from '../schema';

export interface SyncServerAuth {
  actorId: string;
  partitionId?: string;
}

/**
 * Emitted change to be stored in the oplog.
 * Uses JSONB scopes instead of scope_keys array.
 */
export interface EmittedChange {
  /** Table name */
  table: string;
  /** Row primary key */
  row_id: string;
  /** Operation type */
  op: SyncOp;
  /** Row data as JSON (null for deletes) */
  row_json: unknown | null;
  /** Row version for optimistic concurrency */
  row_version: number | null;
  /**
   * Scope values for this change (stored as JSONB).
   * Example: { user_id: 'U1', project_id: 'P1' }
   */
  scopes: StoredScopes;
}

export interface ApplyOperationResult {
  result: SyncOperationResult;
  emittedChanges: EmittedChange[];
}

/**
 * Context for server operations.
 */
export interface ServerContext<
  DB extends SyncCoreDb = SyncCoreDb,
  Auth extends SyncServerAuth = SyncServerAuth,
> {
  /** Database connection (transaction in applyOperation) */
  db: DbExecutor<DB>;
  /** Actor ID (user ID from auth) */
  actorId: string;
  /** Full auth payload returned by authenticate */
  auth: Auth;
}

/**
 * Context passed to snapshot method.
 */
export interface ServerSnapshotContext<
  DB extends SyncCoreDb = SyncCoreDb,
  ScopeKeys extends string = string,
  Auth extends SyncServerAuth = SyncServerAuth,
> extends ServerContext<DB, Auth> {
  /** Database executor for the snapshot */
  db: DbExecutor<DB>;
  /** Effective scope values for this subscription */
  scopeValues: ScopeValuesForKeys<ScopeKeys>;
  /** Pagination cursor (row_id for keyset pagination) */
  cursor: string | null;
  /** Max rows to return */
  limit: number;
}

/**
 * Context passed to applyOperation method.
 */
export interface ServerApplyOperationContext<
  DB extends SyncCoreDb = SyncCoreDb,
  Auth extends SyncServerAuth = SyncServerAuth,
> extends ServerContext<DB, Auth> {
  /** Database executor for the operation */
  trx: DbExecutor<DB>;
  /** Client/device identifier */
  clientId: string;
  /** Unique commit identifier */
  commitId: string;
  /**
   * Client's schema version when the commit was created.
   * Use this to transform payloads from older client versions.
   */
  schemaVersion: number;
}

/**
 * Server-side scope configuration for advanced use cases.
 * Use this when you need custom extraction, access control, or filtering.
 *
 * For simple cases, use the simplified scope array format:
 * `scopes: ['user:{user_id}']`
 */
interface ServerScopeConfig {
  /**
   * Column name containing the scope value.
   * For simple patterns like 'user:{user_id}' → column: 'user_id'
   */
  column?: string;

  /**
   * Custom extractor for complex patterns.
   * Example: extract year/month from a date column
   */
  extract?: (row: Record<string, unknown>) => Record<string, string>;

  /**
   * Optional access control per scope pattern.
   * Return true if the actor can access this scope value.
   */
  access?: (
    ctx: ServerContext,
    vars: Record<string, string>
  ) => Promise<boolean>;

  /**
   * Optional filter builder for wildcard subscriptions.
   * Called when the subscription uses wildcards for this pattern.
   */
  toFilter?: (
    vars: Record<string, string | undefined>,
    query: unknown
  ) => unknown;
}

/**
 * Server handler options - configuration for a table's sync behavior.
 */
export interface ServerHandlerOptions<
  DB extends SyncCoreDb = SyncCoreDb,
  Auth extends SyncServerAuth = SyncServerAuth,
  Scopes extends Record<ScopePattern, Record<string, string>> = Record<
    ScopePattern,
    Record<string, string>
  >,
  TableName extends string = string,
  Params extends ZodSchema = ZodSchema,
> {
  /**
   * Scope patterns this handler uses.
   * Array of pattern keys from SharedScopes.
   */
  scopes: (keyof Scopes)[];

  /**
   * Scope definitions - how each pattern maps to row data.
   * Defaults to using column name = variable name.
   */
  scopeDefinitions?: Partial<Record<keyof Scopes, ServerScopeConfig>>;

  /**
   * Resolve allowed scope values for the current actor.
   * Called once per request to determine what the actor can access.
   *
   * Returns scope values the actor is allowed to access.
   * The server will intersect requested scopes with these.
   *
   * @example
   * resolveScopes: async (ctx) => ({
   *   user_id: [ctx.user.id],
   *   project_id: ctx.user.projectIds,
   * })
   */
  resolveScopes: (ctx: ServerContext<DB, Auth>) => Promise<ScopeValues>;

  /**
   * Optional Zod schema for subscription parameters.
   */
  params?: Params;

  /**
   * Primary key column (default: 'id')
   */
  primaryKey?: string;

  /**
   * Version column for optimistic concurrency (default: 'server_version')
   */
  versionColumn?: string;

  /**
   * Tables that must be bootstrapped before this one.
   */
  dependsOn?: string[];

  /**
   * TTL for cached snapshot chunks (ms). Default: 24 hours.
   */
  snapshotChunkTtlMs?: number;

  /**
   * Transform client payload → server row on writes.
   */
  transformInbound?: (
    payload: Record<string, unknown>,
    ctx: ServerApplyOperationContext<DB, Auth>
  ) => Partial<DB[TableName & keyof DB]>;

  /**
   * Transform server row → client payload on reads.
   */
  transformOutbound?: (
    row: DB[TableName & keyof DB]
  ) => Record<string, unknown>;

  /**
   * Custom snapshot implementation.
   * Default uses keyset pagination ordered by primary key.
   */
  snapshot?: (
    ctx: ServerSnapshotContext<DB, string, Auth>,
    params: Params extends ZodSchema ? z.infer<Params> : undefined
  ) => Promise<{ rows: unknown[]; nextCursor: string | null }>;

  /**
   * Custom apply operation implementation.
   */
  applyOperation?: (
    ctx: ServerApplyOperationContext<DB, Auth>,
    op: SyncOperation,
    opIndex: number
  ) => Promise<ApplyOperationResult>;
}

/**
 * Server-side table handler for snapshots and mutations.
 * This is the internal handler interface used by the sync engine.
 */
export interface ServerTableHandler<
  DB extends SyncCoreDb = SyncCoreDb,
  Auth extends SyncServerAuth = SyncServerAuth,
> {
  /** Table name */
  table: string;

  /** Scope patterns used by this handler */
  scopePatterns: ScopePattern[];

  /**
   * Tables that must be bootstrapped before this one.
   */
  dependsOn?: string[];

  /**
   * TTL for cached snapshot chunks (ms).
   */
  snapshotChunkTtlMs?: number;

  /**
   * Resolve allowed scope values for the current actor.
   */
  resolveScopes: (ctx: ServerContext<DB, Auth>) => Promise<ScopeValues>;

  /**
   * Extract stored scopes from a row.
   */
  extractScopes: (row: Record<string, unknown>) => StoredScopes;

  /**
   * Build a bootstrap snapshot page.
   */
  snapshot(
    ctx: ServerSnapshotContext<DB, string, Auth>,
    params: Record<string, unknown> | undefined
  ): Promise<{ rows: unknown[]; nextCursor: string | null }>;

  /**
   * Apply a single operation.
   */
  applyOperation(
    ctx: ServerApplyOperationContext<DB, Auth>,
    op: SyncOperation,
    opIndex: number
  ): Promise<ApplyOperationResult>;
}
