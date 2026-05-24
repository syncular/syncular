import type {
  SyncularBootstrapStatus,
  SyncularDiagnosticEvent,
  SyncularDiagnosticSubscriptionSnapshot,
  SyncularSubscriptionSpec,
  SyncularSyncAttempt,
  SyncularSyncTimings,
} from './types';

export const SYNCULAR_DIAGNOSTIC_RING_LIMIT = 100;
export const SYNCULAR_SYNC_TIMINGS_RING_LIMIT = 20;

export function appendSyncularDiagnosticEvent(
  events: SyncularDiagnosticEvent[],
  event: SyncularDiagnosticEvent
): void {
  events.push(event);
  trimRing(events, SYNCULAR_DIAGNOSTIC_RING_LIMIT);
}

export function appendSyncularSyncTimings(
  timings: SyncularSyncTimings[],
  timing: SyncularSyncTimings
): void {
  timings.push(timing);
  trimRing(timings, SYNCULAR_SYNC_TIMINGS_RING_LIMIT);
}

export function summarizeSyncularDiagnosticSubscriptions(
  subscriptions: readonly SyncularSubscriptionSpec[],
  bootstrap: SyncularBootstrapStatus | undefined
): SyncularDiagnosticSubscriptionSnapshot[] {
  const bootstrapById = new Map(
    (bootstrap?.subscriptions ?? []).map((entry) => [entry.id, entry])
  );
  return subscriptions.map((subscription) => {
    const bootstrapped = bootstrapById.get(subscription.id);
    return {
      id: subscription.id,
      table: subscription.table,
      scopeKeys: Object.keys(subscription.scopes).sort(),
      scopeValueCount: countRedactedValues(subscription.scopes),
      paramsKeys: Object.keys(subscription.params ?? {}).sort(),
      paramsValueCount: countRedactedValues(subscription.params ?? {}),
      status: bootstrapped?.status ?? null,
      ready: bootstrapped?.ready ?? false,
      phase: bootstrapped?.phase ?? 'pending',
      progressPercent: bootstrapped?.progressPercent ?? 0,
      cursor: bootstrapped?.cursor ?? null,
      bootstrapPhase:
        bootstrapped?.bootstrapPhase ?? subscription.bootstrapPhase ?? 0,
      bootstrapState: bootstrapped?.bootstrapState ?? null,
    };
  });
}

export function createSyncularSyncAttempt(): SyncularSyncAttempt {
  const traceId = randomHex(16);
  const spanId = randomHex(8);
  return {
    syncAttemptId: traceId,
    traceId,
    spanId,
    traceparent: `00-${traceId}-${spanId}-01`,
  };
}

export function syncularSyncAttemptHeaders(
  attempt: SyncularSyncAttempt
): Record<string, string> {
  return {
    traceparent: attempt.traceparent,
    'sentry-trace': `${attempt.traceId}-${attempt.spanId}-1`,
    'x-syncular-sync-attempt-id': attempt.syncAttemptId,
  };
}

export function syncularDiagnosticAttemptFields(
  attempt: SyncularSyncAttempt | undefined
): Pick<SyncularDiagnosticEvent, 'syncAttemptId' | 'traceId' | 'spanId'> {
  return attempt
    ? {
        syncAttemptId: attempt.syncAttemptId,
        traceId: attempt.traceId,
        spanId: attempt.spanId,
      }
    : {};
}

function countRedactedValues(values: Record<string, unknown>): number {
  let count = 0;
  for (const value of Object.values(values)) {
    count += Array.isArray(value) ? value.length : 1;
  }
  return count;
}

function trimRing<T>(items: T[], limit: number): void {
  if (items.length <= limit) return;
  items.splice(0, items.length - limit);
}

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  const cryptoSource = globalThis.crypto;
  if (cryptoSource?.getRandomValues) {
    cryptoSource.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    ''
  );
}
