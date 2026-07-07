/**
 * `useQuery` — the live-query hook for the generated NAMED-query tier
 * (typegen's sqlc/SQLDelight rung). You author a `.sql` file; typegen emits a
 * typed `NamedQuery` descriptor (`{ sql, tables, bind }`) + its `Row` type.
 * This hook runs that descriptor live and reuses {@link useRawSql}'s
 * invalidation machinery verbatim — the descriptor's `tables` set is the EXACT
 * dependency set (typegen resolved it from the query's FROM/JOIN against the
 * schema IR), so invalidation is precise with zero SQL-text heuristic and the
 * row type is the query's own projection.
 *
 * ```ts
 * import { listProjectTasksQuery } from './syncular.queries';
 * const { rows } = useQuery(listProjectTasksQuery, { projectId });
 * //      ^ ListProjectTasksRow[]
 * ```
 *
 * A param-less query takes no second argument. The descriptor is import-free
 * (typegen emits its own `NamedQuery` type), so this hook depends only on the
 * descriptor's structural shape — no generated-file import coupling.
 */
import type { SqlValue } from '@syncular/client';
import {
  type UseRawSqlOptions,
  type UseRawSqlResult,
  useRawSql,
} from './use-raw-sql';

/** The structural shape typegen's `NamedQuery<Row, Params>` satisfies. */
export interface NamedQueryDescriptor<Row, Params> {
  readonly sql: string;
  readonly tables: readonly string[];
  readonly bind: (params: Params) => readonly SqlValue[];
  /** §6 orderBy knob: composes the statement for the CHOSEN order from a
   * generate-time-checked allowlist (identifiers never come from runtime
   * input). Absent on knob-less queries — `sql` is the whole statement. */
  readonly sqlFor?: (params: Params) => string;
  /** Phantom row carrier (never read at runtime). */
  readonly __row?: Row;
}

/** Run a param-less named query live. */
export function useQuery<Row>(
  query: NamedQueryDescriptor<Row, undefined>,
  options?: Omit<UseRawSqlOptions, 'tables'>,
): UseRawSqlResult<Row>;
/** Run a named query live with its typed params. */
export function useQuery<Row, Params>(
  query: NamedQueryDescriptor<Row, Params>,
  params: Params,
  options?: Omit<UseRawSqlOptions, 'tables'>,
): UseRawSqlResult<Row>;
export function useQuery<Row, Params>(
  query: NamedQueryDescriptor<Row, Params>,
  paramsOrOptions?: Params | Omit<UseRawSqlOptions, 'tables'>,
  maybeOptions?: Omit<UseRawSqlOptions, 'tables'>,
): UseRawSqlResult<Row> {
  // Overload disambiguation: a param-less query's second arg (if any) is the
  // options object; a parameterized query's second arg is the params.
  const hasParams = query.bind.length > 0;
  const params = (hasParams ? paramsOrOptions : undefined) as Params;
  const options = (hasParams ? maybeOptions : paramsOrOptions) as
    | Omit<UseRawSqlOptions, 'tables'>
    | undefined;

  const bound = query.bind(params) as readonly SqlValue[];
  const sql = query.sqlFor === undefined ? query.sql : query.sqlFor(params);
  return useRawSql<Row>(sql, bound, {
    ...options,
    tables: query.tables,
  });
}
