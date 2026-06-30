export const SYNCULAR_DX_MARKER_CODES = {
  blobAccessDenied: 'blob.forbidden',
  blobNotFound: 'blob.not_found',
  blobSigningFailed: 'blob.signing_failed',
  localVisibilityTimeout: 'sync.local_visibility_timeout',
  realtimeHello: 'realtime.hello',
  realtimePullRequired: 'realtime.pull_required',
  realtimeReconnectScheduled: 'realtime.reconnect_scheduled',
  realtimeSyncWakeup: 'realtime.sync_wakeup',
  scopeRevoked: 'sync.scope_revoked',
  schemaGeneratedOutputStale: 'schema.generated_output_stale',
  syncRateLimited: 'sync.rate_limited',
} as const;

export type SyncularDxMarkerCode =
  (typeof SYNCULAR_DX_MARKER_CODES)[keyof typeof SYNCULAR_DX_MARKER_CODES];

export interface SyncularDiagnosticMarkerEvent {
  code?: string | null;
  details?: Record<string, unknown> | null;
}

export function findDiagnosticMarker<
  TEvent extends SyncularDiagnosticMarkerEvent,
>(
  events: readonly TEvent[],
  code: SyncularDxMarkerCode | string,
  predicate?: (event: TEvent) => boolean
): TEvent | undefined {
  return events.find(
    (event) => event.code === code && (predicate ? predicate(event) : true)
  );
}

export function hasDiagnosticMarker(
  events: readonly SyncularDiagnosticMarkerEvent[],
  code: SyncularDxMarkerCode | string,
  predicate?: (event: SyncularDiagnosticMarkerEvent) => boolean
): boolean {
  return findDiagnosticMarker(events, code, predicate) !== undefined;
}

export function requireDiagnosticMarker<
  TEvent extends SyncularDiagnosticMarkerEvent,
>(
  events: readonly TEvent[],
  code: SyncularDxMarkerCode | string,
  predicate?: (event: TEvent) => boolean
): TEvent {
  const marker = findDiagnosticMarker(events, code, predicate);
  if (!marker) {
    const observed = events
      .map((event) => event.code)
      .filter((candidate): candidate is string => typeof candidate === 'string')
      .join(', ');
    throw new Error(
      `Expected Syncular diagnostic marker "${code}" but observed: ${observed || 'none'}`
    );
  }
  return marker;
}
