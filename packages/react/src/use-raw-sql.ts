/**
 * `useRawSql` — a live local SQL query with fine-grained invalidation
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

import type { InvalidationEvent, SqlRow, SqlValue } from '@syncular/client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { inferTables } from './infer-tables';
import { FrameScheduler, type HashedRows, reconcileRows } from './query-churn';
import { useSyncClient } from './use-client';

export interface UseRawSqlOptions {
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

export interface UseRawSqlResult<Row> {
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

export function useRawSql<Row = SqlRow>(
  sql: string,
  params?: readonly SqlValue[],
  options?: UseRawSqlOptions,
): UseRawSqlResult<Row> {
  const client = useSyncClient();
  const enabled = options?.enabled ?? true;

  const [rows, setRows] = useState<readonly Row[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(enabled);
  const [error, setError] = useState<Error | undefined>(undefined);

  // The previous result plus its per-row content hashes, so a re-run can (a)
  // skip setRows entirely when nothing changed (zero re-render) and (b) reuse
  // unchanged row objects so memoized row components keep identity. Held in a
  // ref — it is not render state; it's the reconcile baseline.
  const prevRef = useRef<HashedRows<Row> | undefined>(undefined);

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

  // The single re-run routine, held in a ref so the scheduler and the
  // subscription can call the LATEST closure without re-subscribing. It queries
  // once, reconciles the fresh result against the previous, and only sets state
  // when something actually changed (levers 1a/1b). A `cancelled` guard (reset
  // per effect commit) makes a re-query from a stale mount a no-op.
  const runRef = useRef<() => Promise<void>>();
  const cancelledRef = useRef(false);

  // `key`/`tick` are re-run triggers read via refs, not values used in the
  // body — the pinned dep list re-runs the query on identity change.
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);

  // One scheduler per hook instance, created lazily and re-run through the ref
  // so a burst of invalidations coalesces to one query per frame (lever 2).
  const schedulerRef = useRef<FrameScheduler>();
  if (schedulerRef.current === undefined) {
    schedulerRef.current = new FrameScheduler(() => runRef.current?.());
  }

  // Latest committed loading/error, tracked in refs so the run can set state
  // ONLY on a real transition. React does not reliably bail on a no-op
  // `setState(sameValue)` when other setters fire in the same batch (it can
  // still commit a render), so lever 1a — zero re-render on unchanged data —
  // requires us to guard every setter, not just setRows.
  const isLoadingValueRef = useRef(isLoading);
  isLoadingValueRef.current = isLoading;
  const errorValueRef = useRef(error);
  errorValueRef.current = error;

  const setLoadingIfChanged = (value: boolean) => {
    if (isLoadingValueRef.current !== value) {
      isLoadingValueRef.current = value;
      setIsLoading(value);
    }
  };
  const setErrorIfChanged = (value: Error | undefined) => {
    if (errorValueRef.current !== value) {
      errorValueRef.current = value;
      setError(value);
    }
  };

  // Keep the run closure current every render (it closes over client via ref).
  runRef.current = async () => {
    if (cancelledRef.current) return;
    try {
      const result = await client.query(sqlRef.current, paramsRef.current);
      if (cancelledRef.current) return;
      const fresh = result as readonly unknown[] as readonly Row[];
      const { next } = reconcileRows(prevRef.current, fresh);
      if (next !== undefined) {
        prevRef.current = next;
        setRows(next.rows);
      }
      // next === undefined → whole result unchanged: NO setRows (zero re-render).
      setErrorIfChanged(undefined);
      setLoadingIfChanged(false);
    } catch (err: unknown) {
      if (cancelledRef.current) return;
      setErrorIfChanged(err instanceof Error ? err : new Error(String(err)));
      setLoadingIfChanged(false);
    }
  };

  // Mount / query-identity / refresh: run immediately (not frame-coalesced —
  // the caller changed the query, so it must reflect at once). Invalidations go
  // through the scheduler instead.
  // biome-ignore lint/correctness/useExhaustiveDependencies: key/tick are intentional re-run triggers
  useEffect(() => {
    cancelledRef.current = false;
    if (!enabled) {
      setLoadingIfChanged(false);
      return;
    }
    // A query-identity change invalidates the reconcile baseline (a different
    // query's rows are not comparable to this one's), so reset it.
    prevRef.current = undefined;
    setLoadingIfChanged(true);
    void runRef.current?.();
    return () => {
      cancelledRef.current = true;
    };
  }, [client, key, enabled, tick]);

  // Subscribe once per client/enabled/query identity; a matching event asks the
  // scheduler for a run (coalesced). `key`/`scopeKeysKey` re-key the sub.
  // biome-ignore lint/correctness/useExhaustiveDependencies: key/scopeKeysKey re-key the subscription intentionally
  useEffect(() => {
    if (!enabled) return;
    const scheduler = schedulerRef.current;
    const unsubscribe = client.onInvalidate((event) => {
      if (eventMatches(event, depTablesRef.current, scopeKeysRef.current)) {
        scheduler?.schedule();
      }
    });
    return unsubscribe;
  }, [client, enabled, key, scopeKeysKey]);

  // Dispose the scheduler when the hook unmounts (drop any pending frame).
  useEffect(() => {
    const scheduler = schedulerRef.current;
    return () => scheduler?.dispose();
  }, []);

  return { rows, isLoading, error, refresh };
}
