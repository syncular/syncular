/**
 * @syncular/core - Runtime telemetry abstraction
 *
 * Provides vendor-neutral logging, tracing, and metrics interfaces so
 * Syncular libraries can emit telemetry without coupling to a specific SDK.
 */

/**
 * Supported log levels.
 */
export type SyncTelemetryLevel =
  | 'trace'
  | 'debug'
  | 'info'
  | 'warn'
  | 'error'
  | 'fatal';

/**
 * Primitive attribute value used by traces and metrics.
 */
export type SyncTelemetryAttributeValue = string | number | boolean;

/**
 * Attribute bag used by traces and metrics.
 */
export type SyncTelemetryAttributes = Record<
  string,
  SyncTelemetryAttributeValue
>;

/**
 * Structured sync log event.
 */
export interface SyncTelemetryEvent {
  event: string;
  level?: SyncTelemetryLevel;
  userId?: string;
  durationMs?: number;
  rowCount?: number;
  resetRequired?: boolean;
  error?: string;
  [key: string]: unknown;
}

/**
 * Span creation options.
 */
export interface SyncSpanOptions {
  name: string;
  op?: string;
  attributes?: SyncTelemetryAttributes;
}

/**
 * Span API exposed to Syncular internals.
 */
export interface SyncSpan {
  setAttribute(name: string, value: SyncTelemetryAttributeValue): void;
  setAttributes(attributes: SyncTelemetryAttributes): void;
  setStatus(status: 'ok' | 'error'): void;
}

/**
 * Tracing interface.
 */
export interface SyncTracer {
  startSpan<T>(options: SyncSpanOptions, callback: (span: SyncSpan) => T): T;
}

/**
 * Metric record options.
 */
export interface SyncMetricOptions {
  attributes?: SyncTelemetryAttributes;
  unit?: string;
}

/**
 * Metrics interface.
 */
export interface SyncMetrics {
  count(name: string, value?: number, options?: SyncMetricOptions): void;
  gauge(name: string, value: number, options?: SyncMetricOptions): void;
  distribution(name: string, value: number, options?: SyncMetricOptions): void;
}

/**
 * Unified telemetry interface.
 */
export interface SyncTelemetry {
  log(event: SyncTelemetryEvent): void;
  tracer: SyncTracer;
  metrics: SyncMetrics;
  captureException(error: unknown, context?: Record<string, unknown>): void;
}

const noopSpan: SyncSpan = {
  setAttribute() {},
  setAttributes() {},
  setStatus() {},
};

const noopTracer: SyncTracer = {
  startSpan(_options, callback) {
    return callback(noopSpan);
  },
};

const noopMetrics: SyncMetrics = {
  count() {},
  gauge() {},
  distribution() {},
};

function createConsoleLogger(): (event: SyncTelemetryEvent) => void {
  const isNode =
    typeof globalThis !== 'undefined' &&
    typeof globalThis.setImmediate === 'function';

  const defer = isNode
    ? (fn: () => void) => globalThis.setImmediate(fn)
    : (fn: () => void) => setTimeout(fn, 0);

  return (event: SyncTelemetryEvent) => {
    defer(() => {
      const level = event.level ?? (event.error ? 'error' : 'info');
      const payload = {
        timestamp: new Date().toISOString(),
        level,
        ...event,
      };
      console.log(JSON.stringify(payload));
    });
  };
}

/**
 * Create console-backed default telemetry (logs only; no-op tracing/metrics).
 */
export function createDefaultSyncTelemetry(): SyncTelemetry {
  const logger = createConsoleLogger();
  return {
    log(event) {
      logger(event);
    },
    tracer: noopTracer,
    metrics: noopMetrics,
    captureException(error, context) {
      const message =
        error instanceof Error
          ? error.message
          : `Unknown error: ${String(error)}`;
      logger({
        event: 'sync.exception',
        level: 'error',
        error: message,
        ...(context ?? {}),
      });
    },
  };
}

let activeSyncTelemetry: SyncTelemetry = createDefaultSyncTelemetry();

/**
 * Get currently configured telemetry backend.
 */
export function getSyncTelemetry(): SyncTelemetry {
  return activeSyncTelemetry;
}

/**
 * Replace active telemetry backend.
 */
export function configureSyncTelemetry(telemetry: SyncTelemetry): void {
  activeSyncTelemetry = telemetry;
}

/**
 * Reset telemetry backend to default console implementation.
 */
export function resetSyncTelemetry(): void {
  activeSyncTelemetry = createDefaultSyncTelemetry();
}

/**
 * Capture an exception through the active telemetry backend.
 */
export function captureSyncException(
  error: unknown,
  context?: Record<string, unknown>
): void {
  activeSyncTelemetry.captureException(error, context);
}

/**
 * Start a span through the active telemetry backend.
 */
export function startSyncSpan<T>(
  options: SyncSpanOptions,
  callback: (span: SyncSpan) => T
): T {
  return activeSyncTelemetry.tracer.startSpan(options, callback);
}

/**
 * Record a counter metric through the active telemetry backend.
 */
export function countSyncMetric(
  name: string,
  value?: number,
  options?: SyncMetricOptions
): void {
  activeSyncTelemetry.metrics.count(name, value, options);
}

/**
 * Record a gauge metric through the active telemetry backend.
 */
export function gaugeSyncMetric(
  name: string,
  value: number,
  options?: SyncMetricOptions
): void {
  activeSyncTelemetry.metrics.gauge(name, value, options);
}

/**
 * Record a distribution metric through the active telemetry backend.
 */
export function distributionSyncMetric(
  name: string,
  value: number,
  options?: SyncMetricOptions
): void {
  activeSyncTelemetry.metrics.distribution(name, value, options);
}
