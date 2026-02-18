import type { BrowserSentryInitOptions } from '@syncular/observability-sentry';

declare global {
  var __SYNCULAR_SENTRY_DSN__: string | undefined;
  var __SYNCULAR_SENTRY_ENVIRONMENT__: string | undefined;
  var __SYNCULAR_SENTRY_RELEASE__: string | undefined;
}

const SENTRY_DSN_META = 'syncular-sentry-dsn';
const SENTRY_ENVIRONMENT_META = 'syncular-sentry-environment';
const SENTRY_RELEASE_META = 'syncular-sentry-release';

function cleanValue(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readMeta(name: string): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const value = document
    .querySelector(`meta[name="${name}"]`)
    ?.getAttribute('content');
  return cleanValue(value);
}

function readEnv(name: string): string | undefined {
  if (typeof process === 'undefined') return undefined;
  return cleanValue(process.env[name]);
}

function firstDefined(values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (value) return value;
  }
  return undefined;
}

/**
 * Resolve browser Sentry options from globals, meta tags, or build-time env.
 */
export function resolveConsoleBrowserSentryOptions(): BrowserSentryInitOptions | null {
  const dsn = firstDefined([
    cleanValue(globalThis.__SYNCULAR_SENTRY_DSN__),
    readMeta(SENTRY_DSN_META),
    readEnv('SYNCULAR_SENTRY_DSN'),
  ]);

  if (!dsn) return null;

  const environment = firstDefined([
    cleanValue(globalThis.__SYNCULAR_SENTRY_ENVIRONMENT__),
    readMeta(SENTRY_ENVIRONMENT_META),
    readEnv('SYNCULAR_SENTRY_ENVIRONMENT'),
  ]);
  const release = firstDefined([
    cleanValue(globalThis.__SYNCULAR_SENTRY_RELEASE__),
    readMeta(SENTRY_RELEASE_META),
    readEnv('SYNCULAR_SENTRY_RELEASE'),
  ]);

  return {
    dsn,
    environment,
    release,
    enableLogs: true,
    tracesSampleRate: 0.2,
    tracePropagationTargets: [/^https?:\/\/.*\/api\/.*/],
  };
}
