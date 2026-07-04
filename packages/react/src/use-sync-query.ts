/**
 * `useSyncQuery` — a live local SQL query with fine-grained invalidation
 * (TODO 3.1 / DESIGN-eviction I1–I4). The query runs once on mount, then
 * re-runs ONLY when an invalidation event (one per apply batch, from the
 * web-client choke point) touches a table this query depends on — never
 * "re-run everything". Unrelated commits leave the result untouched (I4).
 *
 * Dependencies default to a conservative scan of the SQL text (FROM/JOIN
 * identifiers, {@link inferTables}); pass the explicit `tables` option to
 * override when the text cannot be read (dynamic SQL, views). `scopeKeys`
 * further narrows re-runs to specific §3.1 scope keys when supplied — but
 * a matching TABLE always re-runs (the table is the honest floor; a segment
 * apply carries no per-row scope keys, so table-level is the safe default).
 */

import type {
  InvalidationEvent,
  SqlRow,
  SqlValue,
} from '@syncular-v2/web-client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { inferTables } from './infer-tables';
import { useSyncClient } from './use-client';

export interface UseSyncQueryOptions {
  /**
   * Tables this query depends on. Defaults to a conservative scan of `sql`.
   * Pass explicitly to override the heuristic (the escape hatch).
   */
  readonly tables?: readonly string[];
  /**
   * When set, re-run only if the invalidation event's touched table is a
   * dependency AND (the event has no scope keys — table-level, e.g. a
   * bootstrap — OR it touches one of these §3.1 `prefix:value` keys). Leave
   * unset to re-run on any dependency-table touch.
   */
  readonly scopeKeys?: readonly string[];
  /** Skip running the query (e.g. while inputs are not ready). */
  readonly enabled?: boolean;
}

export interface UseSyncQueryResult<Row> {
  readonly rows: readonly Row[];
  readonly isLoading: boolean;
  readonly error: Error | undefined;
  /** Force a re-run (identity-stable). */
  readonly refresh: () => void;
}

function paramsKey(params: readonly SqlValue[] | undefined): string {
  if (params === undefined || params.length === 0) return '';
  // Stable identity for the params array so a new array with equal contents
  // does not thrash the effect. Uint8Array is rare in query params; JSON of
  // its byte view is stable enough for a dependency key.
  return JSON.stringify(
    params.map((p) => (p instanceof Uint8Array ? [...p] : p)),
  );
}

function eventMatches(
  event: InvalidationEvent,
  tables: ReadonlySet<string>,
  scopeKeys: readonly string[] | undefined,
): boolean {
  let tableHit = false;
  for (const table of event.tables) {
    if (tables.has(table)) {
      tableHit = true;
      break;
    }
  }
  if (!tableHit) return false;
  // Table matched. If the caller narrowed by scope keys, honor it — but a
  // table-level event (no scope keys, e.g. a segment bootstrap or reset)
  // always re-runs, because it carries no key to discriminate on.
  if (scopeKeys === undefined || scopeKeys.length === 0) return true;
  if (event.scopeKeys.size === 0) return true;
  for (const key of scopeKeys) {
    if (event.scopeKeys.has(key)) return true;
  }
  return false;
}

export function useSyncQuery<Row = SqlRow>(
  sql: string,
  params?: readonly SqlValue[],
  options?: UseSyncQueryOptions,
): UseSyncQueryResult<Row> {
  const client = useSyncClient();
  const enabled = options?.enabled ?? true;

  const [rows, setRows] = useState<readonly Row[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(enabled);
  const [error, setError] = useState<Error | undefined>(undefined);

  // The effects depend on stable PRIMITIVE keys (strings), never on the
  // array/object identities a caller may recreate each render. Latest
  // sql/params/scopeKeys/dep-tables are read inside the effects via refs.
  const explicitTables = options?.tables;
  const scopeKeys = options?.scopeKeys;
  const key = `${sql} ${paramsKey(params)}`;
  const scopeKeysKey = scopeKeys?.join(',') ?? '';

  const sqlRef = useRef(sql);
  sqlRef.current = sql;
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const scopeKeysRef = useRef(scopeKeys);
  scopeKeysRef.current = scopeKeys;
  const depTablesRef = useRef<Set<string>>(new Set());
  depTablesRef.current =
    explicitTables !== undefined ? new Set(explicitTables) : inferTables(sql);

  // A monotonically-incremented tick forces a re-run on `refresh()` and on
  // a matching invalidation, without re-subscribing.
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);

  // `key` (sql+params) and `tick` are re-run TRIGGERS read via refs, not
  // values used in the body — biome cannot see that, so the dep list is
  // pinned deliberately.
  // biome-ignore lint/correctness/useExhaustiveDependencies: key/tick are intentional re-run triggers
  useEffect(() => {
    if (!enabled) {
      setIsLoading(false);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    Promise.resolve(client.query(sqlRef.current, paramsRef.current))
      .then((result) => {
        if (cancelled) return;
        setRows(result as readonly unknown[] as readonly Row[]);
        setError(undefined);
        setIsLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, key, enabled, tick]);

  // Re-subscribe when the client/enabled/query identity changes; `key` and
  // `scopeKeysKey` re-key the subscription without being read in the body.
  // biome-ignore lint/correctness/useExhaustiveDependencies: key/scopeKeysKey re-key the subscription intentionally
  useEffect(() => {
    if (!enabled) return;
    const unsubscribe = client.onInvalidate((event) => {
      if (eventMatches(event, depTablesRef.current, scopeKeysRef.current)) {
        setTick((n) => n + 1);
      }
    });
    return unsubscribe;
  }, [client, enabled, key, scopeKeysKey]);

  return { rows, isLoading, error, refresh };
}
