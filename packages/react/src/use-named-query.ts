/**
 * `useNamedQuery` — the live-query hook for the generated NAMED-query tier
 * (typegen's sqlc/SQLDelight rung). You author a `.sql` file; typegen emits a
 * typed `NamedQuery` descriptor (`{ sql, tables, bind }`) + its `Row` type.
 * This hook runs that descriptor live and reuses {@link useSyncQuery}'s
 * invalidation machinery verbatim — the descriptor's `tables` set is the EXACT
 * dependency set (typegen resolved it from the query's FROM/JOIN against the
 * schema IR), so invalidation is precise with zero SQL-text heuristic and the
 * row type is the query's own projection.
 *
 * ```ts
 * import { listProjectTasksQuery } from './syncular.queries';
 * const { rows } = useNamedQuery(listProjectTasksQuery, { projectId });
 * //      ^ ListProjectTasksRow[]
 * ```
 *
 * A param-less query takes no second argument. The descriptor is import-free
 * (typegen emits its own `NamedQuery` type), so this hook depends only on the
 * descriptor's structural shape — no generated-file import coupling.
 */
import type { SqlValue } from '@syncular/client';
import {
  type UseSyncQueryOptions,
  type UseSyncQueryResult,
  useSyncQuery,
} from './use-sync-query';

/** The structural shape typegen's `NamedQuery<Row, Params>` satisfies. */
export interface NamedQueryDescriptor<Row, Params> {
  readonly sql: string;
  readonly tables: readonly string[];
  readonly bind: (params: Params) => readonly SqlValue[];
  /** Phantom row carrier (never read at runtime). */
  readonly __row?: Row;
}

/** Run a param-less named query live. */
export function useNamedQuery<Row>(
  query: NamedQueryDescriptor<Row, undefined>,
  options?: Omit<UseSyncQueryOptions, 'tables'>,
): UseSyncQueryResult<Row>;
/** Run a named query live with its typed params. */
export function useNamedQuery<Row, Params>(
  query: NamedQueryDescriptor<Row, Params>,
  params: Params,
  options?: Omit<UseSyncQueryOptions, 'tables'>,
): UseSyncQueryResult<Row>;
export function useNamedQuery<Row, Params>(
  query: NamedQueryDescriptor<Row, Params>,
  paramsOrOptions?: Params | Omit<UseSyncQueryOptions, 'tables'>,
  maybeOptions?: Omit<UseSyncQueryOptions, 'tables'>,
): UseSyncQueryResult<Row> {
  // Overload disambiguation: a param-less query's second arg (if any) is the
  // options object; a parameterized query's second arg is the params.
  const hasParams = query.bind.length > 0;
  const params = (hasParams ? paramsOrOptions : undefined) as Params;
  const options = (hasParams ? maybeOptions : paramsOrOptions) as
    | Omit<UseSyncQueryOptions, 'tables'>
    | undefined;

  const bound = query.bind(params) as readonly SqlValue[];
  return useSyncQuery<Row>(query.sql, bound, {
    ...options,
    tables: query.tables,
  });
}
