import {
  canonicalValue,
  ClientSyncError,
  type LiveQueryPhase,
  type LiveQueryResult,
  type QueryDependency,
  type SqlRow,
  type SqlValue,
  type SyncAvailability,
  type WindowCoverage,
} from '@syncular/client';
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { useReactiveStore } from './use-client';

export interface UseRawSqlOptions<Row = SqlRow> {
  /** Legacy table list; prefer table-associated `dependencies`. */
  readonly tables?: readonly string[];
  /** Legacy narrowing applied to every table in `tables`. */
  readonly scopeKeys?: readonly string[];
  readonly dependencies?: readonly QueryDependency[];
  readonly coverage?: readonly WindowCoverage[];
  /** Optional semantic row decoder. Generated named queries provide this. */
  readonly mapRow?: (row: Readonly<SqlRow>) => Row;
  readonly rowKey?: (row: Row) => readonly SqlValue[];
  /** Generated coverage claims its windows by default. */
  readonly claimCoverage?: boolean;
  readonly enabled?: boolean;
  /**
   * Stable, PHI-free query id. It names the query in
   * `diagnosticsSnapshot().queryFailures`; without it the query reports as
   * `raw`.
   */
  readonly id?: string;
}

export interface UseRawSqlResult<Row> {
  readonly rows: readonly Row[];
  /** `disabled` while `enabled` is `false`: the hook reads nothing. */
  readonly phase: LiveQueryPhase | 'disabled';
  readonly revision: bigint | undefined;
  readonly isLoading: boolean;
  readonly isRefreshing: boolean;
  readonly error: Error | undefined;
  readonly availability: SyncAvailability;
  readonly refresh: () => void;
}

const DISABLED = {
  rows: [],
  phase: 'disabled',
  revision: undefined,
  error: undefined,
  isRefreshing: false,
  availability: { state: 'ready' },
} as const;

const noSubscribe = (): (() => void) => () => {};

export function useRawSql<Row = SqlRow>(
  sql: string,
  params?: readonly SqlValue[],
  options?: UseRawSqlOptions<Row>,
): UseRawSqlResult<Row> {
  const store = useReactiveStore();
  const enabled = options?.enabled ?? true;
  const dependencies =
    options?.dependencies ??
    options?.tables?.map((table) => ({
      table,
      ...(options?.scopeKeys !== undefined
        ? { scopeKeys: options.scopeKeys }
        : {}),
    }));
  if (dependencies === undefined) {
    throw new ClientSyncError(
      'client.raw_sql_dependencies_required',
      '@syncular/react: useRawSql needs `dependencies` or `tables` naming every table the SQL reads; the query re-runs only when one of them changes.',
    );
  }
  const coverage = options?.coverage ?? [];
  const claimCoverage = options?.claimCoverage ?? true;
  const identity = canonicalValue({
    sql,
    params: params ?? [],
    dependencies,
    coverage,
    claimCoverage,
    ...(options?.id !== undefined ? { id: options.id } : {}),
  });
  // `identity` canonically contains every value-shaped input. Depending on
  // the caller's array/object references would defeat value-stable query
  // identity; executable decoders and row keys follow function identity.
  // oxlint-disable react-hooks/exhaustive-deps -- canonical value identity is the dependency
  const entry = useMemo(
    () =>
      store.query<Row>({
        // The store keys entries by SQL, params, and dependencies as well, so
        // the id only names the query in diagnostics and never carries SQL.
        id: options?.id ?? 'raw',
        sql,
        ...(params !== undefined ? { params } : {}),
        dependencies,
        ...(coverage.length > 0 ? { coverage } : {}),
        ...(options?.mapRow !== undefined ? { mapRow: options.mapRow } : {}),
        ...(options?.rowKey !== undefined ? { rowKey: options.rowKey } : {}),
        claimCoverage,
      }),
    [store, identity, options?.mapRow, options?.rowKey],
  );
  // oxlint-enable react-hooks/exhaustive-deps
  const snapshot = useSyncExternalStore<LiveQueryResult<Row> | typeof DISABLED>(
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
    availability: snapshot.availability,
    refresh,
  };
}
