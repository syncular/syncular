import { describe, expect, test } from 'bun:test';
import type { SyncSpanOptions } from '@syncular/core';
import {
  createSentrySyncTelemetry,
  type SentryTelemetryAdapter,
} from './shared';

describe('createSentrySyncTelemetry', () => {
  test('routes logs, spans, metrics, and exceptions', () => {
    const logs: Array<{
      level: string;
      message: string;
      attributes?: Record<string, unknown>;
    }> = [];
    const spans: SyncSpanOptions[] = [];
    const metricCalls: Array<{ type: string; name: string; value: number }> =
      [];
    const exceptions: unknown[] = [];

    const adapter: SentryTelemetryAdapter = {
      logger: {
        info(message, attributes) {
          logs.push({ level: 'info', message, attributes });
        },
        error(message, attributes) {
          logs.push({ level: 'error', message, attributes });
        },
      },
      startSpan(options, callback) {
        spans.push(options);
        return callback({
          setAttribute() {},
          setAttributes() {},
          setStatus() {},
        });
      },
      metrics: {
        count(name, value) {
          metricCalls.push({ type: 'count', name, value });
        },
        gauge(name, value) {
          metricCalls.push({ type: 'gauge', name, value });
        },
        distribution(name, value) {
          metricCalls.push({ type: 'distribution', name, value });
        },
      },
      captureException(error) {
        exceptions.push(error);
      },
    };

    const telemetry = createSentrySyncTelemetry(adapter);

    telemetry.log({ event: 'sync.ok', rowCount: 2 });
    telemetry.log({ event: 'sync.fail', error: 'boom' });

    const spanValue = telemetry.tracer.startSpan(
      {
        name: 'sync.span',
        op: 'sync',
      },
      (span) => {
        span.setAttribute('transport', 'ws');
        span.setStatus('ok');
        return 123;
      }
    );

    telemetry.metrics.count('sync.count');
    telemetry.metrics.gauge('sync.gauge', 7);
    telemetry.metrics.distribution('sync.dist', 42);
    telemetry.captureException(new Error('crash'), { requestId: 'r1' });

    expect(spanValue).toBe(123);
    expect(logs[0]).toEqual({
      level: 'info',
      message: 'sync.ok',
      attributes: { rowCount: 2 },
    });
    expect(logs[1]).toEqual({
      level: 'error',
      message: 'sync.fail',
      attributes: { error: 'boom' },
    });
    expect(spans).toEqual([
      {
        name: 'sync.span',
        op: 'sync',
      },
    ]);
    expect(metricCalls).toEqual([
      { type: 'count', name: 'sync.count', value: 1 },
      { type: 'gauge', name: 'sync.gauge', value: 7 },
      { type: 'distribution', name: 'sync.dist', value: 42 },
    ]);
    expect(exceptions).toHaveLength(1);
    expect(logs.at(-1)).toEqual({
      level: 'error',
      message: 'sync.exception.context',
      attributes: { requestId: 'r1' },
    });
  });

  test('sanitizes non-primitive log attributes', () => {
    const logs: Array<{
      level: string;
      message: string;
      attributes?: Record<string, unknown>;
    }> = [];

    const telemetry = createSentrySyncTelemetry({
      logger: {
        info(message, attributes) {
          logs.push({ level: 'info', message, attributes });
        },
      },
    });

    telemetry.log({
      event: 'sync.attributes',
      id: 'abc',
      nested: { ok: true },
      values: [1, 2, 3],
      enabled: true,
      count: 3,
      ignored: undefined,
      nonFinite: Number.POSITIVE_INFINITY,
    });

    expect(logs).toEqual([
      {
        level: 'info',
        message: 'sync.attributes',
        attributes: {
          id: 'abc',
          nested: '{"ok":true}',
          values: '[1,2,3]',
          enabled: true,
          count: 3,
        },
      },
    ]);
  });
});
