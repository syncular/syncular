import * as Sentry from '@sentry/cloudflare';
import {
  configureSyncTelemetry,
  type SyncMetricOptions,
  type SyncTelemetry,
  type SyncTelemetryAttributeValue,
} from '@syncular/core';
import { createSentrySyncTelemetry } from './shared';

function toCountMetricOptions(
  options?: SyncMetricOptions
): Parameters<typeof Sentry.metrics.count>[2] | undefined {
  if (!options?.attributes) return undefined;
  return { attributes: options.attributes };
}

function toValueMetricOptions(
  options?: SyncMetricOptions
): Parameters<typeof Sentry.metrics.gauge>[2] | undefined {
  if (!options) return undefined;
  const hasAttributes = Boolean(options.attributes);
  const hasUnit = Boolean(options.unit);
  if (!hasAttributes && !hasUnit) return undefined;
  return {
    attributes: options.attributes,
    unit: options.unit,
  };
}

export type CloudflareSentryCaptureMessageLevel = Parameters<
  typeof Sentry.captureMessage
>[1];

interface CloudflareSentryCaptureMessageOptions {
  level?: CloudflareSentryCaptureMessageLevel;
  tags?: Record<string, string>;
}

type CloudflareSentryLogLevel =
  | 'trace'
  | 'debug'
  | 'info'
  | 'warn'
  | 'error'
  | 'fatal';

interface CloudflareSentryLogOptions {
  level?: CloudflareSentryLogLevel;
  attributes?: Record<string, SyncTelemetryAttributeValue>;
}

function resolveCloudflareLogMethod(
  level: CloudflareSentryLogLevel
):
  | ((
      message: string,
      attributes?: Record<string, SyncTelemetryAttributeValue>
    ) => void)
  | null {
  switch (level) {
    case 'trace':
      return Sentry.logger.trace ?? Sentry.logger.debug ?? Sentry.logger.info;
    case 'debug':
      return Sentry.logger.debug ?? Sentry.logger.info;
    case 'info':
      return Sentry.logger.info;
    case 'warn':
      return Sentry.logger.warn ?? Sentry.logger.info;
    case 'error':
      return Sentry.logger.error ?? Sentry.logger.warn ?? Sentry.logger.info;
    case 'fatal':
      return (
        Sentry.logger.fatal ??
        Sentry.logger.error ??
        Sentry.logger.warn ??
        Sentry.logger.info
      );
    default:
      return Sentry.logger.info;
  }
}

/**
 * Re-export Cloudflare Sentry worker wrapper.
 */
export const withCloudflareSentry = Sentry.withSentry;
export const instrumentCloudflareDurableObjectWithSentry =
  Sentry.instrumentDurableObjectWithSentry;

export interface CloudflareSentryTraceHeaders {
  sentryTrace?: string;
  baggage?: string;
}

/**
 * Read current trace headers from the active Cloudflare Sentry scope.
 */
export function getCloudflareSentryTraceHeaders(
  traceData: ReturnType<typeof Sentry.getTraceData> = Sentry.getTraceData()
): CloudflareSentryTraceHeaders {
  const sentryTrace = traceData['sentry-trace']?.trim();
  const baggage = traceData.baggage?.trim();
  return {
    ...(sentryTrace ? { sentryTrace } : {}),
    ...(baggage ? { baggage } : {}),
  };
}

/**
 * Clone a request and attach active Cloudflare trace headers when available.
 */
export function attachCloudflareSentryTraceHeaders(
  request: Request,
  traceHeaders: CloudflareSentryTraceHeaders = getCloudflareSentryTraceHeaders()
): Request {
  if (!traceHeaders.sentryTrace && !traceHeaders.baggage) {
    return request;
  }

  const headers = new Headers(request.headers);
  if (traceHeaders.sentryTrace) {
    headers.set('sentry-trace', traceHeaders.sentryTrace);
  }
  if (traceHeaders.baggage) {
    headers.set('baggage', traceHeaders.baggage);
  }

  return new Request(request, { headers });
}

/**
 * Create a Syncular telemetry backend wired to `@sentry/cloudflare`.
 */
export function createCloudflareSentryTelemetry(): SyncTelemetry {
  return createSentrySyncTelemetry({
    logger: Sentry.logger,
    startSpan(options, callback) {
      return Sentry.startSpan(options, (span) =>
        callback({
          setAttribute(name, value) {
            span.setAttribute(name, value);
          },
          setAttributes(attributes) {
            span.setAttributes(attributes);
          },
          setStatus(status) {
            span.setStatus({
              code: status === 'ok' ? 1 : 2,
            });
          },
        })
      );
    },
    metrics: {
      count(name, value, options) {
        const metricOptions = toCountMetricOptions(options);
        if (metricOptions) {
          Sentry.metrics.count(name, value, metricOptions);
          return;
        }
        Sentry.metrics.count(name, value);
      },
      gauge(name, value, options) {
        const metricOptions = toValueMetricOptions(options);
        if (metricOptions) {
          Sentry.metrics.gauge(name, value, metricOptions);
          return;
        }
        Sentry.metrics.gauge(name, value);
      },
      distribution(name, value, options) {
        const metricOptions = toValueMetricOptions(options);
        if (metricOptions) {
          Sentry.metrics.distribution(name, value, metricOptions);
          return;
        }
        Sentry.metrics.distribution(name, value);
      },
    },
    captureException(error) {
      Sentry.captureException(error);
    },
  });
}

/**
 * Configure Syncular core telemetry to use the Cloudflare Sentry adapter.
 */
export function configureCloudflareSentryTelemetry(): SyncTelemetry {
  const telemetry = createCloudflareSentryTelemetry();
  configureSyncTelemetry(telemetry);
  return telemetry;
}

/**
 * Capture a worker message in Sentry with optional tags.
 */
export function captureCloudflareSentryMessage(
  message: string,
  options?: CloudflareSentryCaptureMessageOptions
): void {
  if (!options?.tags || Object.keys(options.tags).length === 0) {
    Sentry.captureMessage(message, options?.level);
    return;
  }

  Sentry.withScope((scope) => {
    for (const [name, value] of Object.entries(options.tags ?? {})) {
      scope.setTag(name, value);
    }
    Sentry.captureMessage(message, options?.level);
  });
}

/**
 * Emit a Cloudflare Sentry log entry.
 */
export function logCloudflareSentryMessage(
  message: string,
  options?: CloudflareSentryLogOptions
): void {
  const level = options?.level ?? 'info';
  const logMethod = resolveCloudflareLogMethod(level);
  if (!logMethod) return;
  if (!options?.attributes || Object.keys(options.attributes).length === 0) {
    logMethod(message);
    return;
  }
  logMethod(message, options.attributes);
}
