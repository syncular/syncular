/**
 * k6 Load Test: WebSocket Realtime Scenario
 *
 * Tests the realtime notification system under load with
 * many concurrent WebSocket connections.
 *
 * Usage:
 *   k6 run tests/load/scripts/websocket.js
 *   k6 run --vus 500 --duration 2m tests/load/scripts/websocket.js
 */

import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import ws from 'k6/ws';
import { push } from '../lib/sync-client.js';
import { taskUpsertOperation, vuUserId } from '../lib/data-generator.js';

// Custom metrics
const wsConnectTime = new Trend('ws_connect_time', true);
const wsMessageLatency = new Trend('ws_message_latency', true);
const wsErrors = new Rate('ws_errors');
const wsMessages = new Counter('ws_messages_received');
const wsConnections = new Counter('ws_connections');

// Test configuration
export const options = {
  // Ramp up WebSocket connections
  stages: [
    { duration: '20s', target: 100 }, // Warm up
    { duration: '1m', target: 500 }, // Ramp to 500
    { duration: '1m', target: 1000 }, // Ramp to 1000
    { duration: '20s', target: 0 }, // Ramp down
  ],

  // Performance thresholds
  thresholds: {
    ws_connect_time: ['p(95)<1000'], // 95th percentile connection under 1s
    ws_message_latency: ['p(95)<100'], // 95th percentile message latency under 100ms
    ws_errors: ['rate<0.05'], // Less than 5% error rate
  },
};

// Main test function - runs per VU per iteration
export default function () {
  const userId = vuUserId(__VU);
  const baseUrl = __ENV.BASE_URL || 'http://localhost:3001';
  const wsUrl = baseUrl.replace('http', 'ws');
  const url = `${wsUrl}/api/sync/realtime?userId=${userId}`;

  const connectStart = Date.now();
  let connected = false;
  let messageCount = 0;

  const res = ws.connect(url, {}, (socket) => {
    socket.on('open', () => {
      const connectDuration = Date.now() - connectStart;
      wsConnectTime.add(connectDuration);
      wsConnections.add(1);
      connected = true;

      // Subscribe to user tasks changes
      socket.send(
        JSON.stringify({
          type: 'subscribe',
          subscriptions: [{ kind: 'user_tasks' }],
        })
      );
    });

    socket.on('message', (data) => {
      const receiveTime = Date.now();
      wsMessages.add(1);
      messageCount++;

      // Try to parse and measure latency if message has timestamp
      try {
        const msg = JSON.parse(data);
        if (msg.timestamp) {
          const latency = receiveTime - msg.timestamp;
          if (latency > 0 && latency < 60000) {
            // Sanity check: < 1 minute
            wsMessageLatency.add(latency);
          }
        }
      } catch {
        // Ignore parse errors for non-JSON messages
      }
    });

    socket.on('error', (e) => {
      wsErrors.add(1);
      console.error(`WS error for VU ${__VU}: ${e}`);
    });

    socket.on('close', () => {
      // Connection closed
    });

    // Periodically push data to trigger notifications
    socket.setInterval(() => {
      // Push a task (this should trigger a notification back)
      const operation = taskUpsertOperation(userId);
      push(userId, [operation], `k6-ws-${__VU}`);
    }, 5000); // Every 5 seconds

    // Keep connection open for test duration
    // Socket will be closed when VU finishes
    socket.setTimeout(() => {
      socket.close();
    }, 120000); // 2 minutes max
  });

  check(res, {
    'WebSocket connected': () => connected,
    'received messages': () => messageCount > 0,
  });

  if (!connected) {
    wsErrors.add(1);
  }

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
