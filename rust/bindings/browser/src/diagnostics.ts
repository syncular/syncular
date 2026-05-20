import type {
  SyncularV2BootstrapStatus,
  SyncularV2DiagnosticEvent,
  SyncularV2DiagnosticSubscriptionSnapshot,
  SyncularV2SubscriptionSpec,
  SyncularV2SyncAttempt,
  SyncularV2SyncTimings,
} from './types';

export const SYNCULAR_V2_DIAGNOSTIC_RING_LIMIT = 100;
export const SYNCULAR_V2_SYNC_TIMINGS_RING_LIMIT = 20;

export function appendSyncularV2DiagnosticEvent(
  events: SyncularV2DiagnosticEvent[],
  event: SyncularV2DiagnosticEvent
): void {
  events.push(event);
  trimRing(events, SYNCULAR_V2_DIAGNOSTIC_RING_LIMIT);
}

export function appendSyncularV2SyncTimings(
  timings: SyncularV2SyncTimings[],
  timing: SyncularV2SyncTimings
): void {
  timings.push(timing);
  trimRing(timings, SYNCULAR_V2_SYNC_TIMINGS_RING_LIMIT);
}

export function summarizeSyncularV2DiagnosticSubscriptions(
  subscriptions: readonly SyncularV2SubscriptionSpec[],
  bootstrap: SyncularV2BootstrapStatus | undefined
): SyncularV2DiagnosticSubscriptionSnapshot[] {
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

export function createSyncularV2SyncAttempt(): SyncularV2SyncAttempt {
  const traceId = randomHex(16);
  const spanId = randomHex(8);
  return {
    syncAttemptId: traceId,
    traceId,
    spanId,
    traceparent: `00-${traceId}-${spanId}-01`,
  };
}

export function syncularV2SyncAttemptHeaders(
  attempt: SyncularV2SyncAttempt
): Record<string, string> {
  return {
    traceparent: attempt.traceparent,
    'sentry-trace': `${attempt.traceId}-${attempt.spanId}-1`,
    'x-syncular-sync-attempt-id': attempt.syncAttemptId,
  };
}

export function syncularV2DiagnosticAttemptFields(
  attempt: SyncularV2SyncAttempt | undefined
): Pick<SyncularV2DiagnosticEvent, 'syncAttemptId' | 'traceId' | 'spanId'> {
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
