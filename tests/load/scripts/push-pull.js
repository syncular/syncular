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
import { push, pull, healthCheck } from '../lib/sync-client.js';
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

// Test configuration
export const options = {
  // Ramp up pattern: 100 -> 500 -> 1000 -> 0
  stages: [
    { duration: '30s', target: 100 }, // Warm up
    { duration: '1m', target: 500 }, // Ramp to 500
    { duration: '1m', target: 1000 }, // Ramp to 1000
    { duration: '30s', target: 0 }, // Ramp down
  ],

  // Performance thresholds
  thresholds: {
    push_latency: ['p(95)<500'], // 95th percentile under 500ms
    pull_latency: ['p(95)<200'], // 95th percentile under 200ms
    push_errors: ['rate<0.01'], // Less than 1% error rate
    pull_errors: ['rate<0.01'], // Less than 1% error rate
    http_req_duration: ['p(99)<1000'], // 99th percentile under 1s
  },
};

// Main test function - runs per VU per iteration
export default function () {
  const userId = vuUserId(__VU);
  const clientId = `k6-push-pull-${__VU}`;

  // Push a task
  const operation = taskUpsertOperation(userId);
  const pushRes = push(userId, [operation], clientId);

  pushLatency.add(pushRes.timings.duration);
  pushErrors.add(pushRes.status !== 200);

  const pushOk = check(pushRes, {
    'push status 200': (r) => r.status === 200,
    'push has response body': (r) => r.body && r.body.length > 0,
  });

  if (!pushOk) {
    console.error(
      `Push failed: status=${pushRes.status}, body=${pushRes.body}`
    );
  }

  // Small delay between operations
  sleep(0.5);

  // Pull changes
  const pullRes = pull(userId, [userTasksSubscription()], 0, clientId);

  pullLatency.add(pullRes.timings.duration);
  pullErrors.add(pullRes.status !== 200);

  const pullOk = check(pullRes, {
    'pull status 200': (r) => r.status === 200,
    'pull has response body': (r) => r.body && r.body.length > 0,
  });

  if (!pullOk) {
    console.error(
      `Pull failed: status=${pullRes.status}, body=${pullRes.body}`
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
