/**
 * k6 Load Test: Maintenance Churn
 *
 * Runs read/write traffic while prune + compaction are triggered continuously.
 */

import { check, sleep } from 'k6';
import http from 'k6/http';
import exec from 'k6/execution';
import { Rate, Trend } from 'k6/metrics';
import { parseCombinedResponse, pull, push } from '../lib/sync-client.js';
import {
  taskUpsertOperation,
  userTasksSubscription,
  vuUserId,
} from '../lib/data-generator.js';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3001';
const smokeMode = __ENV.K6_SMOKE === 'true';

const readerLatency = new Trend('maintenance_reader_latency', true);
const writerPushLatency = new Trend('maintenance_writer_push_latency', true);
const writerPullLatency = new Trend('maintenance_writer_pull_latency', true);
const pruneLatency = new Trend('maintenance_prune_latency', true);
const compactLatency = new Trend('maintenance_compact_latency', true);

const readerErrors = new Rate('maintenance_reader_errors');
const writerErrors = new Rate('maintenance_writer_errors');
const maintenanceErrors = new Rate('maintenance_operation_errors');

const readerStateByVu = new Map();
const writerStateByVu = new Map();

function getState(map) {
  const key = `${exec.scenario.name}-${__VU}`;
  const existing = map.get(key);
  if (existing) return existing;

  const state = {
    cursor: -1,
    bootstrapState: null,
  };
  map.set(key, state);
  return state;
}

function runPull(userId, clientId, state, subId) {
  const res = pull(
    userId,
    [
      userTasksSubscription(userId, {
        id: subId,
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
    state.cursor = Number.isFinite(sub.nextCursor) ? sub.nextCursor : state.cursor;
    state.bootstrapState = sub.bootstrapState ?? null;
  }

  return { ok, res };
}

export const options = {
  scenarios: smokeMode
    ? {
        readers: {
          executor: 'constant-vus',
          exec: 'reader',
          vus: 1,
          duration: '12s',
        },
        writers: {
          executor: 'constant-vus',
          exec: 'writer',
          vus: 1,
          duration: '12s',
        },
        maintenance: {
          executor: 'constant-vus',
          exec: 'maintenanceRunner',
          vus: 1,
          duration: '12s',
        },
      }
    : {
        readers: {
          executor: 'ramping-vus',
          exec: 'reader',
          startVUs: 0,
          stages: [
            { duration: '20s', target: 80 },
            { duration: '2m', target: 200 },
            { duration: '40s', target: 0 },
          ],
        },
        writers: {
          executor: 'ramping-vus',
          exec: 'writer',
          startVUs: 0,
          stages: [
            { duration: '20s', target: 20 },
            { duration: '2m', target: 60 },
            { duration: '40s', target: 0 },
          ],
        },
        maintenance: {
          executor: 'constant-vus',
          exec: 'maintenanceRunner',
          vus: 1,
          duration: '3m',
        },
      },
  thresholds: {
    maintenance_reader_latency: ['p(95)<500'],
    maintenance_writer_push_latency: ['p(95)<800'],
    maintenance_writer_pull_latency: ['p(95)<700'],
    maintenance_prune_latency: ['p(95)<5000'],
    maintenance_compact_latency: ['p(95)<5000'],
    maintenance_reader_errors: ['rate<0.02'],
    maintenance_writer_errors: ['rate<0.02'],
    maintenance_operation_errors: ['rate<0.05'],
  },
};

export function reader() {
  const userId = vuUserId(__VU, 'reader');
  const state = getState(readerStateByVu);
  const result = runPull(userId, `k6-maint-reader-${__VU}`, state, `reader-sub-${__VU}`);

  readerLatency.add(result.res.timings.duration);
  readerErrors.add(!result.ok);

  check(result.res, {
    'maintenance reader pull ok': () => result.ok,
  });

  sleep(smokeMode ? 0.2 : 0.7);
}

export function writer() {
  const userId = vuUserId(__VU, 'writer');
  const clientId = `k6-maint-writer-${__VU}`;
  const state = getState(writerStateByVu);

  const operation = taskUpsertOperation(userId);
  const pushRes = push(userId, [operation], clientId);
  const pushBody = parseCombinedResponse(pushRes);
  const pushOk =
    pushRes.status === 200 &&
    pushBody?.ok === true &&
    pushBody?.push?.ok === true;

  writerPushLatency.add(pushRes.timings.duration);

  const pullResult = runPull(userId, clientId, state, `writer-sub-${__VU}`);
  writerPullLatency.add(pullResult.res.timings.duration);

  const ok = pushOk && pullResult.ok;
  writerErrors.add(!ok);

  check(
    { pushOk, pullOk: pullResult.ok },
    {
      'maintenance writer push ok': (r) => r.pushOk,
      'maintenance writer pull ok': (r) => r.pullOk,
    }
  );

  sleep(smokeMode ? 0.2 : 0.5);
}

export function maintenanceRunner() {
  const compactRes = http.post(
    `${BASE_URL}/api/maintenance/compact`,
    JSON.stringify({ fullHistoryHours: smokeMode ? 1 : 6 }),
    {
      headers: { 'Content-Type': 'application/json' },
    }
  );

  compactLatency.add(compactRes.timings.duration);

  const pruneRes = http.post(
    `${BASE_URL}/api/maintenance/prune`,
    JSON.stringify({
      activeWindowMs: 24 * 60 * 60 * 1000,
      fallbackMaxAgeMs: 45 * 60 * 1000,
      keepNewestCommits: smokeMode ? 80 : 300,
    }),
    {
      headers: { 'Content-Type': 'application/json' },
    }
  );

  pruneLatency.add(pruneRes.timings.duration);

  let compactOk = compactRes.status === 200;
  let pruneOk = pruneRes.status === 200;

  if (compactOk) {
    const body = compactRes.json();
    compactOk = body != null && body.ok === true;
  }

  if (pruneOk) {
    const body = pruneRes.json();
    pruneOk = body != null && body.ok === true;
  }

  maintenanceErrors.add(!(compactOk && pruneOk));

  check(
    { compactOk, pruneOk },
    {
      'maintenance compact ok': (r) => r.compactOk,
      'maintenance prune ok': (r) => r.pruneOk,
    }
  );

  sleep(smokeMode ? 1 : 4);
}

export default function () {
  reader();
}

export function setup() {
  console.log('Starting maintenance churn load test...');
  console.log(`Base URL: ${BASE_URL}`);
  return { startTime: Date.now() };
}

export function teardown(data) {
  const duration = (Date.now() - data.startTime) / 1000;
  console.log(`Maintenance churn completed in ${duration.toFixed(2)}s`);
}
