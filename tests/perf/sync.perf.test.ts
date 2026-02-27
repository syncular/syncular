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
import { computePruneWatermarkCommitSeq, pruneSync } from '@syncular/server';
import {
  createTestClient,
  createTestServer,
  seedServerData,
  type TestServer,
  withTestClient,
  withTestServer,
} from '@syncular/testkit';
import {
  type BenchmarkResult,
  benchmark,
  defaultThresholds,
  formatBenchmarkTable,
} from './benchmark';
import {
  detectRegressions,
  formatRegressionReport,
  hasMissingBaselines,
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
        await withTestServer('sqlite', async (testServer) => {
          await seedServerData(testServer, { userId, count: 1000 });

          await withTestClient(
            'bun-sqlite',
            testServer,
            {
              actorId: userId,
              clientId: `client-${Date.now()}`,
            },
            async (client) => {
              await syncPullOnce(client.db, client.transport, client.handlers, {
                clientId: `client-${Date.now()}`,
                subscriptions: [
                  {
                    id: 'my-tasks',
                    table: 'tasks',
                    scopes: { user_id: userId },
                  },
                ],
              });
            }
          );
        });
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
        await withTestServer('sqlite', async (testServer) => {
          await seedServerData(testServer, { userId, count: 10000 });

          await withTestClient(
            'bun-sqlite',
            testServer,
            {
              actorId: userId,
              clientId: `client-${Date.now()}`,
            },
            async (client) => {
              await syncPullOnce(client.db, client.transport, client.handlers, {
                clientId: `client-${Date.now()}`,
                subscriptions: [
                  {
                    id: 'my-tasks',
                    table: 'tasks',
                    scopes: { user_id: userId },
                  },
                ],
              });
            }
          );
        });
      },
      { iterations: 3, warmup: 1 }
    );

    results.push(result);
    expect(result.median).toBeLessThan(defaultThresholds.bootstrap_10k);
  });

  it('forced rebootstrap after prune', async () => {
    const result = await withTestServer('sqlite', async (testServer) => {
      const writerClient = await createTestClient('bun-sqlite', testServer, {
        actorId: userId,
        clientId: 'rebootstrap-writer',
      });
      const fastClient = await createTestClient('bun-sqlite', testServer, {
        actorId: userId,
        clientId: 'rebootstrap-fast',
      });
      const laggingClient = await createTestClient('bun-sqlite', testServer, {
        actorId: userId,
        clientId: 'rebootstrap-lagging',
      });

      const subscription = {
        id: 'my-tasks',
        table: 'tasks',
        scopes: { user_id: userId },
      } as const;

      try {
        const totalCommits = 2_000;
        for (let i = 1; i <= totalCommits; i++) {
          const combined = await writerClient.transport.sync({
            clientId: writerClient.clientId,
            push: {
              clientCommitId: `rebootstrap-seed-${i}`,
              schemaVersion: 1,
              operations: [
                {
                  table: 'tasks',
                  row_id: `rebootstrap-task-${i}`,
                  op: 'upsert',
                  payload: {
                    title: `Rebootstrap Task ${i}`,
                    completed: i % 2,
                  },
                  base_version: null,
                },
              ],
            },
          });
          if (combined.push?.status !== 'applied') {
            throw new Error(
              `Unexpected seed push status: ${combined.push?.status ?? 'missing'}`
            );
          }
        }

        await syncPullOnce(
          fastClient.db,
          fastClient.transport,
          fastClient.handlers,
          {
            clientId: fastClient.clientId,
            subscriptions: [subscription],
            limitCommits: 500,
          }
        );

        const watermark = await computePruneWatermarkCommitSeq(testServer.db, {
          activeWindowMs: 24 * 60 * 60 * 1000,
          keepNewestCommits: 40,
        });
        if (watermark <= 0) {
          throw new Error(
            `Expected prune watermark > 0, received ${watermark}`
          );
        }

        const pruned = await pruneSync(testServer.db, {
          watermarkCommitSeq: watermark,
          keepNewestCommits: 40,
        });
        if (pruned <= 0) {
          throw new Error('Expected pruneSync to delete at least one commit');
        }

        const rebuildState = async () => {
          await laggingClient.db.deleteFrom('tasks').execute();
          await laggingClient.db
            .deleteFrom('sync_subscription_state')
            .where('state_id', '=', 'default')
            .where('subscription_id', '=', subscription.id)
            .execute();
          await laggingClient.db
            .insertInto('sync_subscription_state')
            .values({
              state_id: 'default',
              subscription_id: subscription.id,
              table: subscription.table,
              scopes_json: JSON.stringify(subscription.scopes),
              params_json: JSON.stringify({}),
              cursor: 0,
              bootstrap_state_json: null,
              status: 'active',
              created_at: Date.now(),
              updated_at: Date.now(),
            })
            .execute();
        };

        const rebootstrapBenchmark = await benchmark(
          'rebootstrap_after_prune',
          async () => {
            await rebuildState();
            const pull = await syncPullOnce(
              laggingClient.db,
              laggingClient.transport,
              laggingClient.handlers,
              {
                clientId: laggingClient.clientId,
                subscriptions: [subscription],
                limitCommits: 500,
              }
            );
            const sub = pull.subscriptions.find(
              (entry) => entry.id === subscription.id
            );
            if (!sub?.bootstrap) {
              throw new Error('Expected forced bootstrap for lagging cursor');
            }
          },
          { iterations: 5, warmup: 1 }
        );
        return rebootstrapBenchmark;
      } finally {
        await laggingClient.destroy();
        await fastClient.destroy();
        await writerClient.destroy();
      }
    });

    results.push(result);
    expect(result.p99).toBeLessThan(
      defaultThresholds.rebootstrap_after_prune_p99
    );
  });

  it('push single row', async () => {
    const result = await withTestServer('sqlite', async (testServer) =>
      withTestClient(
        'bun-sqlite',
        testServer,
        {
          actorId: userId,
          clientId: 'push-client',
        },
        async (client) => {
          await syncPullOnce(client.db, client.transport, client.handlers, {
            clientId: 'push-client',
            subscriptions: [
              { id: 'my-tasks', table: 'tasks', scopes: { user_id: userId } },
            ],
          });

          let counter = 0;

          return benchmark(
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
        }
      )
    );

    results.push(result);
    expect(result.median).toBeLessThan(defaultThresholds.push_single_row);
  });

  it('push batch of 100 rows', async () => {
    const result = await withTestServer('sqlite', async (testServer) =>
      withTestClient(
        'bun-sqlite',
        testServer,
        {
          actorId: userId,
          clientId: 'batch-client',
        },
        async (client) => {
          await syncPullOnce(client.db, client.transport, client.handlers, {
            clientId: 'batch-client',
            subscriptions: [
              { id: 'my-tasks', table: 'tasks', scopes: { user_id: userId } },
            ],
          });

          let batchCounter = 0;

          return benchmark(
            'push_batch_100',
            async () => {
              batchCounter++;
              const operations = Array.from({ length: 100 }, (_, i) => ({
                table: 'tasks',
                row_id: `batch-${batchCounter}-task-${i}`,
                op: 'upsert' as const,
                payload: {
                  title: `Batch ${batchCounter} Task ${i}`,
                  completed: 0,
                },
                base_version: null,
              }));

              await enqueueOutboxCommit(client.db, { operations });

              await syncPushOnce(client.db, client.transport, {
                clientId: 'batch-client',
              });
            },
            { iterations: 5, warmup: 1 }
          );
        }
      )
    );

    results.push(result);
    expect(result.median).toBeLessThan(defaultThresholds.push_batch_100);
  });

  it('incremental pull', async () => {
    const result = await withTestServer('sqlite', async (testServer) =>
      withTestClient(
        'bun-sqlite',
        testServer,
        {
          actorId: userId,
          clientId: 'pull-client',
        },
        async (client) => {
          await syncPullOnce(client.db, client.transport, client.handlers, {
            clientId: 'pull-client',
            subscriptions: [
              { id: 'my-tasks', table: 'tasks', scopes: { user_id: userId } },
            ],
          });

          await seedServerData(testServer, { userId, count: 100 });

          return benchmark(
            'incremental_pull',
            async () => {
              await syncPullOnce(client.db, client.transport, client.handlers, {
                clientId: 'pull-client',
                subscriptions: [
                  {
                    id: 'my-tasks',
                    table: 'tasks',
                    scopes: { user_id: userId },
                  },
                ],
              });
            },
            { iterations: 20, warmup: 3 }
          );
        }
      )
    );

    results.push(result);
    expect(result.p99).toBeLessThan(defaultThresholds.incremental_pull_p99);
  });

  it('reconnect catchup after queued commit backlog', async () => {
    const result = await withTestServer('sqlite', async (testServer) => {
      const reconnectClient = await createTestClient('bun-sqlite', testServer, {
        actorId: userId,
        clientId: 'reconnect-client',
      });
      const writerClient = await createTestClient('bun-sqlite', testServer, {
        actorId: userId,
        clientId: 'reconnect-writer',
      });

      const subscription = {
        id: 'my-tasks',
        table: 'tasks',
        scopes: { user_id: userId },
      } as const;

      try {
        await syncPullOnce(
          reconnectClient.db,
          reconnectClient.transport,
          reconnectClient.handlers,
          {
            clientId: reconnectClient.clientId,
            subscriptions: [subscription],
          }
        );

        let batchIndex = 0;

        const reconnectBenchmark = await benchmark(
          'reconnect_catchup',
          async () => {
            batchIndex += 1;

            for (let i = 0; i < 100; i++) {
              const commitId = `reconnect-${batchIndex}-${i}`;
              const rowId = `reconnect-task-${batchIndex}-${i}`;
              const combined = await writerClient.transport.sync({
                clientId: writerClient.clientId,
                push: {
                  clientCommitId: commitId,
                  schemaVersion: 1,
                  operations: [
                    {
                      table: 'tasks',
                      row_id: rowId,
                      op: 'upsert',
                      payload: {
                        title: `Reconnect Task ${batchIndex}-${i}`,
                        completed: 0,
                      },
                      base_version: null,
                    },
                  ],
                },
              });

              if (combined.push?.status !== 'applied') {
                throw new Error(
                  `Unexpected reconnect benchmark push status: ${combined.push?.status ?? 'missing'}`
                );
              }
            }

            await syncPullOnce(
              reconnectClient.db,
              reconnectClient.transport,
              reconnectClient.handlers,
              {
                clientId: reconnectClient.clientId,
                subscriptions: [subscription],
                limitCommits: 500,
              }
            );
          },
          { iterations: 5, warmup: 1 }
        );
        return reconnectBenchmark;
      } finally {
        await writerClient.destroy();
        await reconnectClient.destroy();
      }
    });

    results.push(result);
    expect(result.p99).toBeLessThan(defaultThresholds.reconnect_catchup_p99);
  });

  it('generates regression report', async () => {
    const baseline = await loadBaseline(BASELINE_PATH);
    const regressions = detectRegressions(results, baseline);
    const hasRegression = hasRegressions(regressions);
    const hasMissingBaseline = hasMissingBaselines(regressions);

    // Log the report
    console.log(`\n${formatRegressionReport(regressions)}`);
    // Machine-readable markers for CI gating.
    console.log(
      `PERF_GATE_SYNC_REGRESSION=${hasRegression ? 'true' : 'false'}`
    );
    console.log(
      `PERF_GATE_SYNC_MISSING_BASELINE=${hasMissingBaseline ? 'true' : 'false'}`
    );

    // Fail if regressions detected (disabled by default for initial setup)
    if (process.env.PERF_STRICT === 'true') {
      expect(hasRegression).toBe(false);
      expect(hasMissingBaseline).toBe(false);
    }
  });
});
