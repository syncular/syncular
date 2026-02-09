/**
 * k6 Load Test: Mixed Workload Scenario
 *
 * Simulates real-world usage patterns with:
 * - 80% readers (pull-only)
 * - 20% writers (push + pull)
 * - All clients connected via WebSocket
 *
 * This is the most realistic load test scenario.
 *
 * Usage:
 *   k6 run tests/load/scripts/mixed-workload.js
 *   k6 run --out dashboard tests/load/scripts/mixed-workload.js
 */

import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import ws from 'k6/ws';
import { push, pull, healthCheck } from '../lib/sync-client.js';
import {
  taskUpsertOperation,
  userTasksSubscription,
  vuUserId,
} from '../lib/data-generator.js';

// Custom metrics
const readerLatency = new Trend('reader_latency', true);
const writerPushLatency = new Trend('writer_push_latency', true);
const writerPullLatency = new Trend('writer_pull_latency', true);
const readerErrors = new Rate('reader_errors');
const writerErrors = new Rate('writer_errors');
const wsConnections = new Counter('ws_connections');
const wsMessages = new Counter('ws_messages');
const operationsPerSecond = new Rate('operations_per_second');

// Test configuration
export const options = {
  scenarios: {
    // 80% readers - poll for changes periodically
    readers: {
      executor: 'ramping-vus',
      exec: 'reader',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 80 }, // Ramp up to 80
        { duration: '4m', target: 800 }, // Hold at 800 (80% of 1000)
        { duration: '30s', target: 0 }, // Ramp down
      ],
    },

    // 20% writers - actively pushing changes
    writers: {
      executor: 'ramping-vus',
      exec: 'writer',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 20 }, // Ramp up to 20
        { duration: '4m', target: 200 }, // Hold at 200 (20% of 1000)
        { duration: '30s', target: 0 }, // Ramp down
      ],
    },

    // WebSocket connections for all users (realtime updates)
    websockets: {
      executor: 'ramping-vus',
      exec: 'websocketClient',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 100 }, // Ramp up
        { duration: '4m', target: 1000 }, // Hold at 1000
        { duration: '30s', target: 0 }, // Ramp down
      ],
    },
  },

  // Performance thresholds
  thresholds: {
    reader_latency: ['p(95)<300'], // Readers: 95th percentile under 300ms
    writer_push_latency: ['p(95)<500'], // Writers push: 95th percentile under 500ms
    writer_pull_latency: ['p(95)<300'], // Writers pull: 95th percentile under 300ms
    reader_errors: ['rate<0.01'], // Less than 1% reader errors
    writer_errors: ['rate<0.01'], // Less than 1% writer errors
    http_req_duration: ['p(99)<2000'], // 99th percentile under 2s
  },
};

/**
 * Reader function - pulls changes periodically
 */
export function reader() {
  const userId = vuUserId(__VU, 'reader');
  const clientId = `k6-reader-${__VU}`;

  const res = pull(userId, [userTasksSubscription()], 0, clientId);

  readerLatency.add(res.timings.duration);
  readerErrors.add(res.status !== 200);

  check(res, {
    'reader pull ok': (r) => r.status === 200,
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

  // Push a new task
  const operation = taskUpsertOperation(userId);
  const pushRes = push(userId, [operation], clientId);

  writerPushLatency.add(pushRes.timings.duration);
  writerErrors.add(pushRes.status !== 200);

  check(pushRes, {
    'writer push ok': (r) => r.status === 200,
  });

  // Small delay between push and pull
  sleep(0.3);

  // Pull to confirm changes
  const pullRes = pull(userId, [userTasksSubscription()], 0, clientId);

  writerPullLatency.add(pullRes.timings.duration);
  writerErrors.add(pullRes.status !== 200);

  check(pullRes, {
    'writer pull ok': (r) => r.status === 200,
  });

  // Writers are more active (0.5-2 seconds between writes)
  sleep(0.5 + Math.random() * 1.5);
}

/**
 * WebSocket client - maintains long-lived connection for realtime
 */
export function websocketClient() {
  const userId = vuUserId(__VU, 'ws');
  const baseUrl = __ENV.BASE_URL || 'http://localhost:3001';
  const wsUrl = baseUrl.replace('http', 'ws');
  const url = `${wsUrl}/api/sync/realtime?userId=${userId}`;

  let messageCount = 0;

  const res = ws.connect(url, {}, (socket) => {
    socket.on('open', () => {
      wsConnections.add(1);

      // Subscribe to changes
      socket.send(
        JSON.stringify({
          type: 'subscribe',
          subscriptions: [{ kind: 'user_tasks' }],
        })
      );
    });

    socket.on('message', () => {
      wsMessages.add(1);
      messageCount++;
    });

    socket.on('error', (e) => {
      console.error(`WS error: ${e}`);
    });

    // Send periodic pings to keep connection alive
    socket.setInterval(() => {
      socket.send(JSON.stringify({ type: 'ping' }));
    }, 30000);

    // Hold connection for the test duration
    socket.setTimeout(() => {
      socket.close();
    }, 300000); // 5 minutes max
  });

  check(res, {
    'ws connected': (r) => r && r.status === 101,
  });

  // WebSocket VUs run once and hold connection
  // Sleep to prevent immediate reconnection
  sleep(300);
}

// Default function (for simple runs)
export default function () {
  // Default to reader behavior
  reader();
}

// Setup function
export function setup() {
  console.log('Starting mixed workload load test...');
  console.log(`Base URL: ${__ENV.BASE_URL || 'http://localhost:3001'}`);
  console.log('Scenario: 80% readers, 20% writers, 100% WebSocket');

  // Verify server is available
  const res = healthCheck();
  if (res.status !== 200) {
    throw new Error(`Server not available: ${res.status}`);
  }

  return { startTime: Date.now() };
}

// Teardown function
export function teardown(data) {
  const duration = (Date.now() - data.startTime) / 1000;
  console.log(`Test completed in ${duration.toFixed(2)}s`);
}

// Custom summary handler (optional)
export function handleSummary(data) {
  const summary = {
    totalRequests: data.metrics.http_reqs?.values?.count || 0,
    avgLatency: data.metrics.http_req_duration?.values?.avg || 0,
    p95Latency: data.metrics.http_req_duration?.values['p(95)'] || 0,
    errorRate:
      (data.metrics.http_req_failed?.values?.rate || 0) * 100,
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
