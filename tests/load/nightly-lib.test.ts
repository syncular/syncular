import { describe, expect, it } from 'bun:test';
import {
  evaluateScenarioInvariants,
  findFailedThresholds,
  type K6Summary,
} from './nightly-lib';

describe('findFailedThresholds', () => {
  it('treats boolean false threshold results as passing', () => {
    const summary: K6Summary = {
      metrics: {
        sync_lag_ms: {
          'p(95)': 42,
          thresholds: {
            'p(95)<5000': false,
          },
        },
      },
    };

    expect(findFailedThresholds(summary)).toEqual([]);
  });

  it('treats boolean true threshold results as failures', () => {
    const summary: K6Summary = {
      metrics: {
        sync_lag_ms: {
          'p(95)': 42,
          thresholds: {
            'p(95)<1': true,
          },
        },
      },
    };

    expect(findFailedThresholds(summary)).toEqual(['sync_lag_ms:p(95)<1']);
  });

  it('treats object thresholds with ok false as failures', () => {
    const summary: K6Summary = {
      metrics: {
        reconnect_errors: {
          value: 0.2,
          thresholds: {
            'rate<0.05': {
              ok: false,
            },
          },
        },
      },
    };

    expect(findFailedThresholds(summary)).toEqual([
      'reconnect_errors:rate<0.05',
    ]);
  });
});

describe('evaluateScenarioInvariants', () => {
  it('accepts a healthy mixed-workload summary', () => {
    const summary: K6Summary = {
      metrics: {
        http_reqs: { count: 24 },
        ws_connections: { count: 3 },
        ws_messages: { count: 9 },
        writer_sync_lag_ms: { 'p(95)': 220 },
        writer_sync_convergence_errors: { value: 0 },
      },
    };

    expect(evaluateScenarioInvariants('mixed-workload', summary)).toEqual([]);
  });

  it('flags missing websocket activity and convergence drift', () => {
    const summary: K6Summary = {
      metrics: {
        http_reqs: { count: 12 },
        ws_connections: { count: 0 },
        ws_messages: { count: 0 },
        writer_sync_lag_ms: { 'p(95)': 220 },
        writer_sync_convergence_errors: { value: 0.5 },
      },
    };

    expect(evaluateScenarioInvariants('mixed-workload', summary)).toEqual([
      'WebSocket connections count must be > 0',
      'WebSocket sync messages count must be > 0',
      'writer sync convergence errors rate 0.5 exceeded 0',
    ]);
  });
});
