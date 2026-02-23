/**
 * k6 Load Test: Large Data Bootstrap Scenario
 *
 * Tests initial sync (bootstrap) performance with large datasets.
 * Simulates new clients pulling all data for the first time.
 *
 * Prerequisites:
 *   - Server must be seeded with data using the load test server
 *   - Configure SEED_ROWS and SEED_USERS env vars when starting server
 *
 * Usage:
 *   k6 run tests/load/scripts/bootstrap.js
 *   k6 run --vus 50 tests/load/scripts/bootstrap.js
 */

import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import { pull, fetchSnapshotChunk } from '../lib/sync-client.js';
import { userTasksSubscription, vuUserId } from '../lib/data-generator.js';

// Custom metrics
const bootstrapLatency = new Trend('bootstrap_latency', true);
const bootstrapErrors = new Rate('bootstrap_errors');
const rowsReceived = new Counter('rows_received');
const chunksReceived = new Counter('chunks_received');
const bootstrapThroughput = new Trend('bootstrap_rows_per_second', true);

// Test configuration
export const options = {
  // Bootstrap test with moderate concurrency
  scenarios: {
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

  // Performance thresholds
  thresholds: {
    bootstrap_latency: ['p(95)<30000'], // 95th percentile under 30s
    bootstrap_errors: ['rate<0.05'], // Less than 5% error rate
    bootstrap_rows_per_second: ['avg>1000'], // Average > 1000 rows/second
  },
};

/**
 * Perform a full bootstrap pull for a user
 * Handles paginated responses and snapshot chunks
 */
function performBootstrap(userId, expectedRows) {
  const clientId = `k6-bootstrap-${__VU}-${__ITER}`;
  const startTime = Date.now();
  let totalRows = 0;
  let cursor = 0;
  let iterations = 0;
  const maxIterations = 1000; // Safety limit

  while (iterations < maxIterations) {
    iterations++;

    const res = pull(userId, [userTasksSubscription()], cursor, clientId);

    if (res.status !== 200) {
      bootstrapErrors.add(1);
      console.error(
        `Bootstrap pull failed: status=${res.status}, body=${res.body}`
      );
      return { success: false, rows: totalRows, duration: Date.now() - startTime };
    }

    let response;
    try {
      response = JSON.parse(res.body);
    } catch (e) {
      bootstrapErrors.add(1);
      console.error(`Failed to parse response: ${e}`);
      return { success: false, rows: totalRows, duration: Date.now() - startTime };
    }

    // Count rows from changes
    if (response.changes && Array.isArray(response.changes)) {
      totalRows += response.changes.length;
      rowsReceived.add(response.changes.length);
    }

    // Handle snapshot chunks if present
    if (response.snapshots && Array.isArray(response.snapshots)) {
      for (const snapshot of response.snapshots) {
        if (snapshot.rows && Array.isArray(snapshot.rows)) {
          totalRows += snapshot.rows.length;
          rowsReceived.add(snapshot.rows.length);
        }

        // Fetch additional chunks if present
        if (snapshot.chunkIds && Array.isArray(snapshot.chunkIds)) {
          for (const chunkId of snapshot.chunkIds) {
            const chunkRes = fetchSnapshotChunk(userId, chunkId);
            chunksReceived.add(1);

            if (chunkRes.status === 200) {
              try {
                const chunkData = JSON.parse(chunkRes.body);
                if (chunkData.rows && Array.isArray(chunkData.rows)) {
                  totalRows += chunkData.rows.length;
                  rowsReceived.add(chunkData.rows.length);
                }
              } catch {
                // Ignore chunk parse errors
              }
            }
          }
        }
      }
    }

    // Update cursor for next page
    if (response.cursor && response.cursor > cursor) {
      cursor = response.cursor;
    } else {
      // No more data
      break;
    }

    // Check if we've received expected rows
    if (expectedRows && totalRows >= expectedRows) {
      break;
    }
  }

  const duration = Date.now() - startTime;
  const rowsPerSecond = totalRows / (duration / 1000);

  return {
    success: true,
    rows: totalRows,
    duration,
    rowsPerSecond,
  };
}

// Bootstrap small dataset (user has ~1000 rows)
export function bootstrapSmall() {
  const userId = vuUserId(__VU, 'small');

  const result = performBootstrap(userId, 1000);

  bootstrapLatency.add(result.duration);
  if (result.rowsPerSecond) {
    bootstrapThroughput.add(result.rowsPerSecond);
  }

  check(result, {
    'bootstrap succeeded': (r) => r.success,
    'received data': (r) => r.rows > 0,
  });

  // Wait before next bootstrap attempt
  sleep(5);
}

// Bootstrap medium dataset (user has ~10K rows)
export function bootstrapMedium() {
  const userId = vuUserId(__VU, 'medium');

  const result = performBootstrap(userId, 10000);

  bootstrapLatency.add(result.duration);
  if (result.rowsPerSecond) {
    bootstrapThroughput.add(result.rowsPerSecond);
  }

  check(result, {
    'bootstrap succeeded': (r) => r.success,
    'received substantial data': (r) => r.rows >= 1000,
  });

  // Wait before next bootstrap attempt
  sleep(10);
}

// Bootstrap large dataset (user has ~50K+ rows)
export function bootstrapLarge() {
  const userId = vuUserId(__VU, 'large');

  const result = performBootstrap(userId, 50000);

  bootstrapLatency.add(result.duration);
  if (result.rowsPerSecond) {
    bootstrapThroughput.add(result.rowsPerSecond);
  }

  check(result, {
    'bootstrap succeeded': (r) => r.success,
    'received large dataset': (r) => r.rows >= 10000,
  });

  // Wait before next bootstrap attempt
  sleep(30);
}

// Default function (runs if no scenario specified)
export default function () {
  bootstrapSmall();
}

// Setup function
export function setup() {
  console.log('Starting bootstrap load test...');
  console.log(`Base URL: ${__ENV.BASE_URL || 'http://localhost:3001'}`);
  console.log('Note: Server should be seeded with data for meaningful results');

  return { startTime: Date.now() };
}

// Teardown function
export function teardown(data) {
  const duration = (Date.now() - data.startTime) / 1000;
  console.log(`Test completed in ${duration.toFixed(2)}s`);
}
