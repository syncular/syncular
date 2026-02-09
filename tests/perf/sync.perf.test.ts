/**
 * Sync performance tests
 *
 * Measures key sync operations and detects performance regressions.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import path from 'node:path';
import {
  enqueueOutboxCommit,
  syncPullOnce,
  syncPushOnce,
} from '@syncular/client';
import {
  createTestClient,
  createTestServer,
  seedServerData,
  type TestServer,
} from '@syncular/tests-shared/test-setup';
import {
  type BenchmarkResult,
  benchmark,
  defaultThresholds,
  formatBenchmarkTable,
} from './benchmark';
import {
  detectRegressions,
  formatRegressionReport,
  hasRegressions,
  loadBaseline,
} from './regression';

const BASELINE_PATH = path.join(import.meta.dir, 'baseline.json');

describe('sync performance', () => {
  let server: TestServer;
  const results: BenchmarkResult[] = [];
  const userId = 'perf-user';

  beforeAll(async () => {
    server = await createTestServer('sqlite');
  });

  afterAll(async () => {
    await server.destroy();

    // Print results
    console.log(`\n${formatBenchmarkTable(results)}`);

    // Check for regressions
    const baseline = await loadBaseline(BASELINE_PATH);
    const regressions = detectRegressions(results, baseline);
    console.log(`\n${formatRegressionReport(regressions)}`);
  });

  it('bootstrap 1K rows', async () => {
    const result = await benchmark(
      'bootstrap_1k',
      async () => {
        const testServer = await createTestServer('sqlite');
        await seedServerData(testServer, { userId, count: 1000 });

        const client = await createTestClient('bun-sqlite', testServer, {
          actorId: userId,
          clientId: `client-${Date.now()}`,
        });

        await syncPullOnce(client.db, client.transport, client.shapes, {
          clientId: `client-${Date.now()}`,
          subscriptions: [
            { id: 'my-tasks', shape: 'tasks', scopes: { user_id: userId } },
          ],
        });

        await client.destroy();
        await testServer.destroy();
      },
      { iterations: 5, warmup: 1 }
    );

    results.push(result);
    expect(result.median).toBeLessThan(defaultThresholds.bootstrap_1k);
  });

  it('bootstrap 10K rows', async () => {
    const result = await benchmark(
      'bootstrap_10k',
      async () => {
        const testServer = await createTestServer('sqlite');
        await seedServerData(testServer, { userId, count: 10000 });

        const client = await createTestClient('bun-sqlite', testServer, {
          actorId: userId,
          clientId: `client-${Date.now()}`,
        });

        await syncPullOnce(client.db, client.transport, client.shapes, {
          clientId: `client-${Date.now()}`,
          subscriptions: [
            { id: 'my-tasks', shape: 'tasks', scopes: { user_id: userId } },
          ],
        });

        await client.destroy();
        await testServer.destroy();
      },
      { iterations: 3, warmup: 1 }
    );

    results.push(result);
    expect(result.median).toBeLessThan(defaultThresholds.bootstrap_10k);
  });

  it('push single row', async () => {
    const testServer = await createTestServer('sqlite');
    const client = await createTestClient('bun-sqlite', testServer, {
      actorId: userId,
      clientId: 'push-client',
    });

    // Bootstrap first
    await syncPullOnce(client.db, client.transport, client.shapes, {
      clientId: 'push-client',
      subscriptions: [
        { id: 'my-tasks', shape: 'tasks', scopes: { user_id: userId } },
      ],
    });

    let counter = 0;

    const result = await benchmark(
      'push_single_row',
      async () => {
        counter++;
        await enqueueOutboxCommit(client.db, {
          operations: [
            {
              table: 'tasks',
              row_id: `perf-task-${counter}`,
              op: 'upsert',
              payload: { title: `Task ${counter}`, completed: 0 },
              base_version: null,
            },
          ],
        });

        await syncPushOnce(client.db, client.transport, {
          clientId: 'push-client',
        });
      },
      { iterations: 20, warmup: 3 }
    );

    await client.destroy();
    await testServer.destroy();

    results.push(result);
    expect(result.median).toBeLessThan(defaultThresholds.push_single_row);
  });

  it('push batch of 100 rows', async () => {
    const testServer = await createTestServer('sqlite');
    const client = await createTestClient('bun-sqlite', testServer, {
      actorId: userId,
      clientId: 'batch-client',
    });

    // Bootstrap first
    await syncPullOnce(client.db, client.transport, client.shapes, {
      clientId: 'batch-client',
      subscriptions: [
        { id: 'my-tasks', shape: 'tasks', scopes: { user_id: userId } },
      ],
    });

    let batchCounter = 0;

    const result = await benchmark(
      'push_batch_100',
      async () => {
        batchCounter++;
        const operations = Array.from({ length: 100 }, (_, i) => ({
          table: 'tasks',
          row_id: `batch-${batchCounter}-task-${i}`,
          op: 'upsert' as const,
          payload: { title: `Batch ${batchCounter} Task ${i}`, completed: 0 },
          base_version: null,
        }));

        await enqueueOutboxCommit(client.db, { operations });

        await syncPushOnce(client.db, client.transport, {
          clientId: 'batch-client',
        });
      },
      { iterations: 5, warmup: 1 }
    );

    await client.destroy();
    await testServer.destroy();

    results.push(result);
    expect(result.median).toBeLessThan(defaultThresholds.push_batch_100);
  });

  it('incremental pull', async () => {
    const testServer = await createTestServer('sqlite');
    const client = await createTestClient('bun-sqlite', testServer, {
      actorId: userId,
      clientId: 'pull-client',
    });

    // Bootstrap first
    await syncPullOnce(client.db, client.transport, client.shapes, {
      clientId: 'pull-client',
      subscriptions: [
        { id: 'my-tasks', shape: 'tasks', scopes: { user_id: userId } },
      ],
    });

    // Create some data to pull
    await seedServerData(testServer, { userId, count: 100 });

    const result = await benchmark(
      'incremental_pull',
      async () => {
        await syncPullOnce(client.db, client.transport, client.shapes, {
          clientId: 'pull-client',
          subscriptions: [
            { id: 'my-tasks', shape: 'tasks', scopes: { user_id: userId } },
          ],
        });
      },
      { iterations: 20, warmup: 3 }
    );

    await client.destroy();
    await testServer.destroy();

    results.push(result);
    expect(result.p99).toBeLessThan(defaultThresholds.incremental_pull_p99);
  });

  it('generates regression report', async () => {
    const baseline = await loadBaseline(BASELINE_PATH);
    const regressions = detectRegressions(results, baseline);

    // Log the report
    console.log(`\n${formatRegressionReport(regressions)}`);

    // Fail if regressions detected (disabled by default for initial setup)
    if (process.env.PERF_STRICT === 'true') {
      expect(hasRegressions(regressions)).toBe(false);
    }
  });
});
