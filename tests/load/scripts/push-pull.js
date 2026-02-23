/**
 * k6 Load Test: Push/Pull Scenario
 *
 * Tests sync API throughput with many concurrent clients
 * performing push and pull operations.
 *
 * Usage:
 *   k6 run tests/load/scripts/push-pull.js
 *   k6 run --vus 100 --duration 1m tests/load/scripts/push-pull.js
 *   k6 run --out dashboard tests/load/scripts/push-pull.js
 */

import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';
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

// Custom metrics
const pushErrors = new Rate('push_errors');
const pullErrors = new Rate('pull_errors');
const pushLatency = new Trend('push_latency', true);
const pullLatency = new Trend('pull_latency', true);
const syncLag = new Trend('sync_lag_ms', true);
const syncConvergenceErrors = new Rate('sync_convergence_errors');
const pendingSyncWrites = new Trend('pending_sync_writes', false);
const pullStateByVu = new Map();
const smokeMode = __ENV.K6_SMOKE === 'true';
const syncLagSloMs = Number.parseInt(__ENV.SYNC_LAG_SLO_MS || '5000', 10);
const syncVisibilityTimeoutMs = Number.parseInt(
  __ENV.SYNC_VISIBILITY_TIMEOUT_MS || '20000',
  10
);
const maxPendingWrites = Number.parseInt(__ENV.SYNC_MAX_PENDING_WRITES || '50', 10);

// Test configuration
export const options = {
  // Ramp up pattern: 100 -> 500 -> 1000 -> 0
  stages: smokeMode
    ? [
        { duration: '4s', target: 2 },
        { duration: '2s', target: 0 },
      ]
    : [
        { duration: '30s', target: 100 }, // Warm up
        { duration: '1m', target: 500 }, // Ramp to 500
        { duration: '1m', target: 1000 }, // Ramp to 1000
        { duration: '30s', target: 0 }, // Ramp down
      ],

  // Performance thresholds
  thresholds: {
    push_latency: ['p(95)<500'], // 95th percentile under 500ms
    pull_latency: ['p(95)<200'], // 95th percentile under 200ms
    sync_lag_ms: [`p(95)<${syncLagSloMs}`],
    push_errors: ['rate<0.01'], // Less than 1% error rate
    pull_errors: ['rate<0.01'], // Less than 1% error rate
    sync_convergence_errors: ['rate<0.01'],
    http_req_duration: ['p(99)<1000'], // 99th percentile under 1s
  },
};

function settlePendingWrites(state, visibleRowIds, now) {
  let timedOut = 0;

  for (const rowId of visibleRowIds) {
    const startedAt = state.pendingWrites.get(rowId);
    if (!Number.isFinite(startedAt)) continue;

    const lag = now - startedAt;
    if (lag >= 0) {
      syncLag.add(lag);
    }
    state.pendingWrites.delete(rowId);
  }

  for (const [rowId, startedAt] of state.pendingWrites.entries()) {
    if (!Number.isFinite(startedAt)) continue;
    if (now - startedAt < syncVisibilityTimeoutMs) continue;

    timedOut++;
    state.pendingWrites.delete(rowId);
  }

  pendingSyncWrites.add(state.pendingWrites.size);
  return timedOut;
}

// Main test function - runs per VU per iteration
export default function () {
  const userId = vuUserId(__VU);
  const clientId = `k6-push-pull-${__VU}`;
  const state = pullStateByVu.get(__VU) ?? {
    cursor: -1,
    bootstrapState: null,
    pendingWrites: new Map(),
  };
  pullStateByVu.set(__VU, state);

  // Push a task
  const operation = taskUpsertOperation(userId);
  const pushRes = push(userId, [operation], clientId);
  const pushBody = parseCombinedResponse(pushRes);
  const pushSucceeded =
    pushRes.status === 200 &&
    pushBody?.ok === true &&
    pushBody?.push?.ok === true;

  pushLatency.add(pushRes.timings.duration);
  pushErrors.add(!pushSucceeded);

  const pushOk = check(pushRes, {
    'push status 200': () => pushSucceeded,
    'push response has push payload': () => pushBody?.push?.status != null,
  });

  if (!pushOk) {
    console.error(
      `Push failed: status=${pushRes.status}, body=${pushRes.body}`
    );
  } else {
    state.pendingWrites.set(operation.row_id, Date.now());
  }

  // Small delay between operations
  sleep(0.5);

  // Pull changes
  const pullRes = pull(
    userId,
    [
      userTasksSubscription(userId, {
        id: `sub-${__VU}`,
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
  const pullBody = parseCombinedResponse(pullRes);
  const subscription = pullBody?.pull?.subscriptions?.[0];
  const pullSucceeded =
    pullRes.status === 200 &&
    pullBody?.ok === true &&
    pullBody?.pull?.ok === true &&
    subscription != null;

  if (pullSucceeded) {
    state.cursor = Number.isFinite(subscription.nextCursor)
      ? subscription.nextCursor
      : state.cursor;
    state.bootstrapState = subscription.bootstrapState ?? null;
  }

  const visibleRowIds = pullSucceeded ? collectPulledRowIds(subscription) : new Set();
  const timedOutWrites = pullSucceeded
    ? settlePendingWrites(state, visibleRowIds, Date.now())
    : 0;
  const pendingWritesOverLimit = state.pendingWrites.size > maxPendingWrites;
  const convergenceFailed = timedOutWrites > 0 || pendingWritesOverLimit;
  syncConvergenceErrors.add(convergenceFailed);

  pullLatency.add(pullRes.timings.duration);
  pullErrors.add(!pullSucceeded);

  const pullProtocolOk = check(pullRes, {
    'pull status 200': () => pullSucceeded,
    'pull has subscription data': () => subscription != null,
  });
  const convergenceOk = check(pullRes, {
    'sync convergence maintained': () => !convergenceFailed,
  });

  if (!pullProtocolOk) {
    console.error(
      `Pull failed: status=${pullRes.status}, body=${pullRes.body}`
    );
  } else if (!convergenceOk) {
    console.error(
      `Sync convergence lagged: pending=${state.pendingWrites.size}, timedOut=${timedOutWrites}`
    );
  }

  // Delay before next iteration
  sleep(0.5);
}

// Setup function - runs once before the test
export function setup() {
  console.log('Starting push-pull load test...');
  console.log(`Base URL: ${__ENV.BASE_URL || 'http://localhost:3001'}`);

  // Health check using the healthCheck helper
  const res = healthCheck();
  if (res.status !== 200) {
    throw new Error(`Server health check failed: ${res.status}`);
  }

  return { startTime: Date.now() };
}

// Teardown function - runs once after the test
export function teardown(data) {
  const duration = (Date.now() - data.startTime) / 1000;
  console.log(`Test completed in ${duration.toFixed(2)}s`);
}
