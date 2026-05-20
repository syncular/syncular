import type {
  SyncularV2BootstrapStatus,
  SyncularV2DiagnosticEvent,
  SyncularV2DiagnosticSubscriptionSnapshot,
  SyncularV2SubscriptionSpec,
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
