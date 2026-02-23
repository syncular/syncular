/**
 * k6 Load Test: Bootstrap Scenario
 *
 * Measures first-sync bootstrap behavior using the current combined /sync API.
 * For each VU we:
 * 1) discover expected rows for its user (if server exposes /api/stats/user/:id)
 * 2) iterate pull requests while preserving cursor/bootstrapState
 * 3) download referenced snapshot chunks to include network load
 */

import { check, sleep } from 'k6';
import http from 'k6/http';
import { Counter, Rate, Trend } from 'k6/metrics';
import {
  fetchSnapshotChunk,
  parseCombinedResponse,
  pull,
} from '../lib/sync-client.js';
import { userTasksSubscription, vuUserId } from '../lib/data-generator.js';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3001';
const BOOTSTRAP_MIN_RPS = Number.parseFloat(
  __ENV.BOOTSTRAP_MIN_ROWS_PER_SECOND || '50'
);
const smokeMode = __ENV.K6_SMOKE === 'true';

// Custom metrics
const bootstrapLatency = new Trend('bootstrap_latency', true);
const bootstrapErrors = new Rate('bootstrap_errors');
const rowsReceived = new Counter('rows_received');
const chunksReceived = new Counter('chunks_received');
const bootstrapThroughput = new Trend('bootstrap_rows_per_second', false);

// Test configuration
export const options = {
  scenarios: smokeMode
    ? {
        bootstrap_small: {
          executor: 'constant-vus',
          vus: 1,
          duration: '10s',
          exec: 'bootstrapSmall',
          startTime: '0s',
        },
      }
    : {
        bootstrap_small: {
          executor: 'constant-vus',
          vus: 10,
          duration: '1m',
          exec: 'bootstrapSmall',
          startTime: '0s',
        },
        bootstrap_medium: {
          executor: 'constant-vus',
          vus: 25,
          duration: '2m',
          exec: 'bootstrapMedium',
          startTime: '1m',
        },
        bootstrap_large: {
          executor: 'constant-vus',
          vus: 50,
          duration: '2m',
          exec: 'bootstrapLarge',
          startTime: '3m',
        },
      },

  thresholds: {
    bootstrap_latency: ['p(95)<30000'],
    bootstrap_errors: ['rate<0.05'],
    bootstrap_rows_per_second: [`avg>${BOOTSTRAP_MIN_RPS}`],
  },
};

function readExpectedRows(userId) {
  const res = http.get(
    `${BASE_URL}/api/stats/user/${encodeURIComponent(userId)}`
  );
  if (res.status !== 200) return null;

  try {
    const body = JSON.parse(res.body);
    return Number.isFinite(body?.rows) ? body.rows : null;
  } catch {
    return null;
  }
}

function countCommitRows(commits) {
  let rows = 0;
  for (const commit of commits || []) {
    if (!Array.isArray(commit?.changes)) continue;
    rows += commit.changes.length;
  }
  return rows;
}

function downloadSnapshotChunks(userId, snapshots) {
  let bytes = 0;
  for (const snapshot of snapshots || []) {
    const chunks = Array.isArray(snapshot?.chunks) ? snapshot.chunks : [];
    for (const chunk of chunks) {
      const chunkId = chunk?.id;
      if (!chunkId) continue;

      chunksReceived.add(1);
      const chunkRes = fetchSnapshotChunk(userId, chunkId);
      if (chunkRes.status !== 200) continue;

      const declaredSize = Number.parseInt(chunk?.byteLength, 10);
      if (Number.isFinite(declaredSize) && declaredSize > 0) {
        bytes += declaredSize;
      } else if (Number.isFinite(chunkRes.body?.byteLength)) {
        bytes += chunkRes.body.byteLength;
      }
    }
  }
  return bytes;
}

function performBootstrap(userId, profileName, pullOptions) {
  const clientId = `k6-bootstrap-${profileName}-${__VU}-${__ITER}`;
  const expectedRows = readExpectedRows(userId);
  const startTime = Date.now();

  let totalRows = 0;
  let totalChunkBytes = 0;
  let cursor = -1;
  let bootstrapState = null;
  let iterations = 0;
  const maxIterations = 1000;

  while (iterations < maxIterations) {
    iterations++;

    const pullRes = pull(
      userId,
      [
        userTasksSubscription(userId, {
          id: `${profileName}-sub-${__VU}`,
          cursor,
          bootstrapState,
        }),
      ],
      pullOptions,
      clientId
    );

    const body = parseCombinedResponse(pullRes);
    const sub = body?.pull?.subscriptions?.[0];
    const pullOk =
      pullRes.status === 200 &&
      body?.ok === true &&
      body?.pull?.ok === true &&
      sub != null;

    if (!pullOk) {
      bootstrapErrors.add(true);
      return {
        success: false,
        duration: Date.now() - startTime,
        rows: totalRows,
        expectedRows,
        chunkBytes: totalChunkBytes,
      };
    }

    const commitRows = countCommitRows(sub.commits);
    totalRows += commitRows;
    rowsReceived.add(commitRows);

    const snapshotRows = (sub.snapshots || []).reduce((sum, snapshot) => {
      return sum + (Array.isArray(snapshot?.rows) ? snapshot.rows.length : 0);
    }, 0);
    totalRows += snapshotRows;
    rowsReceived.add(snapshotRows);

    totalChunkBytes += downloadSnapshotChunks(userId, sub.snapshots);

    cursor = Number.isFinite(sub.nextCursor) ? sub.nextCursor : cursor;
    bootstrapState = sub.bootstrapState ?? null;

    if (bootstrapState == null) {
      break;
    }
  }

  if (iterations >= maxIterations) {
    bootstrapErrors.add(true);
    return {
      success: false,
      duration: Date.now() - startTime,
      rows: totalRows,
      expectedRows,
      chunkBytes: totalChunkBytes,
    };
  }

  const duration = Date.now() - startTime;
  const effectiveRows = expectedRows ?? totalRows;
  const rowsPerSecond =
    duration > 0 && effectiveRows > 0 ? effectiveRows / (duration / 1000) : 0;

  return {
    success: true,
    duration,
    rows: totalRows,
    expectedRows,
    chunkBytes: totalChunkBytes,
    rowsPerSecond,
  };
}

export function bootstrapSmall() {
  const userId = vuUserId(__VU, __ENV.BOOTSTRAP_SMALL_PREFIX || 'small');
  const result = performBootstrap(userId, 'small', {
    limitCommits: 100,
    limitSnapshotRows: 1000,
    maxSnapshotPages: 4,
  });

  bootstrapLatency.add(result.duration);
  bootstrapErrors.add(!result.success);
  if (result.rowsPerSecond) bootstrapThroughput.add(result.rowsPerSecond);

  check(result, {
    'bootstrap_small succeeds': (r) => r.success,
    'bootstrap_small has rows': (r) => (r.expectedRows ?? r.rows) > 0,
  });

  sleep(5);
}

export function bootstrapMedium() {
  const userId = vuUserId(__VU, __ENV.BOOTSTRAP_MEDIUM_PREFIX || 'medium');
  const result = performBootstrap(userId, 'medium', {
    limitCommits: 200,
    limitSnapshotRows: 2500,
    maxSnapshotPages: 8,
  });

  bootstrapLatency.add(result.duration);
  bootstrapErrors.add(!result.success);
  if (result.rowsPerSecond) bootstrapThroughput.add(result.rowsPerSecond);

  check(result, {
    'bootstrap_medium succeeds': (r) => r.success,
    'bootstrap_medium has rows': (r) => (r.expectedRows ?? r.rows) > 0,
  });

  sleep(10);
}

export function bootstrapLarge() {
  const userId = vuUserId(__VU, __ENV.BOOTSTRAP_LARGE_PREFIX || 'large');
  const result = performBootstrap(userId, 'large', {
    limitCommits: 500,
    limitSnapshotRows: 5000,
    maxSnapshotPages: 12,
  });

  bootstrapLatency.add(result.duration);
  bootstrapErrors.add(!result.success);
  if (result.rowsPerSecond) bootstrapThroughput.add(result.rowsPerSecond);

  check(result, {
    'bootstrap_large succeeds': (r) => r.success,
    'bootstrap_large has rows': (r) => (r.expectedRows ?? r.rows) > 0,
  });

  sleep(30);
}

// Default function (runs if no scenario specified)
export default function () {
  bootstrapSmall();
}

export function setup() {
  console.log('Starting bootstrap load test...');
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Min rows/s threshold: ${BOOTSTRAP_MIN_RPS}`);

  return { startTime: Date.now() };
}

export function teardown(data) {
  const duration = (Date.now() - data.startTime) / 1000;
  console.log(`Test completed in ${duration.toFixed(2)}s`);
}
