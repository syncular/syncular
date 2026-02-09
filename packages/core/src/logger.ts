/**
 * @syncular/core - Structured logging utilities for sync operations
 *
 * Uses the active telemetry backend configured via `configureSyncTelemetry()`.
 */

import { getSyncTelemetry, type SyncTelemetryEvent } from './telemetry';

/**
 * Sync log event structure.
 */
export type SyncLogEvent = SyncTelemetryEvent;

/**
 * Logger function type.
 */
export type SyncLogger = (event: SyncLogEvent) => void;

/**
 * Log a sync event using the currently configured telemetry backend.
 */
export const logSyncEvent: SyncLogger = (event) => {
  getSyncTelemetry().log(event);
};

/**
 * Create a timer for measuring operation duration.
 * Returns the elapsed time in milliseconds when called.
 *
 * @example
 * const elapsed = createSyncTimer();
 * await doSomeWork();
 * logSyncEvent({ event: 'work_complete', durationMs: elapsed() });
 */
export function createSyncTimer(): () => number {
  const start = performance.now();
  return () => Math.round(performance.now() - start);
}
