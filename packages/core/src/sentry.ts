import type {
  SyncMetricOptions,
  SyncMetrics,
  SyncSpan,
  SyncSpanOptions,
  SyncTelemetry,
  SyncTelemetryAttributes,
  SyncTelemetryAttributeValue,
  SyncTelemetryEvent,
  SyncTelemetryLevel,
  SyncTracer,
} from '@syncular/core';

interface SentryLoggerAdapter {
  trace?(message: string, attributes?: Record<string, unknown>): void;
  debug?(message: string, attributes?: Record<string, unknown>): void;
  info?(message: string, attributes?: Record<string, unknown>): void;
  warn?(message: string, attributes?: Record<string, unknown>): void;
  error?(message: string, attributes?: Record<string, unknown>): void;
  fatal?(message: string, attributes?: Record<string, unknown>): void;
}

interface SentrySpanAdapter {
  setAttribute?(name: string, value: SyncTelemetryAttributeValue): void;
  setAttributes?(attributes: SyncTelemetryAttributes): void;
  setStatus?(status: 'ok' | 'error' | string): void;
}

interface SentryMetricsAdapter {
  count?(name: string, value: number, options?: SyncMetricOptions): void;
  gauge?(name: string, value: number, options?: SyncMetricOptions): void;
  distribution?(name: string, value: number, options?: SyncMetricOptions): void;
}

export interface SentryTelemetryAdapter {
  logger?: SentryLoggerAdapter;
  startSpan?<T>(
    options: SyncSpanOptions,
    callback: (span: SentrySpanAdapter) => T
  ): T;
  metrics?: SentryMetricsAdapter;
  captureException?(error: unknown): void;
}

const noopSpan: SyncSpan = {
  setAttribute() {},
  setAttributes() {},
  setStatus() {},
};

function resolveLogLevel(event: SyncTelemetryEvent): SyncTelemetryLevel {
  if (event.level) return event.level;
  return event.error ? 'error' : 'info';
}

function resolveLogMethod(
  logger: SentryLoggerAdapter | undefined,
  level: SyncTelemetryLevel
): ((message: string, attributes?: Record<string, unknown>) => void) | null {
  if (!logger) return null;
  switch (level) {
    case 'trace':
      return logger.trace ?? logger.debug ?? logger.info ?? null;
    case 'debug':
      return logger.debug ?? logger.info ?? null;
    case 'info':
      return logger.info ?? null;
    case 'warn':
      return logger.warn ?? logger.info ?? null;
    case 'error':
      return logger.error ?? logger.warn ?? logger.info ?? null;
    case 'fatal':
      return logger.fatal ?? logger.error ?? logger.warn ?? logger.info ?? null;
    default:
      return logger.info ?? null;
  }
}

function toSpan(span: SentrySpanAdapter): SyncSpan {
  return {
    setAttribute(name, value) {
      span.setAttribute?.(name, value);
    },
    setAttributes(attributes) {
      if (span.setAttributes) {
        span.setAttributes(attributes);
        return;
      }

      for (const [key, value] of Object.entries(attributes)) {
        span.setAttribute?.(key, value);
      }
    },
    setStatus(status) {
      span.setStatus?.(status);
    },
  };
}

function toLogAttributeValue(
  value: unknown
): SyncTelemetryAttributeValue | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'boolean') return value;
  if (typeof value === 'bigint') {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) return asNumber;
    return value.toString();
  }
  if (value instanceof Date) return value.toISOString();
  if (value === null || value === undefined) return undefined;

  if (Array.isArray(value) || typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  return String(value);
}

function sanitizeLogAttributes(
  attributes: Record<string, unknown>
): Record<string, SyncTelemetryAttributeValue> | null {
  const sanitized: Record<string, SyncTelemetryAttributeValue> = {};
  for (const [name, value] of Object.entries(attributes)) {
    const normalized = toLogAttributeValue(value);
    if (normalized !== undefined) {
      sanitized[name] = normalized;
    }
  }

  return Object.keys(sanitized).length > 0 ? sanitized : null;
}

function createTracer(adapter: SentryTelemetryAdapter): SyncTracer {
  return {
    startSpan<T>(options: SyncSpanOptions, callback: (span: SyncSpan) => T): T {
      if (!adapter.startSpan) return callback(noopSpan);
      return adapter.startSpan(options, (span) => callback(toSpan(span)));
    },
  };
}

function createMetrics(adapter: SentryTelemetryAdapter): SyncMetrics {
  return {
    count(name, value, options) {
      adapter.metrics?.count?.(name, value ?? 1, options);
    },
    gauge(name, value, options) {
      adapter.metrics?.gauge?.(name, value, options);
    },
    distribution(name, value, options) {
      adapter.metrics?.distribution?.(name, value, options);
    },
  };
}

/**
 * Create a Syncular telemetry adapter backed by Sentry primitives.
 */
export function createSentrySyncTelemetry(
  adapter: SentryTelemetryAdapter
): SyncTelemetry {
  return {
    log(event) {
      const level = resolveLogLevel(event);
      const { event: message, ...attributes } = event;
      const logMethod = resolveLogMethod(adapter.logger, level);
      if (!logMethod) return;
      const sanitizedAttributes = sanitizeLogAttributes(attributes);
      if (!sanitizedAttributes) {
        logMethod(message);
        return;
      }
      logMethod(message, sanitizedAttributes);
    },
    tracer: createTracer(adapter),
    metrics: createMetrics(adapter),
    captureException(error, context) {
      adapter.captureException?.(error);
      if (!context) return;
      const logMethod =
        resolveLogMethod(adapter.logger, 'error') ??
        resolveLogMethod(adapter.logger, 'info');
      if (!logMethod) return;
      const sanitizedContext = sanitizeLogAttributes(context);
      if (!sanitizedContext) {
        logMethod('sync.exception.context');
        return;
      }
      logMethod('sync.exception.context', sanitizedContext);
    },
  };
}
