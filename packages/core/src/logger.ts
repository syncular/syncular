/**
 * @syncular/core - Structured logging utilities for sync operations
 *
 * Outputs JSON lines for easy parsing by log aggregation tools.
 * Each log event includes a timestamp and event type.
 */

/**
 * Sync log event structure
 */
interface SyncLogEvent {
  /** Event type identifier */
  event: string;
  /** User ID (optional) */
  userId?: string;
  /** Operation duration in milliseconds (optional) */
  durationMs?: number;
  /** Number of rows affected (optional) */
  rowCount?: number;
  /** Whether a full reset was required (optional) */
  resetRequired?: boolean;
  /** Error message if operation failed (optional) */
  error?: string;
  /** Additional arbitrary properties */
  [key: string]: unknown;
}

/**
 * Logger function type - allows custom logging implementations
 */
type SyncLogger = (event: SyncLogEvent) => void;

/**
 * Default logger that outputs JSON lines to console.
 * Non-blocking - defers logging to avoid blocking the event loop.
 *
 * On server (Node.js), uses setImmediate.
 * On client (browser), uses setTimeout(0).
 */
function createDefaultLogger(): SyncLogger {
  // Detect environment
  const isNode =
    typeof globalThis !== 'undefined' &&
    typeof globalThis.setImmediate === 'function';

  const defer = isNode
    ? (fn: () => void) => globalThis.setImmediate(fn)
    : (fn: () => void) => setTimeout(fn, 0);

  return (event: SyncLogEvent) => {
    defer(() => {
      console.log(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          ...event,
        })
      );
    });
  };
}

/**
 * Log a sync event using the default logger.
 * For custom logging, create your own logger with createDefaultLogger pattern.
 */
export const logSyncEvent: SyncLogger = createDefaultLogger();

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

/**
 * Create a scoped logger that automatically adds context to all events.
 *
 * @example
 * const log = createScopedLogger({ userId: 'user123', shape: 'teams' });
 * log({ event: 'pull_start' }); // Includes userId and shape
 */
export function createScopedLogger(
  context: Record<string, unknown>,
  baseLogger: SyncLogger = logSyncEvent
): SyncLogger {
  return (event: SyncLogEvent) => {
    baseLogger({ ...context, ...event });
  };
}
