import { describe, expect, test } from 'bun:test';
import { logSyncEvent } from '../logger';
import {
  captureSyncException,
  configureSyncTelemetry,
  countSyncMetric,
  distributionSyncMetric,
  gaugeSyncMetric,
  getSyncTelemetry,
  resetSyncTelemetry,
  type SyncMetricOptions,
  type SyncSpan,
  type SyncSpanOptions,
  type SyncTelemetry,
  type SyncTelemetryEvent,
  startSyncSpan,
} from '../telemetry';

interface CapturedCountMetric {
  name: string;
  value: number | undefined;
  options: SyncMetricOptions | undefined;
}

interface CapturedValueMetric {
  name: string;
  value: number;
  options: SyncMetricOptions | undefined;
}

function createTestTelemetry(calls: {
  logs: SyncTelemetryEvent[];
  countMetrics: CapturedCountMetric[];
  gaugeMetrics: CapturedValueMetric[];
  distributionMetrics: CapturedValueMetric[];
  spans: SyncSpanOptions[];
  exceptions: Array<{
    error: unknown;
    context: Record<string, unknown> | undefined;
  }>;
}): SyncTelemetry {
  return {
    log(event) {
      calls.logs.push(event);
    },
    tracer: {
      startSpan(options, callback) {
        calls.spans.push(options);
        const span: SyncSpan = {
          setAttribute() {},
          setAttributes() {},
          setStatus() {},
        };
        return callback(span);
      },
    },
    metrics: {
      count(name, value, options) {
        calls.countMetrics.push({ name, value, options });
      },
      gauge(name, value, options) {
        calls.gaugeMetrics.push({ name, value, options });
      },
      distribution(name, value, options) {
        calls.distributionMetrics.push({ name, value, options });
      },
    },
    captureException(error, context) {
      calls.exceptions.push({ error, context });
    },
  };
}

describe('sync telemetry configuration', () => {
  test('routes logger, metrics, spans, and exceptions to configured backend', () => {
    const calls = {
      logs: [] as SyncTelemetryEvent[],
      countMetrics: [] as CapturedCountMetric[],
      gaugeMetrics: [] as CapturedValueMetric[],
      distributionMetrics: [] as CapturedValueMetric[],
      spans: [] as SyncSpanOptions[],
      exceptions: [] as Array<{
        error: unknown;
        context: Record<string, unknown> | undefined;
      }>,
    };
    const telemetry = createTestTelemetry(calls);
    const previous = getSyncTelemetry();

    try {
      configureSyncTelemetry(telemetry);

      logSyncEvent({ event: 'sync.test.log', rowCount: 3 });

      const spanResult = startSyncSpan(
        {
          name: 'sync.test.span',
          op: 'sync.test',
          attributes: { transport: 'ws' },
        },
        () => 'done'
      );

      countSyncMetric('sync.test.count', 2, {
        attributes: { source: 'unit-test' },
      });
      gaugeSyncMetric('sync.test.gauge', 7, { unit: 'millisecond' });
      distributionSyncMetric('sync.test.dist', 13);
      captureSyncException(new Error('boom'), {
        operation: 'unit-test',
      });

      expect(spanResult).toBe('done');
      expect(calls.logs).toEqual([{ event: 'sync.test.log', rowCount: 3 }]);
      expect(calls.spans).toEqual([
        {
          name: 'sync.test.span',
          op: 'sync.test',
          attributes: { transport: 'ws' },
        },
      ]);
      expect(calls.countMetrics).toEqual([
        {
          name: 'sync.test.count',
          value: 2,
          options: { attributes: { source: 'unit-test' } },
        },
      ]);
      expect(calls.gaugeMetrics).toEqual([
        {
          name: 'sync.test.gauge',
          value: 7,
          options: { unit: 'millisecond' },
        },
      ]);
      expect(calls.distributionMetrics).toEqual([
        {
          name: 'sync.test.dist',
          value: 13,
          options: undefined,
        },
      ]);
      expect(calls.exceptions).toHaveLength(1);
      expect(calls.exceptions[0]?.context).toEqual({ operation: 'unit-test' });
    } finally {
      configureSyncTelemetry(previous);
    }
  });

  test('resetSyncTelemetry swaps out custom telemetry backend', () => {
    const calls = {
      logs: [] as SyncTelemetryEvent[],
      countMetrics: [] as CapturedCountMetric[],
      gaugeMetrics: [] as CapturedValueMetric[],
      distributionMetrics: [] as CapturedValueMetric[],
      spans: [] as SyncSpanOptions[],
      exceptions: [] as Array<{
        error: unknown;
        context: Record<string, unknown> | undefined;
      }>,
    };
    const telemetry = createTestTelemetry(calls);

    configureSyncTelemetry(telemetry);
    resetSyncTelemetry();
    logSyncEvent({ event: 'sync.default.logger' });

    expect(calls.logs).toHaveLength(0);
  });
});
