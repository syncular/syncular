export type K6ThresholdResult = boolean | { ok?: boolean };

export type K6Metric = {
  thresholds?: Record<string, K6ThresholdResult>;
  [stat: string]: unknown;
};

export type K6Summary = {
  metrics?: Record<string, K6Metric>;
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function metricValue(
  summary: K6Summary,
  metric: string,
  stat: string
): number | null {
  const value = summary.metrics?.[metric]?.[stat];
  return isFiniteNumber(value) ? value : null;
}

export function metricCount(summary: K6Summary, metric: string): number | null {
  return metricValue(summary, metric, 'count');
}

export function metricRate(summary: K6Summary, metric: string): number | null {
  return (
    metricValue(summary, metric, 'rate') ??
    metricValue(summary, metric, 'value')
  );
}

function thresholdFailed(result: K6ThresholdResult): boolean {
  if (typeof result === 'boolean') {
    return result;
  }

  return result.ok === false;
}

export function findFailedThresholds(summary: K6Summary): string[] {
  const failures: string[] = [];

  for (const [metricName, metric] of Object.entries(summary.metrics ?? {})) {
    for (const [thresholdName, result] of Object.entries(
      metric.thresholds ?? {}
    )) {
      if (thresholdFailed(result)) {
        failures.push(`${metricName}:${thresholdName}`);
      }
    }
  }

  return failures;
}

function requireMetricValue(args: {
  summary: K6Summary;
  metric: string;
  stat: string;
  label: string;
}): string | null {
  const { summary, metric, stat, label } = args;
  return metricValue(summary, metric, stat) == null
    ? `${label} metric missing`
    : null;
}

function requireMetricCount(args: {
  summary: K6Summary;
  metric: string;
  label: string;
}): string | null {
  const { summary, metric, label } = args;
  const count = metricCount(summary, metric);
  return count != null && count > 0 ? null : `${label} count must be > 0`;
}

function requireMetricRateAtMost(args: {
  summary: K6Summary;
  metric: string;
  label: string;
  max: number;
}): string | null {
  const { summary, metric, label, max } = args;
  const rate = metricRate(summary, metric);
  if (rate == null) {
    return `${label} metric missing`;
  }
  return rate <= max ? null : `${label} rate ${rate} exceeded ${max}`;
}

function compactFailures(failures: Array<string | null>): string[] {
  return failures.filter((value): value is string => value != null);
}

export function evaluateScenarioInvariants(
  scenarioId: string,
  summary: K6Summary
): string[] {
  const baseFailures = compactFailures([
    requireMetricCount({
      summary,
      metric: 'http_reqs',
      label: 'HTTP requests',
    }),
  ]);

  switch (scenarioId) {
    case 'push-pull':
      return baseFailures.concat(
        compactFailures([
          requireMetricValue({
            summary,
            metric: 'sync_lag_ms',
            stat: 'p(95)',
            label: 'sync lag p95',
          }),
          requireMetricRateAtMost({
            summary,
            metric: 'sync_convergence_errors',
            label: 'sync convergence errors',
            max: 0,
          }),
        ])
      );

    case 'reconnect-storm':
      return baseFailures.concat(
        compactFailures([
          requireMetricCount({
            summary,
            metric: 'reconnects',
            label: 'reconnect attempts',
          }),
          requireMetricValue({
            summary,
            metric: 'reconnect_sync_lag_ms',
            stat: 'p(95)',
            label: 'reconnect sync lag p95',
          }),
          requireMetricRateAtMost({
            summary,
            metric: 'reconnect_errors',
            label: 'reconnect errors',
            max: 0,
          }),
        ])
      );

    case 'bootstrap-storm':
      return baseFailures.concat(
        compactFailures([
          requireMetricCount({
            summary,
            metric: 'bootstrap_storm_pages',
            label: 'bootstrap pages',
          }),
          requireMetricCount({
            summary,
            metric: 'bootstrap_storm_rows',
            label: 'bootstrap rows',
          }),
          requireMetricRateAtMost({
            summary,
            metric: 'bootstrap_storm_errors',
            label: 'bootstrap storm errors',
            max: 0,
          }),
        ])
      );

    case 'maintenance-churn':
      return baseFailures.concat(
        compactFailures([
          requireMetricValue({
            summary,
            metric: 'maintenance_prune_latency',
            stat: 'p(95)',
            label: 'maintenance prune latency p95',
          }),
          requireMetricValue({
            summary,
            metric: 'maintenance_compact_latency',
            stat: 'p(95)',
            label: 'maintenance compact latency p95',
          }),
          requireMetricRateAtMost({
            summary,
            metric: 'maintenance_operation_errors',
            label: 'maintenance operation errors',
            max: 0,
          }),
        ])
      );

    case 'mixed-workload':
      return baseFailures.concat(
        compactFailures([
          requireMetricCount({
            summary,
            metric: 'ws_connections',
            label: 'WebSocket connections',
          }),
          requireMetricCount({
            summary,
            metric: 'ws_messages',
            label: 'WebSocket sync messages',
          }),
          requireMetricValue({
            summary,
            metric: 'writer_sync_lag_ms',
            stat: 'p(95)',
            label: 'writer sync lag p95',
          }),
          requireMetricRateAtMost({
            summary,
            metric: 'writer_sync_convergence_errors',
            label: 'writer sync convergence errors',
            max: 0,
          }),
        ])
      );

    default:
      return baseFailures;
  }
}
