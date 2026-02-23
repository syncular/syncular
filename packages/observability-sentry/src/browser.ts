import * as Sentry from '@sentry/react';
import {
  configureSyncTelemetry,
  type SyncMetricOptions,
  type SyncTelemetry,
  type SyncTelemetryAttributeValue,
} from '@syncular/core';
import { createSentrySyncTelemetry } from './shared';

export type BrowserSentryInitOptions = Parameters<typeof Sentry.init>[0];
export type BrowserSentryCaptureMessageLevel = Parameters<
  typeof Sentry.captureMessage
>[1];

interface BrowserSentryCaptureMessageOptions {
  level?: BrowserSentryCaptureMessageLevel;
  tags?: Record<string, string>;
}

type BrowserSentryLogLevel =
  | 'trace'
  | 'debug'
  | 'info'
  | 'warn'
  | 'error'
  | 'fatal';

interface BrowserSentryLogOptions {
  level?: BrowserSentryLogLevel;
  attributes?: Record<string, SyncTelemetryAttributeValue>;
}

function resolveBrowserLogMethod(
  level: BrowserSentryLogLevel
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

/**
 * Create a Syncular telemetry backend wired to `@sentry/react`.
 */
export function createBrowserSentryTelemetry(): SyncTelemetry {
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
 * Configure Syncular core telemetry to use the browser Sentry adapter.
 */
export function configureBrowserSentryTelemetry(): SyncTelemetry {
  const telemetry = createBrowserSentryTelemetry();
  configureSyncTelemetry(telemetry);
  return telemetry;
}

/**
 * Initialize browser Sentry and configure Syncular telemetry.
 */
export function initAndConfigureBrowserSentry(
  options: BrowserSentryInitOptions
): SyncTelemetry {
  const configuredOptions = ensureBrowserTracingIntegration(options);
  Sentry.init(configuredOptions);
  return configureBrowserSentryTelemetry();
}

function ensureBrowserTracingIntegration(
  options: BrowserSentryInitOptions
): BrowserSentryInitOptions {
  const integrations = options.integrations;
  if (typeof integrations === 'function') return options;

  const configuredIntegrations = integrations ?? [];
  const hasBrowserTracing = configuredIntegrations.some(
    (integration) => integration.name === 'BrowserTracing'
  );
  if (hasBrowserTracing) return options;

  return {
    ...options,
    integrations: [
      Sentry.browserTracingIntegration(),
      ...configuredIntegrations,
    ],
  };
}

/**
 * Capture a browser message in Sentry with optional tags.
 */
export function captureBrowserSentryMessage(
  message: string,
  options?: BrowserSentryCaptureMessageOptions
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
 * Emit a browser Sentry log entry.
 */
export function logBrowserSentryMessage(
  message: string,
  options?: BrowserSentryLogOptions
): void {
  const level = options?.level ?? 'info';
  const logMethod = resolveBrowserLogMethod(level);
  if (!logMethod) return;
  if (!options?.attributes || Object.keys(options.attributes).length === 0) {
    logMethod(message);
    return;
  }
  logMethod(message, options.attributes);
}
