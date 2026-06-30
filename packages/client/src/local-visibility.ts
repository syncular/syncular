import { SYNCULAR_ERROR_DEFINITIONS } from '@syncular/core';
import type { Kysely } from 'kysely';
import { SyncularClientError } from './errors';
import type {
  SyncularClientEventSink,
  SyncularClientEventType,
  SyncularRowsChangedEvent,
} from './types';

const DEFAULT_LOCAL_VISIBILITY_TIMEOUT_MS = 10_000;

type ExecutableQuery<TResult> = {
  execute(): Promise<TResult>;
};

export type SyncularLocalVisibilityQuery<DB, TResult> = (
  db: Kysely<DB>
) => ExecutableQuery<TResult> | Promise<TResult> | TResult;

export interface SyncularLocalVisibilityClient<DB> {
  db: Kysely<DB>;
  on<T extends SyncularClientEventType>(
    event: T,
    listener: SyncularClientEventSink<T>
  ): () => void;
}

export interface SyncularLocalVisibilityOptions<TResult> {
  /**
   * Tables that can make the query visible. RowsChanged events for unrelated
   * tables are ignored. Bootstrap/lifecycle events still re-check the query.
   */
  tables?: readonly string[];
  /**
   * Defaults to array length > 0, boolean true, or any non-null result.
   */
  predicate?: (result: TResult) => boolean;
  /**
   * Defaults to 10 seconds. Pass `false` to wait without a local timeout.
   */
  timeoutMs?: number | false;
  signal?: AbortSignal;
}

export async function waitForSyncularLocalVisibility<DB, TResult>(
  client: SyncularLocalVisibilityClient<DB>,
  query: SyncularLocalVisibilityQuery<DB, TResult>,
  options: SyncularLocalVisibilityOptions<TResult> = {}
): Promise<TResult> {
  const predicate = options.predicate ?? defaultVisibilityPredicate<TResult>;
  const tables = options.tables == null ? null : new Set(options.tables);

  return await new Promise<TResult>((resolve, reject) => {
    let settled = false;
    let evaluating = false;
    let queued = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const unsubscribers: Array<() => void> = [];

    const finish = (
      result: { ok: true; value: TResult } | { ok: false; error: unknown }
    ) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
      options.signal?.removeEventListener('abort', abort);
      if (result.ok) {
        resolve(result.value);
      } else {
        reject(result.error);
      }
    };

    const evaluate = () => {
      if (settled) return;
      if (evaluating) {
        queued = true;
        return;
      }
      evaluating = true;
      void executeLocalVisibilityQuery(client.db, query)
        .then((result) => {
          if (predicate(result)) {
            finish({ ok: true, value: result });
          }
        })
        .catch((error) => finish({ ok: false, error }))
        .finally(() => {
          evaluating = false;
          if (!settled && queued) {
            queued = false;
            evaluate();
          }
        });
    };

    const onRowsChanged = (event: SyncularRowsChangedEvent) => {
      if (tables && !event.changedTables.some((table) => tables.has(table))) {
        return;
      }
      evaluate();
    };
    const onSignal = () => evaluate();
    const abort = () => {
      finish({
        ok: false,
        error: new DOMException(
          'Syncular local visibility wait was aborted.',
          'AbortError'
        ),
      });
    };

    if (options.signal?.aborted) {
      abort();
      return;
    }

    options.signal?.addEventListener('abort', abort, { once: true });
    unsubscribers.push(client.on('rowsChanged', onRowsChanged));
    unsubscribers.push(client.on('bootstrapChanged', onSignal));
    unsubscribers.push(client.on('lifecycleChanged', onSignal));

    const timeoutMs =
      options.timeoutMs === undefined
        ? DEFAULT_LOCAL_VISIBILITY_TIMEOUT_MS
        : options.timeoutMs;
    if (timeoutMs !== false && timeoutMs >= 0) {
      timeout = setTimeout(() => {
        const definition =
          SYNCULAR_ERROR_DEFINITIONS['sync.local_visibility_timeout'];
        finish({
          ok: false,
          error: new SyncularClientError({
            code: 'sync.local_visibility_timeout',
            category: definition.category,
            retryable: definition.retryable,
            recommendedAction: definition.recommendedAction,
            message:
              'Timed out waiting for Syncular local visibility. The runtime did not observe matching local rows before the timeout.',
            details: {
              timeoutMs,
              ...(tables ? { tables: Array.from(tables).sort() } : {}),
            },
          }),
        });
      }, timeoutMs);
    }

    evaluate();
  });
}

async function executeLocalVisibilityQuery<DB, TResult>(
  db: Kysely<DB>,
  query: SyncularLocalVisibilityQuery<DB, TResult>
): Promise<TResult> {
  const result = await Promise.resolve(query(db));
  return isExecutableQuery<TResult>(result) ? await result.execute() : result;
}

function defaultVisibilityPredicate<TResult>(result: TResult): boolean {
  if (Array.isArray(result)) return result.length > 0;
  if (typeof result === 'boolean') return result;
  return result != null;
}

function isExecutableQuery<TResult>(
  value: unknown
): value is ExecutableQuery<TResult> {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { execute?: unknown }).execute === 'function'
  );
}
