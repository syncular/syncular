/**
 * Public query exports used by packages that consume @syncular/client.
 *
 * This wrapper keeps query-builder tracking isolated per chain so branching a
 * base Kysely builder does not leak joined tables into sibling branches.
 */

import {
  applyQueryResultPlan,
  buildQueryResultPlan,
  type ColumnCodecDialect,
  type ColumnCodecSource,
  createTableColumnCodecsResolver,
} from '@syncular/core';
import type { Kysely, RootOperationNode } from 'kysely';
import type { FingerprintCollector } from './query/FingerprintCollector';
import {
  computeRowFingerprint,
  computeValueFingerprint,
  hasKeyField,
  type MutationTimestampSource,
} from './query/fingerprint';
import type { SyncClientDb } from './schema';

export { FingerprintCollector } from './query/FingerprintCollector';
export {
  canFingerprint,
  computeFingerprint,
} from './query/fingerprint';

export type FingerprintMode = 'auto' | 'value';

type TrackedSelectFrom<DB> = Kysely<DB>['selectFrom'];
type SelectFromArgs<DB> = Parameters<Kysely<DB>['selectFrom']>;
type SelectFromResult<DB> = ReturnType<Kysely<DB>['selectFrom']>;

type ExecutableQuery = {
  execute: () => Promise<unknown>;
  executeTakeFirst: () => Promise<unknown>;
  executeTakeFirstOrThrow: () => Promise<unknown>;
};

type OperationNodeSource = {
  toOperationNode: () => RootOperationNode;
};

const JOIN_METHODS = new Set([
  'innerJoin',
  'leftJoin',
  'rightJoin',
  'fullJoin',
  'crossJoin',
  'innerJoinLateral',
  'leftJoinLateral',
  'crossJoinLateral',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isExecutableQuery(value: unknown): value is ExecutableQuery {
  if (!isRecord(value)) return false;
  return (
    typeof Reflect.get(value, 'execute') === 'function' &&
    typeof Reflect.get(value, 'executeTakeFirst') === 'function' &&
    typeof Reflect.get(value, 'executeTakeFirstOrThrow') === 'function'
  );
}

function extractTrackedTableNames(value: unknown): string[] {
  if (typeof value === 'string') {
    const normalized = value.trim();
    if (normalized.length === 0) return [];

    const aliasIndex = normalized.search(/\s+as\s+/i);
    const withoutAlias =
      aliasIndex >= 0 ? normalized.slice(0, aliasIndex) : normalized;
    const firstToken = withoutAlias.split(/\s+/)[0] ?? '';
    return firstToken.length > 0 ? [firstToken] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => extractTrackedTableNames(entry));
  }

  return [];
}

function addFingerprint(args: {
  rows: unknown;
  primaryTable: string | null;
  trackedTables: ReadonlySet<string>;
  collector: FingerprintCollector;
  engine: MutationTimestampSource;
  keyField: string;
  fingerprintMode: FingerprintMode;
}): void {
  const {
    rows,
    primaryTable,
    trackedTables,
    collector,
    engine,
    keyField,
    fingerprintMode,
  } = args;

  const fingerprintScope =
    trackedTables.size > 0
      ? Array.from(trackedTables).sort().join('+')
      : (primaryTable ?? 'query');

  if (
    fingerprintMode === 'auto' &&
    primaryTable &&
    trackedTables.size === 1 &&
    Array.isArray(rows) &&
    hasKeyField(rows, keyField)
  ) {
    collector.add(computeRowFingerprint(rows, primaryTable, engine, keyField));
    return;
  }

  collector.add(computeValueFingerprint(fingerprintScope, rows));
}

function addTrackedTablesToScopeCollector(
  scopeCollector: Set<string>,
  trackedTables: ReadonlySet<string>
): void {
  for (const trackedTable of trackedTables) {
    scopeCollector.add(trackedTable);
  }
}

function isOperationNodeSource(value: unknown): value is OperationNodeSource {
  if (!isRecord(value)) return false;
  return typeof Reflect.get(value, 'toOperationNode') === 'function';
}

function decodeRows(
  rows: unknown,
  builder: OperationNodeSource | undefined,
  resolveCodecs:
    | ((table: string, row: Record<string, unknown>) => Record<string, unknown>)
    | undefined,
  codecDialect: ColumnCodecDialect
): unknown {
  if (!resolveCodecs || !builder) return rows;
  const plan = buildQueryResultPlan(builder.toOperationNode());
  if (!plan) return rows;
  if (Array.isArray(rows)) {
    return rows.map((row) => {
      if (!isRecord(row)) return row;
      return applyQueryResultPlan({
        row,
        plan,
        resolveTableCodecs: resolveCodecs,
        dialect: codecDialect,
      });
    });
  }
  if (!isRecord(rows)) return rows;
  return applyQueryResultPlan({
    row: rows,
    plan,
    resolveTableCodecs: resolveCodecs,
    dialect: codecDialect,
  });
}

function createExecuteProxy<B extends ExecutableQuery>(
  builder: B,
  primaryTable: string | null,
  trackedTables: ReadonlySet<string>,
  scopeCollector: Set<string>,
  collector: FingerprintCollector,
  engine: MutationTimestampSource,
  keyField: string,
  fingerprintMode: FingerprintMode,
  resolveCodecs:
    | ((table: string, row: Record<string, unknown>) => Record<string, unknown>)
    | undefined,
  codecDialect: ColumnCodecDialect
): B {
  const operationNodeSource = isOperationNodeSource(builder) ? builder : undefined;

  return new Proxy(builder, {
    get(target, prop, receiver) {
      if (prop === 'execute') {
        return async () => {
          const rows = await target.execute();
          const decoded = decodeRows(
            rows,
            operationNodeSource,
            resolveCodecs,
            codecDialect
          );
          addTrackedTablesToScopeCollector(scopeCollector, trackedTables);
          addFingerprint({
            rows: decoded,
            primaryTable,
            trackedTables,
            collector,
            engine,
            keyField,
            fingerprintMode,
          });
          return decoded;
        };
      }

      if (prop === 'executeTakeFirst') {
        return async () => {
          const row = await target.executeTakeFirst();
          const decoded = decodeRows(
            row,
            operationNodeSource,
            resolveCodecs,
            codecDialect
          );
          addTrackedTablesToScopeCollector(scopeCollector, trackedTables);
          addFingerprint({
            rows: decoded,
            primaryTable,
            trackedTables,
            collector,
            engine,
            keyField,
            fingerprintMode,
          });
          return decoded;
        };
      }

      if (prop === 'executeTakeFirstOrThrow') {
        return async () => {
          const row = await target.executeTakeFirstOrThrow();
          const decoded = decodeRows(
            row,
            operationNodeSource,
            resolveCodecs,
            codecDialect
          );
          addTrackedTablesToScopeCollector(scopeCollector, trackedTables);
          addFingerprint({
            rows: decoded,
            primaryTable,
            trackedTables,
            collector,
            engine,
            keyField,
            fingerprintMode,
          });
          return decoded;
        };
      }

      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') {
        return value;
      }

      return (...args: unknown[]) => {
        const nextTrackedTables = new Set(trackedTables);

        if (
          typeof prop === 'string' &&
          JOIN_METHODS.has(prop) &&
          args.length > 0
        ) {
          for (const tableName of extractTrackedTableNames(args[0])) {
            nextTrackedTables.add(tableName);
          }
        }

        const result = Reflect.apply(value, target, args);
        if (!isExecutableQuery(result)) {
          return result;
        }

        return createExecuteProxy(
          result,
          primaryTable,
          nextTrackedTables,
          scopeCollector,
          collector,
          engine,
          keyField,
          fingerprintMode,
          resolveCodecs,
          codecDialect
        );
      };
    },
  });
}

function createTrackedSelectFrom<DB extends SyncClientDb>(
  db: Kysely<DB>,
  scopeCollector: Set<string>,
  fingerprintCollector: FingerprintCollector,
  engine: MutationTimestampSource,
  keyField = 'id',
  fingerprintMode: FingerprintMode = 'auto',
  codecSource?: ColumnCodecSource,
  codecDialect: ColumnCodecDialect = 'sqlite'
): TrackedSelectFrom<DB> {
  const resolveCodecs = codecSource
    ? createTableColumnCodecsResolver(codecSource, { dialect: codecDialect })
    : undefined;

  const selectFrom = (...args: SelectFromArgs<DB>) => {
    const trackedTables = new Set<string>(extractTrackedTableNames(args[0]));
    const primaryTable = Array.from(trackedTables)[0] ?? null;
    const builder = db.selectFrom(...args);

    return createExecuteProxy(
      builder,
      primaryTable,
      trackedTables,
      scopeCollector,
      fingerprintCollector,
      engine,
      keyField,
      fingerprintMode,
      resolveCodecs,
      codecDialect
    ) as SelectFromResult<DB>;
  };

  return selectFrom as TrackedSelectFrom<DB>;
}

export interface QueryContext<DB extends SyncClientDb = SyncClientDb> {
  selectFrom: TrackedSelectFrom<DB>;
}

export function createQueryContext<DB extends SyncClientDb>(
  db: Kysely<DB>,
  scopeCollector: Set<string>,
  fingerprintCollector: FingerprintCollector,
  engine: MutationTimestampSource,
  keyField = 'id',
  fingerprintMode: FingerprintMode = 'auto',
  codecSource?: ColumnCodecSource,
  codecDialect: ColumnCodecDialect = 'sqlite'
): QueryContext<DB> {
  return {
    selectFrom: createTrackedSelectFrom(
      db,
      scopeCollector,
      fingerprintCollector,
      engine,
      keyField,
      fingerprintMode,
      codecSource,
      codecDialect
    ),
  };
}
