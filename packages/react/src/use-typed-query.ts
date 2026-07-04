/**
 * `useTypedQuery` — the typed twin of {@link useSyncQuery}. You write a
 * Kysely query builder; the hook compiles it to SQL, runs it live against the
 * client, and extracts its `{tables}` dependency set from the compiled query's
 * AST automatically — so invalidation is exact (no SQL-text heuristic) and
 * fully typed by the schema's generated `Database` interface.
 *
 * ```ts
 * const { rows } = useTypedQuery<Database, Pick<TodosRow, 'id' | 'title'>>(
 *   (db) => db.selectFrom('todos').select(['id', 'title']).where('list_id', '=', listId),
 *   [listId],
 * );
 * ```
 *
 * It reuses {@link useSyncQuery}'s invalidation machinery verbatim — the only
 * additions are compilation and AST-based table extraction. Read-only, like
 * the dialect: a write builder throws at execution (SPEC §7.1 → use
 * `useMutation`). `@syncular-v2/kysely` and `kysely` are PEER dependencies of
 * this package (both are `optional`), so apps that only use `useSyncQuery`
 * never pull Kysely in.
 */
import { createSyncularKysely, extractTables } from '@syncular-v2/kysely';
import type { SqlRow, SqlValue } from '@syncular-v2/web-client';
import type { Compilable, CompiledQuery, Kysely } from 'kysely';
import { useMemo } from 'react';
import { useSyncClient } from './use-client';
import {
  type UseSyncQueryOptions,
  type UseSyncQueryResult,
  useSyncQuery,
} from './use-sync-query';

/**
 * Build a live typed query. `build` receives a `Kysely<Database>` bound to the
 * context client and returns any compilable query builder. `deps` re-keys the
 * builder the same way a `useEffect` dep array does (values the query closes
 * over, e.g. filter inputs). `options.enabled`/`scopeKeys` pass through; the
 * `{tables}` set is derived from the compiled query, never guessed.
 */
export function useTypedQuery<Database, Row = SqlRow>(
  build: (db: Kysely<Database>) => Compilable<Row>,
  deps: readonly unknown[] = [],
  options?: Omit<UseSyncQueryOptions, 'tables'>,
): UseSyncQueryResult<Row> {
  const client = useSyncClient();

  // One Kysely instance per client identity — the dialect drives the same
  // normalized `query` surface the other hooks use, so every host works.
  const db = useMemo(() => createSyncularKysely<Database>(client), [client]);

  // Compile on the deps the caller declared. The compiled query yields SQL +
  // parameters (for execution) and its AST (for exact table extraction).
  // biome-ignore lint/correctness/useExhaustiveDependencies: `deps` is the caller-declared re-key, `build`/`db` are stable-by-design
  const compiled: CompiledQuery<Row> = useMemo(
    () => build(db).compile(),
    [db, ...deps],
  );

  const tables = useMemo(() => extractTables(compiled), [compiled]);

  return useSyncQuery<Row>(
    compiled.sql,
    compiled.parameters as readonly SqlValue[],
    { ...options, tables },
  );
}
