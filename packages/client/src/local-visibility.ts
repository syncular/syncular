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

export type SyncularLocalVisibilityEvidenceState =
  | 'pending'
  | 'visible'
  | 'timed-out'
  | 'failed';

export type SyncularLocalVisibilityEvidenceTrigger =
  | 'initial'
  | 'rowsChanged'
  | 'bootstrapChanged'
  | 'lifecycleChanged'
  | 'timeout'
  | 'abort'
  | 'queryError';

export interface SyncularLocalVisibilityEvidence {
  state: SyncularLocalVisibilityEvidenceState;
  at?: number;
  message?: string;
  details?: Record<string, unknown>;
}

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
  /**
   * Receives redacted evidence when the wait becomes visible, times out, or
   * fails. Pass the latest value to `commandTimeline({ localVisibility })` to
   * link an authoritative command to the local read-model visibility point.
   */
  onEvidence?: (evidence: SyncularLocalVisibilityEvidence) => void;
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
    let queuedTrigger: SyncularLocalVisibilityEvidenceTrigger | undefined;
    let queuedDetails: Record<string, unknown> | undefined;
    let evaluationCount = 0;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const unsubscribers: Array<() => void> = [];
    const tableList = tables ? Array.from(tables).sort() : undefined;

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

    const emitEvidence = (
      state: SyncularLocalVisibilityEvidenceState,
      trigger: SyncularLocalVisibilityEvidenceTrigger,
      message: string,
      details: Record<string, unknown> = {}
    ) => {
      options.onEvidence?.({
        state,
        at: Date.now(),
        message,
        details: {
          trigger,
          evaluationCount,
          ...(tableList ? { tables: tableList } : {}),
          ...details,
        },
      });
    };

    const evaluate = (
      trigger: SyncularLocalVisibilityEvidenceTrigger,
      triggerDetails?: Record<string, unknown>
    ) => {
      if (settled) return;
      if (evaluating) {
        queued = true;
        queuedTrigger = trigger;
        queuedDetails = triggerDetails;
        return;
      }
      evaluating = true;
      evaluationCount += 1;
      void executeLocalVisibilityQuery(client.db, query)
        .then((result) => {
          if (predicate(result)) {
            emitEvidence(
              'visible',
              trigger,
              'Syncular local visibility was observed.',
              triggerDetails
            );
            finish({ ok: true, value: result });
          }
        })
        .catch((error) => {
          emitEvidence(
            'failed',
            'queryError',
            'Syncular local visibility query failed.',
            {
              ...triggerDetails,
              attemptedTrigger: trigger,
              ...errorEvidence(error),
            }
          );
          finish({ ok: false, error });
        })
        .finally(() => {
          evaluating = false;
          if (!settled && queued) {
            queued = false;
            const nextTrigger = queuedTrigger ?? 'initial';
            const nextDetails = queuedDetails;
            queuedTrigger = undefined;
            queuedDetails = undefined;
            evaluate(nextTrigger, nextDetails);
          }
        });
    };

    const onRowsChanged = (event: SyncularRowsChangedEvent) => {
      if (tables && !event.changedTables.some((table) => tables.has(table))) {
        return;
      }
      evaluate('rowsChanged', {
        changedTables: [...event.changedTables].sort(),
        source: event.source,
      });
    };
    const onBootstrapChanged = () => evaluate('bootstrapChanged');
    const onLifecycleChanged = () => evaluate('lifecycleChanged');
    const abort = () => {
      emitEvidence(
        'failed',
        'abort',
        'Syncular local visibility wait was aborted.'
      );
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
    unsubscribers.push(client.on('bootstrapChanged', onBootstrapChanged));
    unsubscribers.push(client.on('lifecycleChanged', onLifecycleChanged));

    const timeoutMs =
      options.timeoutMs === undefined
        ? DEFAULT_LOCAL_VISIBILITY_TIMEOUT_MS
        : options.timeoutMs;
    if (timeoutMs !== false && timeoutMs >= 0) {
      timeout = setTimeout(() => {
        const definition =
          SYNCULAR_ERROR_DEFINITIONS['sync.local_visibility_timeout'];
        emitEvidence(
          'timed-out',
          'timeout',
          'Timed out waiting for Syncular local visibility.',
          { timeoutMs }
        );
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

    evaluate('initial');
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

function errorEvidence(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      ...errorCodeEvidence(error),
    };
  }
  return { errorName: typeof error };
}

function errorCodeEvidence(error: Error): Record<string, unknown> {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? { errorCode: code } : {};
}
