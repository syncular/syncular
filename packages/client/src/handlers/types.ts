/**
 * @syncular/client - Sync client table handler interface
 */

import type {
  ScopeValues,
  ScopeValuesForKeys,
  SyncChange,
  SyncSnapshot,
} from '@syncular/core';
import type { Transaction } from 'kysely';

/**
 * Context passed to client table handler methods.
 */
export interface ClientHandlerContext<DB> {
  /** Database transaction */
  trx: Transaction<DB>;
  /**
   * Commit metadata for server-delivered changes.
   * Undefined for local optimistic changes.
   */
  commitSeq?: number | null;
  /** Actor that authored the server commit, when available. */
  actorId?: string | null;
  /** Commit creation timestamp (ISO string), when available. */
  createdAt?: string | null;
}

/**
 * Extended context for snapshot lifecycle hooks.
 */
export interface ClientSnapshotHookContext<DB>
  extends ClientHandlerContext<DB> {
  /** The table being snapshotted */
  table: string;
  /** The scope values for this subscription */
  scopes: ScopeValues;
}

/**
 * Context for clearAll/clearScope operations.
 */
export interface ClientClearContext<DB> extends ClientHandlerContext<DB> {
  /** The scope values to clear (data matching these scopes should be removed) */
  scopes: ScopeValues;
}

/**
 * Subscription configuration for a handler.
 */
export interface HandlerSubscriptionConfig<ScopeKeys extends string = string> {
  /** Scope values for this subscription */
  scopes?: ScopeValuesForKeys<ScopeKeys>;
  /** Params for this subscription */
  params?: Record<string, unknown>;
}

/**
 * Client-side table handler for applying sync snapshots and changes.
 */
export interface ClientTableHandler<
  DB,
  TableName extends keyof DB & string = keyof DB & string,
  ScopeKeys extends string = string,
> {
  /** Table name (used as identifier in sync operations) */
  table: TableName;

  /**
   * Scope patterns used by this table.
   * Used for deriving safe default subscriptions in `createClient`.
   */
  scopePatterns?: string[];

  /**
   * Subscription configuration.
   * - `true`: Subscribe to this table (default)
   * - `false`: Don't subscribe (local-only handler)
   * - Object: Subscribe with custom scopes/params
   */
  subscribe?: boolean | HandlerSubscriptionConfig<ScopeKeys>;

  /**
   * Apply a snapshot page for this table.
   * The handler is responsible for upserting the rows.
   */
  applySnapshot(
    ctx: ClientHandlerContext<DB>,
    snapshot: SyncSnapshot
  ): Promise<void>;

  /**
   * Clear local data for this table matching the given scopes.
   * Used when subscription is removed or revoked.
   * If scopes is empty, clear all data for this table.
   */
  clearAll(ctx: ClientClearContext<DB>): Promise<void>;

  /**
   * Apply a single change (upsert/delete).
   * Must be idempotent (retries may re-apply).
   */
  applyChange(ctx: ClientHandlerContext<DB>, change: SyncChange): Promise<void>;

  /**
   * Optional: Called when a snapshot begins (isFirstPage = true).
   * Use this for marking existing rows as stale before applying snapshot.
   */
  onSnapshotStart?(ctx: ClientSnapshotHookContext<DB>): Promise<void>;

  /**
   * Optional: Called when a snapshot ends (isLastPage = true).
   * Use this for cleaning up stale rows after snapshot is complete.
   */
  onSnapshotEnd?(ctx: ClientSnapshotHookContext<DB>): Promise<void>;
}
