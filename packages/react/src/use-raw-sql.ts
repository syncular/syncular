import {
  canonicalValue,
  type LiveQueryPhase,
  type QueryDependency,
  type SqlRow,
  type SqlValue,
  type WindowCoverage,
} from '@syncular/client';
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { inferTables } from './infer-tables';
import { useReactiveStore } from './use-client';

export interface UseRawSqlOptions<Row = SqlRow> {
  /** Legacy table list; prefer table-associated `dependencies`. */
  readonly tables?: readonly string[];
  /** Legacy narrowing applied to every table in `tables`. */
  readonly scopeKeys?: readonly string[];
  readonly dependencies?: readonly QueryDependency[];
  readonly coverage?: readonly WindowCoverage[];
  readonly rowKey?: (row: Row) => readonly SqlValue[];
  /** Generated coverage claims its windows by default. */
  readonly claimCoverage?: boolean;
  readonly enabled?: boolean;
  /** Stable identity override for a raw query cache entry. */
  readonly id?: string;
}

export interface UseRawSqlResult<Row> {
  readonly rows: readonly Row[];
  readonly phase: LiveQueryPhase;
  readonly revision: bigint | undefined;
  readonly isLoading: boolean;
  readonly isRefreshing: boolean;
  readonly error: Error | undefined;
  readonly refresh: () => void;
}

const DISABLED = {
  rows: [],
  phase: 'ready',
  revision: undefined,
  error: undefined,
  isRefreshing: false,
} as const;

const noSubscribe = (): (() => void) => () => {};

export function useRawSql<Row = SqlRow>(
  sql: string,
  params?: readonly SqlValue[],
  options?: UseRawSqlOptions<Row>,
): UseRawSqlResult<Row> {
  const store = useReactiveStore();
  const enabled = options?.enabled ?? true;
  const inferred = options?.tables ?? [...inferTables(sql)];
  const dependencies =
    options?.dependencies ??
    inferred.map((table) => ({
      table,
      ...(options?.scopeKeys !== undefined
        ? { scopeKeys: options.scopeKeys }
        : {}),
    }));
  const coverage = options?.coverage ?? [];
  const identity = canonicalValue({
    sql,
    params: params ?? [],
    dependencies,
    coverage,
    ...(options?.id !== undefined ? { id: options.id } : {}),
  });
  // `identity` canonically contains every value-shaped input. Depending on
  // the caller's array/object references would defeat value-stable query
  // identity; executable rowKey intentionally follows function identity.
  // biome-ignore lint/correctness/useExhaustiveDependencies: canonical value identity is the dependency
  const entry = useMemo(
    () =>
      store.query<Row>({
        id: options?.id ?? `raw:${identity}`,
        sql,
        ...(params !== undefined ? { params } : {}),
        dependencies,
        ...(coverage.length > 0 ? { coverage } : {}),
        ...(options?.rowKey !== undefined ? { rowKey: options.rowKey } : {}),
        claimCoverage: options?.claimCoverage ?? true,
      }),
    [store, identity, options?.rowKey],
  );
  const snapshot = useSyncExternalStore(
    enabled ? entry.subscribe : noSubscribe,
    enabled ? entry.getSnapshot : () => DISABLED,
    enabled ? entry.getSnapshot : () => DISABLED,
  );
  const refresh = useCallback(() => {
    if (enabled) entry.refresh();
  }, [enabled, entry]);
  return {
    rows: snapshot.rows as readonly Row[],
    phase: snapshot.phase,
    revision: snapshot.revision,
    isLoading: snapshot.phase === 'loading',
    isRefreshing: snapshot.isRefreshing,
    error: snapshot.error,
    refresh,
  };
}
