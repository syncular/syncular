/**
 * k6 Load Test: WebSocket Realtime Scenario
 *
 * Tests realtime wake-up delivery under concurrent websocket connections.
 * Each VU:
 * 1) performs a pull to register scopes for its realtime clientId
 * 2) opens a websocket connection
 * 3) writes via a second clientId to trigger sync wake-ups
 *
 * Usage:
 *   k6 run tests/load/scripts/websocket.js
 *   k6 run --vus 500 --duration 2m tests/load/scripts/websocket.js
 */

import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import ws from 'k6/ws';
import {
  collectPulledRowIds,
  parseCombinedResponse,
  pull,
  push,
} from '../lib/sync-client.js';
import { taskUpsertOperation, userTasksSubscription, vuUserId } from '../lib/data-generator.js';

// Custom metrics
const wsConnectTime = new Trend('ws_connect_time', true);
const wsMessageLatency = new Trend('ws_message_latency', true);
const wsDataSyncLag = new Trend('ws_data_sync_lag_ms', true);
const wsDataPullLatency = new Trend('ws_data_pull_latency', true);
const wsErrors = new Rate('ws_errors');
const wsDataSyncErrors = new Rate('ws_data_sync_errors');
const wsMessages = new Counter('ws_messages_received');
const wsConnections = new Counter('ws_connections');

const pullStateByVu = new Map();
const smokeMode = __ENV.K6_SMOKE === 'true';
const syncLagSloMs = Number.parseInt(__ENV.SYNC_LAG_SLO_MS || '5000', 10);
const syncVisibilityTimeoutMs = Number.parseInt(
  __ENV.SYNC_VISIBILITY_TIMEOUT_MS || '20000',
  10
);
const wsPullDebounceMs = Number.parseInt(
  __ENV.WS_SYNC_PULL_MIN_INTERVAL_MS || '200',
  10
);

// Test configuration
export const options = {
  // Ramp up WebSocket connections
  stages: smokeMode
    ? [
        { duration: '4s', target: 2 },
        { duration: '2s', target: 0 },
      ]
    : [
        { duration: '20s', target: 100 }, // Warm up
        { duration: '1m', target: 500 }, // Ramp to 500
        { duration: '1m', target: 1000 }, // Ramp to 1000
        { duration: '20s', target: 0 }, // Ramp down
      ],

  // Performance thresholds
  thresholds: {
    ws_connect_time: ['p(95)<1000'], // 95th percentile connection under 1s
    ws_message_latency: ['p(95)<100'], // 95th percentile sync wake-up under 100ms
    ws_data_sync_lag_ms: [`p(95)<${syncLagSloMs}`],
    ws_data_sync_errors: ['rate<0.05'],
    ws_errors: ['rate<0.05'], // Less than 5% error rate
  },
};

function getPullState() {
  const existing = pullStateByVu.get(__VU);
  if (existing) return existing;

  const state = {
    cursor: -1,
    bootstrapState: null,
  };
  pullStateByVu.set(__VU, state);
  return state;
}

function primeRealtimeScopes(userId, clientId) {
  const state = getPullState();
  const res = pull(
    userId,
    [
      userTasksSubscription(userId, {
        id: `ws-sub-${__VU}`,
        cursor: state.cursor,
        bootstrapState: state.bootstrapState,
      }),
    ],
    {
      limitCommits: 100,
      limitSnapshotRows: 1000,
      maxSnapshotPages: 4,
    },
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
    state.cursor = Number.isFinite(sub.nextCursor)
      ? sub.nextCursor
      : state.cursor;
    state.bootstrapState = sub.bootstrapState ?? null;
  }

  return ok;
}

function pullRealtimeChanges(userId, clientId, state) {
  const res = pull(
    userId,
    [
      userTasksSubscription(userId, {
        id: `ws-sub-${__VU}`,
        cursor: state.cursor,
        bootstrapState: state.bootstrapState,
      }),
    ],
    {
      limitCommits: 100,
      limitSnapshotRows: 1000,
      maxSnapshotPages: 4,
    },
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
    state.cursor = Number.isFinite(sub.nextCursor)
      ? sub.nextCursor
      : state.cursor;
    state.bootstrapState = sub.bootstrapState ?? null;
  }

  return { ok, res, sub };
}

function settlePendingWrites(pendingWrites, visibleRowIds, now) {
  let settled = 0;
  let timedOut = 0;

  for (const rowId of visibleRowIds) {
    const startedAt = pendingWrites.get(rowId);
    if (!Number.isFinite(startedAt)) continue;

    const lag = now - startedAt;
    if (lag >= 0) {
      wsDataSyncLag.add(lag);
    }
    settled++;
    pendingWrites.delete(rowId);
  }

  for (const [rowId, startedAt] of pendingWrites.entries()) {
    if (!Number.isFinite(startedAt)) continue;
    if (now - startedAt < syncVisibilityTimeoutMs) continue;

    timedOut++;
    pendingWrites.delete(rowId);
  }

  return { settled, timedOut };
}

// Main test function - runs per VU per iteration
export default function () {
  const userId = vuUserId(__VU, 'ws');
  const wsClientId = `k6-ws-listener-${__VU}`;
  const writerClientId = `k6-ws-writer-${__VU}`;
  const baseUrl = __ENV.BASE_URL || 'http://localhost:3001';
  const wsUrl = baseUrl.replace('http', 'ws');
  const url =
    `${wsUrl}/api/sync/realtime` +
    `?userId=${encodeURIComponent(userId)}` +
    `&clientId=${encodeURIComponent(wsClientId)}`;

  if (!primeRealtimeScopes(userId, wsClientId)) {
    wsErrors.add(true);
    return;
  }

  const connectStart = Date.now();
  let connected = false;
  let syncMessageCount = 0;
  let syncedRows = 0;
  const pendingWrites = new Map();
  let lastPullAt = 0;

  const res = ws.connect(url, {}, (socket) => {
    socket.on('open', () => {
      connected = true;
      wsConnections.add(1);
      wsConnectTime.add(Date.now() - connectStart);

      // Trigger periodic writes from a different clientId so the listener receives wake-ups.
      socket.setInterval(() => {
        const operation = taskUpsertOperation(userId);
        const pushRes = push(userId, [operation], writerClientId);
        const pushBody = parseCombinedResponse(pushRes);
        const pushOk =
          pushRes.status === 200 &&
          pushBody?.ok === true &&
          pushBody?.push?.ok === true;

        if (!pushOk) {
          wsErrors.add(true);
          return;
        }

        pendingWrites.set(operation.row_id, Date.now());
      }, 1000);
    });

    socket.on('message', (data) => {
      let message = null;
      try {
        message = JSON.parse(data);
      } catch {
        return;
      }

      if (message?.event !== 'sync') return;

      const timestamp = message?.data?.timestamp;
      if (Number.isFinite(timestamp)) {
        const latency = Date.now() - timestamp;
        if (latency >= 0 && latency < 60_000) {
          wsMessageLatency.add(latency);
        }
      }

      syncMessageCount++;
      wsMessages.add(1);

      const now = Date.now();
      if (now - lastPullAt < wsPullDebounceMs) return;
      lastPullAt = now;

      const pullResult = pullRealtimeChanges(userId, wsClientId, getPullState());
      wsDataPullLatency.add(pullResult.res.timings.duration);
      if (!pullResult.ok) {
        wsDataSyncErrors.add(true);
        return;
      }

      const visibleRowIds = collectPulledRowIds(pullResult.sub);
      const settleResult = settlePendingWrites(pendingWrites, visibleRowIds, now);
      syncedRows += settleResult.settled;
      wsDataSyncErrors.add(settleResult.timedOut > 0);
    });

    socket.on('error', () => {
      wsErrors.add(true);
    });

    socket.setTimeout(() => {
      socket.close();
    }, smokeMode ? 5_000 : 20_000);
  });

  const finalSettle = settlePendingWrites(pendingWrites, new Set(), Date.now());
  wsDataSyncErrors.add(finalSettle.timedOut > 0);

  const connectedOk = check(res, {
    'WebSocket upgrade accepted': (r) => r && r.status === 101,
    'WebSocket connected': () => connected,
    'received sync wake-up': () => syncMessageCount > 0,
    'listener observed synced rows': () => syncedRows > 0,
  });

  wsErrors.add(!(connectedOk && syncMessageCount > 0));

  // Small delay before next iteration
  sleep(1);
}

// Setup function
export function setup() {
  console.log('Starting WebSocket load test...');
  console.log(`Base URL: ${__ENV.BASE_URL || 'http://localhost:3001'}`);

  return { startTime: Date.now() };
}

// Teardown function
export function teardown(data) {
  const duration = (Date.now() - data.startTime) / 1000;
  console.log(`Test completed in ${duration.toFixed(2)}s`);
}
