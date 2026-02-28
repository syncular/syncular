/**
 * k6 Load Test: Mixed Workload Scenario
 *
 * Simulates production-ish usage patterns with:
 * - readers: frequent pull-only sync
 * - writers: push+pull cycles
 * - websocket listeners: realtime wake-ups triggered by separate writer clientIds
 */

import { check, sleep } from 'k6';
import exec from 'k6/execution';
import { Counter, Rate, Trend } from 'k6/metrics';
import ws from 'k6/ws';
import {
  collectPulledRowIds,
  healthCheck,
  parseCombinedResponse,
  pull,
  push,
} from '../lib/sync-client.js';
import {
  taskUpsertOperation,
  userTasksSubscription,
  vuUserId,
} from '../lib/data-generator.js';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3001';
const smokeMode = __ENV.K6_SMOKE === 'true';
const soakMode = __ENV.K6_SOAK === 'true';
const mixedSoakDuration = __ENV.MIXED_SOAK_DURATION || '20m';
const mixedSoakReaders = Number.parseInt(__ENV.MIXED_SOAK_READERS || '120', 10);
const mixedSoakWriters = Number.parseInt(__ENV.MIXED_SOAK_WRITERS || '30', 10);
const mixedSoakWebsockets = Number.parseInt(
  __ENV.MIXED_SOAK_WEBSOCKETS || '160',
  10
);

// Custom metrics
const readerLatency = new Trend('reader_latency', true);
const writerPushLatency = new Trend('writer_push_latency', true);
const writerPullLatency = new Trend('writer_pull_latency', true);
const readerErrors = new Rate('reader_errors');
const writerErrors = new Rate('writer_errors');
const wsErrors = new Rate('ws_errors');
const wsConnections = new Counter('ws_connections');
const wsMessages = new Counter('ws_messages');
const operationsPerSecond = new Rate('operations_per_second');
const writerSyncLag = new Trend('writer_sync_lag_ms', true);
const writerSyncConvergenceErrors = new Rate('writer_sync_convergence_errors');
const writerPendingSyncWrites = new Trend('writer_pending_sync_writes', false);

const readerStateByVu = new Map();
const writerStateByVu = new Map();
const wsStateByVu = new Map();
const syncLagSloMs = Number.parseInt(__ENV.SYNC_LAG_SLO_MS || '5000', 10);
const syncVisibilityTimeoutMs = Number.parseInt(
  __ENV.SYNC_VISIBILITY_TIMEOUT_MS || '20000',
  10
);
const maxPendingWrites = Number.parseInt(__ENV.SYNC_MAX_PENDING_WRITES || '50', 10);

function getState(map) {
  const key = `${exec.scenario.name}-${__VU}`;
  const existing = map.get(key);
  if (existing) return existing;

  const state = { cursor: -1, bootstrapState: null, pendingWrites: new Map() };
  map.set(key, state);
  return state;
}

function settleWriterPending(state, visibleRowIds, now) {
  let timedOut = 0;

  for (const rowId of visibleRowIds) {
    const startedAt = state.pendingWrites.get(rowId);
    if (!Number.isFinite(startedAt)) continue;

    const lag = now - startedAt;
    if (lag >= 0) {
      writerSyncLag.add(lag);
    }
    state.pendingWrites.delete(rowId);
  }

  for (const [rowId, startedAt] of state.pendingWrites.entries()) {
    if (!Number.isFinite(startedAt)) continue;
    if (now - startedAt < syncVisibilityTimeoutMs) continue;

    timedOut++;
    state.pendingWrites.delete(rowId);
  }

  writerPendingSyncWrites.add(state.pendingWrites.size);
  return timedOut;
}

function runPull(userId, clientId, state, subscriptionId, options) {
  const res = pull(
    userId,
    [
      userTasksSubscription(userId, {
        id: subscriptionId,
        cursor: state.cursor,
        bootstrapState: state.bootstrapState,
      }),
    ],
    options,
    clientId
  );

  const body = parseCombinedResponse(res);
  const sub = body?.pull?.subscriptions?.[0];
  const ok =
    res.status === 200 &&
    body?.ok === true &&
    body?.pull?.ok === true &&
    sub != null;

  if (ok) {
    state.cursor = Number.isFinite(sub.nextCursor) ? sub.nextCursor : state.cursor;
    state.bootstrapState = sub.bootstrapState ?? null;
  }

  return { ok, res, sub };
}

// Test configuration
export const options = {
  scenarios: smokeMode
    ? {
        readers: {
          executor: 'constant-vus',
          exec: 'reader',
          vus: 1,
          duration: '10s',
        },
        writers: {
          executor: 'constant-vus',
          exec: 'writer',
          vus: 1,
          duration: '10s',
        },
        websockets: {
          executor: 'constant-vus',
          exec: 'websocketClient',
          vus: 1,
          duration: '10s',
        },
      }
    : soakMode
      ? {
          readers: {
            executor: 'constant-vus',
            exec: 'reader',
            vus: mixedSoakReaders,
            duration: mixedSoakDuration,
          },
          writers: {
            executor: 'constant-vus',
            exec: 'writer',
            vus: mixedSoakWriters,
            duration: mixedSoakDuration,
          },
          websockets: {
            executor: 'constant-vus',
            exec: 'websocketClient',
            vus: mixedSoakWebsockets,
            duration: mixedSoakDuration,
          },
        }
      : {
          // 80% readers - poll for changes periodically
          readers: {
            executor: 'ramping-vus',
            exec: 'reader',
            startVUs: 0,
            stages: [
              { duration: '30s', target: 80 },
              { duration: '4m', target: 800 },
              { duration: '30s', target: 0 },
            ],
          },

          // 20% writers - actively pushing changes
          writers: {
            executor: 'ramping-vus',
            exec: 'writer',
            startVUs: 0,
            stages: [
              { duration: '30s', target: 20 },
              { duration: '4m', target: 200 },
              { duration: '30s', target: 0 },
            ],
          },

          // WebSocket listeners for realtime wake-ups
          websockets: {
            executor: 'ramping-vus',
            exec: 'websocketClient',
            startVUs: 0,
            stages: [
              { duration: '30s', target: 100 },
              { duration: '4m', target: 1000 },
              { duration: '30s', target: 0 },
            ],
          },
        },

  thresholds: {
    reader_latency: ['p(95)<300'],
    writer_push_latency: ['p(95)<500'],
    writer_pull_latency: ['p(95)<300'],
    writer_sync_lag_ms: [`p(95)<${syncLagSloMs}`],
    reader_errors: ['rate<0.01'],
    writer_errors: ['rate<0.01'],
    writer_sync_convergence_errors: ['rate<0.01'],
    ws_errors: ['rate<0.05'],
    http_req_duration: ['p(99)<2000'],
  },
};

/**
 * Reader function - pulls changes periodically
 */
export function reader() {
  const userId = vuUserId(__VU, 'reader');
  const clientId = `k6-reader-${__VU}`;
  const state = getState(readerStateByVu);

  const pullResult = runPull(userId, clientId, state, `reader-sub-${__VU}`, {
    limitCommits: 100,
    limitSnapshotRows: 1000,
    maxSnapshotPages: 4,
  });

  readerLatency.add(pullResult.res.timings.duration);
  readerErrors.add(!pullResult.ok);
  operationsPerSecond.add(pullResult.ok);

  check(pullResult.res, {
    'reader pull ok': () => pullResult.ok,
  });

  // Readers poll less frequently (1-3 seconds)
  sleep(1 + Math.random() * 2);
}

/**
 * Writer function - pushes changes and then pulls
 */
export function writer() {
  const userId = vuUserId(__VU, 'writer');
  const clientId = `k6-writer-${__VU}`;
  const state = getState(writerStateByVu);

  // Push a new task
  const operation = taskUpsertOperation(userId);
  const pushRes = push(userId, [operation], clientId);
  const pushBody = parseCombinedResponse(pushRes);
  const pushOk =
    pushRes.status === 200 &&
    pushBody?.ok === true &&
    pushBody?.push?.ok === true;

  writerPushLatency.add(pushRes.timings.duration);
  writerErrors.add(!pushOk);
  operationsPerSecond.add(pushOk);

  check(pushRes, {
    'writer push ok': () => pushOk,
  });
  if (pushOk) {
    state.pendingWrites.set(operation.row_id, Date.now());
  }

  // Small delay between push and pull
  sleep(0.3);

  // Pull to confirm changes
  const pullResult = runPull(userId, clientId, state, `writer-sub-${__VU}`, {
    limitCommits: 100,
    limitSnapshotRows: 1000,
    maxSnapshotPages: 4,
  });

  writerPullLatency.add(pullResult.res.timings.duration);
  writerErrors.add(!pullResult.ok);
  operationsPerSecond.add(pullResult.ok);

  const visibleRowIds = pullResult.ok
    ? collectPulledRowIds(pullResult.sub)
    : new Set();
  const timedOutWrites = pullResult.ok
    ? settleWriterPending(state, visibleRowIds, Date.now())
    : 0;
  const pendingWritesOverLimit = state.pendingWrites.size > maxPendingWrites;
  const convergenceFailed = timedOutWrites > 0 || pendingWritesOverLimit;
  writerSyncConvergenceErrors.add(convergenceFailed);

  check(pullResult.res, {
    'writer pull ok': () => pullResult.ok,
    'writer sync convergence maintained': () => !convergenceFailed,
  });

  // Writers are more active (0.5-2 seconds between writes)
  sleep(0.5 + Math.random() * 1.5);
}

/**
 * WebSocket client - maintains connection and expects sync wake-ups.
 */
export function websocketClient() {
  const userId = vuUserId(__VU, 'ws');
  const wsClientId = `k6-ws-listener-${__VU}`;
  const writerClientId = `k6-ws-writer-${__VU}`;
  const state = getState(wsStateByVu);

  const prime = runPull(userId, wsClientId, state, `ws-sub-${__VU}`, {
    limitCommits: 100,
    limitSnapshotRows: 1000,
    maxSnapshotPages: 4,
  });
  if (!prime.ok) {
    wsErrors.add(true);
    return;
  }

  const wsUrl = BASE_URL.replace('http', 'ws');
  const url =
    `${wsUrl}/api/sync/realtime` +
    `?userId=${encodeURIComponent(userId)}` +
    `&clientId=${encodeURIComponent(wsClientId)}`;

  let syncMessages = 0;

  const res = ws.connect(url, {}, (socket) => {
    socket.on('open', () => {
      wsConnections.add(1);

      socket.setInterval(() => {
        const op = taskUpsertOperation(userId);
        push(userId, [op], writerClientId);
      }, 2000);
    });

    socket.on('message', (data) => {
      let parsed = null;
      try {
        parsed = JSON.parse(data);
      } catch {
        return;
      }

      if (parsed?.event !== 'sync') return;
      syncMessages++;
      wsMessages.add(1);
    });

    socket.on('error', () => {
      wsErrors.add(true);
    });

    socket.setTimeout(() => {
      socket.close();
    }, smokeMode ? 8_000 : 60_000);
  });

  const wsOk = check(res, {
    'ws connected': (r) => r && r.status === 101,
    'ws received sync wake-up': () => syncMessages > 0,
  });

  wsErrors.add(!(wsOk && syncMessages > 0));

  // WebSocket VUs run once and hold connection
  sleep(smokeMode ? 8 : 60);
}

// Default function (for simple runs)
export default function () {
  reader();
}

export function setup() {
  console.log('Starting mixed workload load test...');
  console.log(`Base URL: ${BASE_URL}`);
  console.log('Scenario: readers + writers + websocket wake-ups');

  const res = healthCheck();
  if (res.status !== 200) {
    throw new Error(`Server not available: ${res.status}`);
  }

  return { startTime: Date.now() };
}

export function teardown(data) {
  const duration = (Date.now() - data.startTime) / 1000;
  console.log(`Test completed in ${duration.toFixed(2)}s`);
}

export function handleSummary(data) {
  const summary = {
    totalRequests: data.metrics.http_reqs?.values?.count || 0,
    avgLatency: data.metrics.http_req_duration?.values?.avg || 0,
    p95Latency: data.metrics.http_req_duration?.values['p(95)'] || 0,
    errorRate: (data.metrics.http_req_failed?.values?.rate || 0) * 100,
    wsConnections: data.metrics.ws_connections?.values?.count || 0,
    wsMessages: data.metrics.ws_messages?.values?.count || 0,
  };

  console.log('\n=== Mixed Workload Summary ===');
  console.log(`Total HTTP Requests: ${summary.totalRequests}`);
  console.log(`Average Latency: ${summary.avgLatency.toFixed(2)}ms`);
  console.log(`P95 Latency: ${summary.p95Latency.toFixed(2)}ms`);
  console.log(`Error Rate: ${summary.errorRate.toFixed(2)}%`);
  console.log(`WebSocket Connections: ${summary.wsConnections}`);
  console.log(`WebSocket Messages: ${summary.wsMessages}`);

  return {
    stdout: JSON.stringify(summary, null, 2),
  };
}
