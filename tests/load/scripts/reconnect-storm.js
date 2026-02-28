/**
 * k6 Load Test: Reconnect Storm
 *
 * Repeatedly connects/disconnects realtime sessions while writes continue,
 * then validates catch-up pull semantics and cursor progression.
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
import {
  taskUpsertOperation,
  userTasksSubscription,
  vuUserId,
} from '../lib/data-generator.js';

const reconnectConnectTime = new Trend('reconnect_connect_time', true);
const reconnectPullLatency = new Trend('reconnect_pull_latency', true);
const reconnectSyncLag = new Trend('reconnect_sync_lag_ms', true);
const reconnectErrors = new Rate('reconnect_errors');
const reconnectWakeups = new Counter('reconnect_wakeups');
const reconnects = new Counter('reconnects');

const pullStateByVu = new Map();
const smokeMode = __ENV.K6_SMOKE === 'true';
const syncVisibilityTimeoutMs = Number.parseInt(
  __ENV.SYNC_VISIBILITY_TIMEOUT_MS || '20000',
  10
);

function getState() {
  const existing = pullStateByVu.get(__VU);
  if (existing) return existing;

  const state = {
    cursor: -1,
    bootstrapState: null,
    lastCursor: -1,
    pendingWrites: new Map(),
  };
  pullStateByVu.set(__VU, state);
  return state;
}

function pullCatchup(userId, clientId, state) {
  const res = pull(
    userId,
    [
      userTasksSubscription(userId, {
        id: `reconnect-sub-${__VU}`,
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
    state.lastCursor = state.cursor;
    state.cursor = Number.isFinite(sub.nextCursor) ? sub.nextCursor : state.cursor;
    state.bootstrapState = sub.bootstrapState ?? null;
  }

  return { ok, res, sub };
}

function settlePendingWrites(state, visibleRowIds, now) {
  let timedOut = 0;

  for (const rowId of visibleRowIds) {
    const startedAt = state.pendingWrites.get(rowId);
    if (!Number.isFinite(startedAt)) continue;

    const lag = now - startedAt;
    if (lag >= 0) {
      reconnectSyncLag.add(lag);
    }
    state.pendingWrites.delete(rowId);
  }

  for (const [rowId, startedAt] of state.pendingWrites.entries()) {
    if (!Number.isFinite(startedAt)) continue;
    if (now - startedAt < syncVisibilityTimeoutMs) continue;

    timedOut++;
    state.pendingWrites.delete(rowId);
  }

  return timedOut;
}

export const options = {
  scenarios: smokeMode
    ? {
        reconnect_storm: {
          executor: 'constant-vus',
          vus: 2,
          duration: '12s',
        },
      }
    : {
        reconnect_storm: {
          executor: 'ramping-vus',
          startVUs: 0,
          stages: [
            { duration: '30s', target: 100 },
            { duration: '2m', target: 300 },
            { duration: '30s', target: 0 },
          ],
        },
      },
  thresholds: {
    reconnect_connect_time: ['p(95)<1500'],
    reconnect_pull_latency: ['p(95)<600'],
    reconnect_sync_lag_ms: ['p(95)<8000'],
    reconnect_errors: ['rate<0.05'],
  },
};

export default function () {
  const userId = vuUserId(__VU, 'reconnect');
  const wsClientId = `k6-reconnect-listener-${__VU}-${__ITER}`;
  const writerClientId = `k6-reconnect-writer-${__VU}`;
  const state = getState();

  const wsBaseUrl = (__ENV.BASE_URL || 'http://localhost:3001').replace(
    'http',
    'ws'
  );
  const wsUrl =
    `${wsBaseUrl}/api/sync/realtime` +
    `?userId=${encodeURIComponent(userId)}` +
    `&clientId=${encodeURIComponent(wsClientId)}`;

  const operation = taskUpsertOperation(userId);
  const pushRes = push(userId, [operation], writerClientId);
  const pushBody = parseCombinedResponse(pushRes);
  const pushOk =
    pushRes.status === 200 &&
    pushBody?.ok === true &&
    pushBody?.push?.ok === true;
  if (pushOk) {
    state.pendingWrites.set(operation.row_id, Date.now());
  }

  const connectStart = Date.now();
  let connected = false;
  let sawWakeup = false;

  const wsRes = ws.connect(wsUrl, {}, (socket) => {
    socket.on('open', () => {
      connected = true;
      reconnects.add(1);
      reconnectConnectTime.add(Date.now() - connectStart);
    });

    socket.on('message', (data) => {
      let message = null;
      try {
        message = JSON.parse(data);
      } catch {
        return;
      }

      if (message?.event === 'sync') {
        sawWakeup = true;
        reconnectWakeups.add(1);
      }
    });

    socket.on('error', () => {
      reconnectErrors.add(true);
    });

    socket.setTimeout(() => {
      socket.close();
    }, smokeMode ? 1500 : 4000);
  });

  const pullResult = pullCatchup(userId, wsClientId, state);
  reconnectPullLatency.add(pullResult.res.timings.duration);

  const visibleRowIds = pullResult.ok
    ? collectPulledRowIds(pullResult.sub)
    : new Set();
  const timedOut = pullResult.ok
    ? settlePendingWrites(state, visibleRowIds, Date.now())
    : 1;

  const reconnectOk =
    wsRes &&
    wsRes.status === 101 &&
    connected &&
    pushOk &&
    pullResult.ok &&
    timedOut === 0 &&
    state.cursor >= state.lastCursor;

  reconnectErrors.add(!reconnectOk);

  check(wsRes, {
    'ws reconnect upgrade accepted': (r) => r && r.status === 101,
    'ws reconnect established': () => connected,
  });

  check(pullResult.res, {
    'reconnect catchup pull ok': () => pullResult.ok,
    'reconnect cursor monotonic': () => state.cursor >= state.lastCursor,
    'reconnect write converged': () => timedOut === 0,
    'reconnect pending writes bounded': () => state.pendingWrites.size <= 10,
  });

  sleep(smokeMode ? 0.2 : 0.5);
}

export function setup() {
  console.log('Starting reconnect storm load test...');
  console.log(`Base URL: ${__ENV.BASE_URL || 'http://localhost:3001'}`);
  return { startTime: Date.now() };
}

export function teardown(data) {
  const duration = (Date.now() - data.startTime) / 1000;
  console.log(`Reconnect storm completed in ${duration.toFixed(2)}s`);
}
