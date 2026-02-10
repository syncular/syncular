/**
 * @syncular/client - Tracked SelectFrom
 *
 * Provides a wrapped selectFrom that:
 * 1. Tracks tables as watched scopes when called
 * 2. Intercepts .execute() to auto-generate fingerprints
 */

import type { Kysely } from 'kysely';
import type { FingerprintCollector } from './FingerprintCollector';

/** Portable type alias for Kysely's selectFrom method signature */
type TrackedSelectFrom<DB> = Kysely<DB>['selectFrom'];

import {
  computeRowFingerprint,
  computeValueFingerprint,
  hasKeyField,
  type MutationTimestampSource,
} from './fingerprint';

/**
 * Create a proxy that intercepts execute() to compute fingerprints.
 */

type ExecutableQuery = {
  execute: () => Promise<unknown>;
  executeTakeFirst: () => Promise<unknown>;
  executeTakeFirstOrThrow: () => Promise<unknown>;
};

function isExecutableQuery(value: unknown): value is ExecutableQuery {
  if (typeof value !== 'object' || value === null) return false;
  return (
    typeof Reflect.get(value, 'execute') === 'function' &&
    typeof Reflect.get(value, 'executeTakeFirst') === 'function' &&
    typeof Reflect.get(value, 'executeTakeFirstOrThrow') === 'function'
  );
}

function createExecuteProxy<B extends ExecutableQuery>(
  builder: B,
  table: string,
  collector: FingerprintCollector,
  engine: MutationTimestampSource,
  keyField: string
): B {
  return new Proxy(builder, {
    get(target, prop: string | symbol) {
      if (prop === 'execute') {
        return async () => {
          const rows = await target.execute();
          // Auto-detect fingerprint mode based on result shape
          if (Array.isArray(rows)) {
            if (hasKeyField(rows, keyField)) {
              // Row-level fingerprinting - result has keyField
              const fp = computeRowFingerprint(rows, table, engine, keyField);
              collector.add(fp);
            } else {
              // Value-based fingerprinting - for aggregates/scalars
              const fp = computeValueFingerprint(table, rows);
              collector.add(fp);
            }
          } else {
            // Unexpected, but keep rerender behavior deterministic.
            const fp = computeValueFingerprint(table, rows);
            collector.add(fp);
          }
          return rows;
        };
      }
      if (prop === 'executeTakeFirst') {
        return async () => {
          const row = await target.executeTakeFirst();
          // Value-based fingerprinting for single-row queries
          const fp = computeValueFingerprint(table, row);
          collector.add(fp);
          return row;
        };
      }
      if (prop === 'executeTakeFirstOrThrow') {
        return async () => {
          const row = await target.executeTakeFirstOrThrow();
          // Value-based fingerprinting for single-row queries
          const fp = computeValueFingerprint(table, row);
          collector.add(fp);
          return row;
        };
      }
      // For other methods, return wrapped builder for chaining
      const value = Reflect.get(target, prop, target);
      if (typeof value === 'function') {
        return (...args: unknown[]) => {
          const result = Reflect.apply(value, target, args);
          if (isExecutableQuery(result)) {
            return createExecuteProxy(
              result,
              table,
              collector,
              engine,
              keyField
            );
          }
          return result;
        };
      }
      return value;
    },
  });
}

/**
 * Create a tracked selectFrom that registers scopes and generates fingerprints.
 */
export function createTrackedSelectFrom<DB>(
  db: Kysely<DB>,
  scopeCollector: Set<string>,
  fingerprintCollector: FingerprintCollector,
  engine: MutationTimestampSource,
  keyField = 'id'
): TrackedSelectFrom<DB> {
  const selectFrom = <TB extends keyof DB & string>(table: TB) => {
    // 1. Register this table as a watched scope
    scopeCollector.add(table);

    // 2. Get the real query builder
    const builder = db.selectFrom(table);

    // 3. Return a proxy that intercepts .execute()
    return createExecuteProxy(
      builder,
      table,
      fingerprintCollector,
      engine,
      keyField
    );
  };
  return selectFrom as TrackedSelectFrom<DB>;
}
