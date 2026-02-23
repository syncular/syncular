/**
 * @syncular/client - Query Context
 *
 * Provides a query context with tracked selectFrom for scope tracking
 * and automatic fingerprint generation.
 */

import type { Kysely } from 'kysely';
import type { SyncClientDb } from '../schema';
import type { FingerprintCollector } from './FingerprintCollector';
import type { MutationTimestampSource } from './fingerprint';
import { createTrackedSelectFrom } from './tracked-select';

export type TrackedSelectFrom<DB> = ReturnType<
  typeof createTrackedSelectFrom<DB>
>;

/**
 * Query context provided to query functions.
 *
 * Only `selectFrom` is exposed to ensure proper scope tracking and fingerprinting.
 * If you need raw database access, use the db directly outside the query function.
 */
export interface QueryContext<DB extends SyncClientDb = SyncClientDb> {
  /**
   * Wrapped selectFrom that:
   * 1. Registers table as watched scope
   * 2. Intercepts .execute() to auto-detect fingerprinting mode:
   *    - Result has keyField (default: 'id')? -> row-level fingerprinting
   *    - No keyField? -> value-based fingerprinting (for aggregates)
   */
  selectFrom: TrackedSelectFrom<DB>;
}

/**
 * Create a query context with tracked selectFrom.
 */
export function createQueryContext<DB extends SyncClientDb>(
  db: Kysely<DB>,
  scopeCollector: Set<string>,
  fingerprintCollector: FingerprintCollector,
  engine: MutationTimestampSource,
  keyField = 'id'
): QueryContext<DB> {
  return {
    selectFrom: createTrackedSelectFrom(
      db,
      scopeCollector,
      fingerprintCollector,
      engine,
      keyField
    ),
  };
}
