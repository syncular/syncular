/**
 * k6 Baseline: push + bootstrap-pull latency against the binary sync protocol.
 *
 * Envelope-level only by design: validates that responses are SSP1 sync
 * packs and measures latency/throughput. The scenario scripts use the full
 * reader in ../lib/ssp1.js for body-level checks.
 *
 * Usage:
 *   bun run test:load:server   # in another terminal
 *   k6 run scripts/baseline-smoke.js
 */

import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';
import { isSyncPackBody } from '../lib/ssp1.js';
import { healthCheck, pull, push } from '../lib/sync-client.js';
import {
  taskUpsertOperation,
  userTasksSubscription,
  vuUserId,
} from '../lib/data-generator.js';

const pushErrors = new Rate('push_errors');
const pullErrors = new Rate('pull_errors');
const pushLatency = new Trend('push_latency', true);
const pullLatency = new Trend('pull_latency', true);

const VUS = Number.parseInt(__ENV.BASELINE_VUS || '100', 10);
const DURATION = __ENV.BASELINE_DURATION || '60s';

export const options = {
  scenarios: {
    baseline: {
      executor: 'constant-vus',
      vus: VUS,
      duration: DURATION,
    },
  },
  thresholds: {
    push_latency: ['p(95)<500'],
    pull_latency: ['p(95)<500'],
    push_errors: ['rate<0.01'],
    pull_errors: ['rate<0.01'],
  },
};

function isSyncPackResponse(res) {
  // push/pull request binary bodies, so res.body is an ArrayBuffer.
  return res.status === 200 && isSyncPackBody(res.body);
}

export default function () {
  const userId = vuUserId(__VU);
  const clientId = `k6-baseline-${__VU}`;

  const pushRes = push(userId, [taskUpsertOperation(userId)], clientId);
  const pushOk = isSyncPackResponse(pushRes);
  pushLatency.add(pushRes.timings.duration);
  pushErrors.add(!pushOk);
  check(pushRes, { 'push returns SSP1': () => pushOk });
  if (!pushOk) {
    console.error(`Push failed: status=${pushRes.status}`);
  }

  sleep(0.25);

  // cursor: -1 exercises the bootstrap/snapshot path on every pull.
  const pullRes = pull(
    userId,
    [userTasksSubscription(userId, { id: `sub-${__VU}` })],
    { limitCommits: 100, limitSnapshotRows: 1000, maxSnapshotPages: 4 },
    clientId
  );
  const pullOk = isSyncPackResponse(pullRes);
  pullLatency.add(pullRes.timings.duration);
  pullErrors.add(!pullOk);
  check(pullRes, { 'pull returns SSP1': () => pullOk });
  if (!pullOk) {
    console.error(`Pull failed: status=${pullRes.status}`);
  }

  sleep(0.25);
}

export function setup() {
  const res = healthCheck();
  if (res.status !== 200) {
    throw new Error(`Server not healthy: ${res.status}`);
  }
}
