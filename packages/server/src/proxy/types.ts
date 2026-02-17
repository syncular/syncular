/**
 * @syncular/server - Proxy Types
 *
 * Types for database proxy with automatic oplog generation.
 */

import type { StoredScopes } from '@syncular/core';

/**
 * Proxy table handler for mutations.
 *
 * Defines how to compute scopes for rows affected by proxy operations.
 */
export interface ProxyTableHandler {
  /** Database table name */
  table: string;
  /** Primary key column name (default: 'id') */
  primaryKey?: string;
  /** Version column name (default: 'server_version') */
  versionColumn?: string;
  /**
   * Compute scope values for a row.
   *
   * This determines which sync subscriptions will see changes to this row.
   * Returns a JSONB-compatible object of scope key-value pairs.
   *
   * @example
   * computeScopes: (row) => ({
   *   user_id: String(row.user_id),
   *   project_id: String(row.project_id),
   * })
   */
  computeScopes(row: Record<string, unknown>): StoredScopes;
}

/**
 * Context for executing a proxied query.
 */
export interface ProxyQueryContext {
  /** Actor ID for oplog tracking */
  actorId: string;
  /** Client ID for oplog tracking */
  clientId: string;
  /** Logical partition key (default: 'default') */
  partitionId?: string;
}
