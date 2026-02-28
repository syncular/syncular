/**
 * k6 Load Test: Bootstrap Storm
 *
 * Simulates many first-time clients bootstrapping concurrently.
 */

import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import {
  parseCombinedResponse,
  pull,
} from '../lib/sync-client.js';
import { userTasksSubscription, vuUserId } from '../lib/data-generator.js';

const bootstrapStormLatency = new Trend('bootstrap_storm_latency', true);
const bootstrapStormPullLatency = new Trend('bootstrap_storm_pull_latency', true);
const bootstrapStormErrors = new Rate('bootstrap_storm_errors');
const bootstrapStormPages = new Counter('bootstrap_storm_pages');
const bootstrapStormRows = new Counter('bootstrap_storm_rows');

const smokeMode = __ENV.K6_SMOKE === 'true';
const userPrefix = __ENV.BOOTSTRAP_STORM_USER_PREFIX || 'small';
const maxPagesPerClient = Number.parseInt(
  __ENV.BOOTSTRAP_STORM_MAX_PAGES || '50',
  10
);

export const options = {
  scenarios: smokeMode
    ? {
        bootstrap_storm: {
          executor: 'constant-vus',
          vus: 2,
          duration: '12s',
        },
      }
    : {
        bootstrap_storm: {
          executor: 'ramping-vus',
          startVUs: 0,
          stages: [
            { duration: '20s', target: 20 },
            { duration: '2m', target: 150 },
            { duration: '40s', target: 0 },
          ],
        },
      },
  thresholds: {
    bootstrap_storm_latency: ['p(95)<45000'],
    bootstrap_storm_pull_latency: ['p(95)<2500'],
    bootstrap_storm_errors: ['rate<0.05'],
  },
};

function countSnapshotRows(subscription) {
  return (subscription?.snapshots || []).reduce((sum, snapshot) => {
    const rows = Array.isArray(snapshot?.rows) ? snapshot.rows.length : 0;
    return sum + rows;
  }, 0);
}

function countCommitRows(subscription) {
  return (subscription?.commits || []).reduce((sum, commit) => {
    const changes = Array.isArray(commit?.changes) ? commit.changes.length : 0;
    return sum + changes;
  }, 0);
}

export default function () {
  const userId = vuUserId(__VU, userPrefix);
  const clientId = `k6-bootstrap-storm-${__VU}-${__ITER}`;

  const startedAt = Date.now();
  let cursor = -1;
  let bootstrapState = null;
  let totalRows = 0;
  let pageCount = 0;
  let success = true;

  while (pageCount < maxPagesPerClient) {
    const res = pull(
      userId,
      [
        userTasksSubscription(userId, {
          id: `bootstrap-storm-sub-${__VU}`,
          cursor,
          bootstrapState,
        }),
      ],
      {
        limitCommits: 100,
        limitSnapshotRows: 2500,
        maxSnapshotPages: 6,
      },
      clientId
    );

    bootstrapStormPullLatency.add(res.timings.duration);

    const body = parseCombinedResponse(res);
    const subscription = body?.pull?.subscriptions?.[0];
    const pullOk =
      res.status === 200 &&
      body?.ok === true &&
      body?.pull?.ok === true &&
      subscription != null;

    if (!pullOk) {
      success = false;
      break;
    }

    const commitRows = countCommitRows(subscription);
    const snapshotRows = countSnapshotRows(subscription);
    totalRows += commitRows + snapshotRows;

    cursor = Number.isFinite(subscription.nextCursor)
      ? subscription.nextCursor
      : cursor;
    bootstrapState = subscription.bootstrapState ?? null;

    pageCount++;
    bootstrapStormPages.add(1);

    if (bootstrapState == null) {
      break;
    }
  }

  if (bootstrapState != null) {
    success = false;
  }

  bootstrapStormRows.add(totalRows);
  bootstrapStormLatency.add(Date.now() - startedAt);
  bootstrapStormErrors.add(!success);

  check(
    {
      success,
      pages: pageCount,
    },
    {
      'bootstrap storm succeeds': (r) => r.success,
      'bootstrap storm pages bounded': (r) => r.pages > 0 && r.pages <= maxPagesPerClient,
    }
  );

  sleep(smokeMode ? 0.2 : 0.5);
}

export function setup() {
  console.log('Starting bootstrap storm load test...');
  console.log(`Base URL: ${__ENV.BASE_URL || 'http://localhost:3001'}`);
  return { startTime: Date.now() };
}

export function teardown(data) {
  const duration = (Date.now() - data.startTime) / 1000;
  console.log(`Bootstrap storm completed in ${duration.toFixed(2)}s`);
}
