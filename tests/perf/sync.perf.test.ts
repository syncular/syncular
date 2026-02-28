/**
 * Sync performance tests
 *
 * Measures key sync operations and detects performance regressions.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import path from 'node:path';
import {
  createClientHandler,
  enqueueOutboxCommit,
  type SyncClientDb,
  syncPullOnce,
  syncPushOnce,
} from '@syncular/client';
import {
  computePruneWatermarkCommitSeq,
  pruneSync,
  type SyncCoreDb,
} from '@syncular/server';
import {
  createHttpClientFixture,
  createHttpServerFixture,
  createProjectScopedTasksHandler,
  createTestClient,
  createTestServer,
  seedServerData,
  type TestServer,
  withTestClient,
  withTestServer,
} from '@syncular/testkit';
import { createHttpTransport } from '@syncular/transport-http';
import { createWebSocketTransport } from '@syncular/transport-ws';
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

interface TransportLaneServerDb extends SyncCoreDb {
  tasks: {
    id: string;
    title: string;
    completed: number;
    user_id: string;
    project_id: string;
    server_version: number;
  };
}

interface TransportLaneClientDb extends SyncClientDb {
  tasks: {
    id: string;
    title: string;
    completed: number;
    user_id: string;
    project_id: string;
    server_version: number;
  };
}

type TransportLane = 'direct' | 'relay' | 'ws';

function createTransportLaneSubscription(userId: string) {
  return {
    id: 'transport-lane-sub',
    table: 'tasks',
    scopes: { user_id: userId, project_id: 'p1' },
  } as const;
}

function createTransportLaneTransport(
  baseUrl: string,
  userId: string,
  lane: TransportLane,
  fetchImpl?: typeof globalThis.fetch
) {
  if (lane === 'ws') {
    return createWebSocketTransport({
      baseUrl,
      getHeaders: () => ({ 'x-actor-id': userId }),
      transportPath: 'direct',
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
    });
  }

  return createHttpTransport({
    baseUrl,
    getHeaders: () => ({ 'x-actor-id': userId }),
    transportPath: lane,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
}

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

  it('maintenance prune during active churn', async () => {
    const result = await withTestServer('sqlite', async (testServer) => {
      const writer = await createTestClient('bun-sqlite', testServer, {
        actorId: userId,
        clientId: 'maintenance-prune-writer',
      });
      let nextCommit = 1;

      const pushCommits = async (count: number) => {
        for (let i = 0; i < count; i += 1) {
          const commitId = `maintenance-prune-${nextCommit}`;
          const rowId = `maintenance-task-${nextCommit}`;
          const combined = await writer.transport.sync({
            clientId: writer.clientId,
            push: {
              clientCommitId: commitId,
              schemaVersion: 1,
              operations: [
                {
                  table: 'tasks',
                  row_id: rowId,
                  op: 'upsert',
                  payload: {
                    title: `Maintenance Task ${nextCommit}`,
                    completed: nextCommit % 2,
                  },
                  base_version: null,
                },
              ],
            },
          });
          if (combined.push?.status !== 'applied') {
            throw new Error(
              `Unexpected maintenance push status: ${combined.push?.status ?? 'missing'}`
            );
          }
          nextCommit += 1;
        }
      };

      try {
        await pushCommits(400);
        await testServer.db
          .updateTable('sync_commits')
          .set({ created_at: '2000-01-01T00:00:00.000Z' })
          .execute();

        return benchmark(
          'maintenance_prune',
          async () => {
            const watermark = await computePruneWatermarkCommitSeq(
              testServer.db,
              {
                activeWindowMs: 60 * 1000,
                fallbackMaxAgeMs: 60 * 1000,
                keepNewestCommits: 20,
              }
            );
            if (watermark <= 0) {
              throw new Error(
                `Expected prune watermark > 0, received ${watermark}`
              );
            }
            await pruneSync(testServer.db, {
              watermarkCommitSeq: watermark,
              keepNewestCommits: 20,
            });

            await pushCommits(80);
            await testServer.db
              .updateTable('sync_commits')
              .set({ created_at: '2000-01-01T00:00:00.000Z' })
              .execute();
          },
          { iterations: 4, warmup: 1 }
        );
      } finally {
        await writer.destroy();
      }
    });

    results.push(result);
    expect(result.p99).toBeLessThan(defaultThresholds.maintenance_prune_p99);
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

  it('reconnect storm convergence latency', async () => {
    const result = await withTestServer('sqlite', async (testServer) => {
      const reconnectClient = await createTestClient('bun-sqlite', testServer, {
        actorId: userId,
        clientId: 'storm-client',
      });
      const writerClient = await createTestClient('bun-sqlite', testServer, {
        actorId: userId,
        clientId: 'storm-writer',
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

        let burstIndex = 0;
        const reconnectStormBenchmark = await benchmark(
          'reconnect_storm',
          async () => {
            for (let burst = 0; burst < 6; burst += 1) {
              burstIndex += 1;
              for (let i = 0; i < 20; i += 1) {
                const combined = await writerClient.transport.sync({
                  clientId: writerClient.clientId,
                  push: {
                    clientCommitId: `storm-${burstIndex}-${i}`,
                    schemaVersion: 1,
                    operations: [
                      {
                        table: 'tasks',
                        row_id: `storm-task-${burstIndex}-${i}`,
                        op: 'upsert',
                        payload: {
                          title: `Storm Task ${burstIndex}-${i}`,
                          completed: (burst + i) % 2,
                        },
                        base_version: null,
                      },
                    ],
                  },
                });

                if (combined.push?.status !== 'applied') {
                  throw new Error(
                    `Unexpected reconnect storm push status: ${combined.push?.status ?? 'missing'}`
                  );
                }
              }

              for (let pullAttempt = 0; pullAttempt < 3; pullAttempt += 1) {
                await syncPullOnce(
                  reconnectClient.db,
                  reconnectClient.transport,
                  reconnectClient.handlers,
                  {
                    clientId: reconnectClient.clientId,
                    subscriptions: [subscription],
                    limitCommits: 40,
                  }
                );
              }
            }

            const finalPull = await syncPullOnce(
              reconnectClient.db,
              reconnectClient.transport,
              reconnectClient.handlers,
              {
                clientId: reconnectClient.clientId,
                subscriptions: [subscription],
                limitCommits: 500,
              }
            );
            const sub = finalPull.subscriptions.find(
              (entry) => entry.id === subscription.id
            );
            if (sub?.status !== 'active') {
              throw new Error(
                'Expected reconnect storm subscription to stay active'
              );
            }
          },
          { iterations: 4, warmup: 1 }
        );

        return reconnectStormBenchmark;
      } finally {
        await writerClient.destroy();
        await reconnectClient.destroy();
      }
    });

    results.push(result);
    expect(result.p99).toBeLessThan(defaultThresholds.reconnect_storm_p99);
  });

  it('pglite concurrent push contention', async () => {
    const result = await withTestServer('pglite', async (testServer) => {
      const writerCount = 8;
      const opsPerWriter = 10;
      const writers = await Promise.all(
        Array.from({ length: writerCount }, (_, i) =>
          createTestClient('bun-sqlite', testServer, {
            actorId: userId,
            clientId: `pglite-contention-writer-${i + 1}`,
          })
        )
      );

      let round = 0;

      try {
        const contentionBenchmark = await benchmark(
          'pglite_push_contention',
          async () => {
            round += 1;
            const responses = await Promise.all(
              writers.map((writer, writerIndex) =>
                writer.transport.sync({
                  clientId: writer.clientId,
                  push: {
                    clientCommitId: `pglite-contention-${round}-${writerIndex + 1}`,
                    schemaVersion: 1,
                    operations: Array.from(
                      { length: opsPerWriter },
                      (_, opIndex) => ({
                        table: 'tasks',
                        row_id: `pglite-contention-task-${round}-${writerIndex + 1}-${opIndex + 1}`,
                        op: 'upsert' as const,
                        payload: {
                          title: `Pglite contention ${round}-${writerIndex + 1}-${opIndex + 1}`,
                          completed: (round + opIndex) % 2,
                        },
                        base_version: null,
                      })
                    ),
                  },
                })
              )
            );

            for (const response of responses) {
              if (response.push?.status !== 'applied') {
                throw new Error(
                  `Unexpected pglite contention push status: ${response.push?.status ?? 'missing'}`
                );
              }
            }
          },
          { iterations: 6, warmup: 1 }
        );

        return contentionBenchmark;
      } finally {
        for (const writer of writers) {
          await writer.destroy();
        }
      }
    });

    results.push(result);
    expect(result.p99).toBeLessThan(
      defaultThresholds.pglite_push_contention_p99
    );
  });

  it('transport lane catchup latency (direct/relay/ws)', async () => {
    const nativeFetch = (
      globalThis as { __nativeFetch?: typeof globalThis.fetch }
    ).__nativeFetch;
    const subscription = createTransportLaneSubscription(userId);

    const transportServer =
      await createHttpServerFixture<TransportLaneServerDb>({
        serverDialect: 'sqlite',
        createTables: async (db) => {
          await db.schema
            .createTable('tasks')
            .ifNotExists()
            .addColumn('id', 'text', (col) => col.primaryKey())
            .addColumn('title', 'text', (col) => col.notNull())
            .addColumn('completed', 'integer', (col) =>
              col.notNull().defaultTo(0)
            )
            .addColumn('user_id', 'text', (col) => col.notNull())
            .addColumn('project_id', 'text', (col) => col.notNull())
            .addColumn('server_version', 'integer', (col) =>
              col.notNull().defaultTo(1)
            )
            .execute();
        },
        handlers: [createProjectScopedTasksHandler<TransportLaneServerDb>()],
        authenticate: async (c) => {
          const actorId = c.req.header('x-actor-id');
          return actorId ? { actorId } : null;
        },
        sync: {
          rateLimit: false,
        },
      });

    const createLaneClient = async (clientId: string) =>
      createHttpClientFixture<TransportLaneClientDb>({
        clientDialect: 'bun-sqlite',
        baseUrl: transportServer.baseUrl,
        actorId: userId,
        clientId,
        createTables: async (db) => {
          await db.schema
            .createTable('tasks')
            .ifNotExists()
            .addColumn('id', 'text', (col) => col.primaryKey())
            .addColumn('title', 'text', (col) => col.notNull())
            .addColumn('completed', 'integer', (col) =>
              col.notNull().defaultTo(0)
            )
            .addColumn('user_id', 'text', (col) => col.notNull())
            .addColumn('project_id', 'text', (col) => col.notNull())
            .addColumn('server_version', 'integer', (col) =>
              col.notNull().defaultTo(0)
            )
            .execute();
        },
        registerHandlers: (handlers) => {
          handlers.push(
            createClientHandler<TransportLaneClientDb, 'tasks'>({
              table: 'tasks',
              scopes: ['user:{user_id}', 'project:{project_id}'],
              versionColumn: 'server_version',
            })
          );
        },
        ...(nativeFetch ? { fetch: nativeFetch } : {}),
      });

    const writer = await createLaneClient('transport-lane-writer');
    const directClient = await createLaneClient('transport-lane-direct');
    const relayClient = await createLaneClient('transport-lane-relay');
    const wsClient = await createLaneClient('transport-lane-ws');

    const writerTransport = createHttpTransport({
      baseUrl: transportServer.baseUrl,
      getHeaders: () => ({ 'x-actor-id': userId }),
      transportPath: 'direct',
      ...(nativeFetch ? { fetch: nativeFetch } : {}),
    });
    const directTransport = createTransportLaneTransport(
      transportServer.baseUrl,
      userId,
      'direct',
      nativeFetch
    );
    const relayTransport = createTransportLaneTransport(
      transportServer.baseUrl,
      userId,
      'relay',
      nativeFetch
    );
    const wsTransport = createTransportLaneTransport(
      transportServer.baseUrl,
      userId,
      'ws',
      nativeFetch
    );

    const runLaneBenchmark = async (
      metricName:
        | 'transport_direct_catchup'
        | 'transport_relay_catchup'
        | 'transport_ws_catchup',
      laneClient: Awaited<ReturnType<typeof createLaneClient>>,
      laneTransport:
        | ReturnType<typeof createHttpTransport>
        | ReturnType<typeof createWebSocketTransport>,
      threshold: number
    ) => {
      let batchIndex = 0;
      const result = await benchmark(
        metricName,
        async () => {
          batchIndex += 1;
          for (let i = 0; i < 80; i += 1) {
            const combined = await writerTransport.sync({
              clientId: writer.clientId,
              push: {
                clientCommitId: `${metricName}-${batchIndex}-${i}`,
                schemaVersion: 1,
                operations: [
                  {
                    table: 'tasks',
                    row_id: `${metricName}-task-${batchIndex}-${i}`,
                    op: 'upsert',
                    payload: {
                      title: `Transport ${metricName} ${batchIndex}-${i}`,
                      completed: (batchIndex + i) % 2,
                      project_id: 'p1',
                    },
                    base_version: null,
                  },
                ],
              },
            });
            if (combined.push?.status !== 'applied') {
              throw new Error(
                `Unexpected transport push status: ${combined.push?.status ?? 'missing'}`
              );
            }
          }

          const pull = await syncPullOnce(
            laneClient.db,
            laneTransport,
            laneClient.handlers,
            {
              clientId: laneClient.clientId,
              subscriptions: [subscription],
              limitCommits: 500,
            }
          );
          const sub = pull.subscriptions.find(
            (entry) => entry.id === subscription.id
          );
          if (sub?.status !== 'active') {
            throw new Error(
              `Expected active subscription for ${metricName}, received ${sub?.status ?? 'missing'}`
            );
          }
        },
        { iterations: 4, warmup: 1 }
      );

      results.push(result);
      expect(result.p99).toBeLessThan(threshold);
    };

    const drainLaneCatchup = async (
      metricName: string,
      laneClient: Awaited<ReturnType<typeof createLaneClient>>,
      laneTransport:
        | ReturnType<typeof createHttpTransport>
        | ReturnType<typeof createWebSocketTransport>
    ) => {
      const maxAttempts = 40;
      let stableCursorPulls = 0;
      let previousCursor: number | null = null;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const pull = await syncPullOnce(
          laneClient.db,
          laneTransport,
          laneClient.handlers,
          {
            clientId: laneClient.clientId,
            subscriptions: [subscription],
            limitCommits: 500,
          }
        );
        const sub = pull.subscriptions.find(
          (entry) => entry.id === subscription.id
        );
        if (sub?.status !== 'active') {
          throw new Error(
            `Expected active subscription while draining ${metricName}, received ${sub?.status ?? 'missing'}`
          );
        }

        const hasPendingCommits = sub.commits.length > 0;
        const hasPendingSnapshots = (sub.snapshots?.length ?? 0) > 0;
        if (!hasPendingCommits && !hasPendingSnapshots) {
          stableCursorPulls =
            sub.nextCursor === previousCursor ? stableCursorPulls + 1 : 1;
          previousCursor = sub.nextCursor;
          if (stableCursorPulls >= 2) {
            return;
          }
          continue;
        }

        stableCursorPulls = 0;
        previousCursor = sub.nextCursor;
      }

      throw new Error(
        `Failed to drain ${metricName} within ${maxAttempts} pull attempts`
      );
    };

    try {
      await syncPullOnce(
        directClient.db,
        directTransport,
        directClient.handlers,
        {
          clientId: directClient.clientId,
          subscriptions: [subscription],
        }
      );
      await syncPullOnce(relayClient.db, relayTransport, relayClient.handlers, {
        clientId: relayClient.clientId,
        subscriptions: [subscription],
      });
      await syncPullOnce(wsClient.db, wsTransport, wsClient.handlers, {
        clientId: wsClient.clientId,
        subscriptions: [subscription],
      });

      await runLaneBenchmark(
        'transport_direct_catchup',
        directClient,
        directTransport,
        defaultThresholds.transport_direct_catchup_p99
      );
      await runLaneBenchmark(
        'transport_relay_catchup',
        relayClient,
        relayTransport,
        defaultThresholds.transport_relay_catchup_p99
      );
      await runLaneBenchmark(
        'transport_ws_catchup',
        wsClient,
        wsTransport,
        defaultThresholds.transport_ws_catchup_p99
      );

      await drainLaneCatchup(
        'transport_direct_catchup',
        directClient,
        directTransport
      );
      await drainLaneCatchup(
        'transport_relay_catchup',
        relayClient,
        relayTransport
      );
      await drainLaneCatchup('transport_ws_catchup', wsClient, wsTransport);

      const serverCount = await transportServer.db
        .selectFrom('tasks')
        .select(({ fn }) => fn.countAll().as('total'))
        .where('id', 'like', 'transport_%')
        .executeTakeFirst();
      const directCount = await directClient.db
        .selectFrom('tasks')
        .select(({ fn }) => fn.countAll().as('total'))
        .where('id', 'like', 'transport_%')
        .executeTakeFirst();
      const relayCount = await relayClient.db
        .selectFrom('tasks')
        .select(({ fn }) => fn.countAll().as('total'))
        .where('id', 'like', 'transport_%')
        .executeTakeFirst();
      const wsCount = await wsClient.db
        .selectFrom('tasks')
        .select(({ fn }) => fn.countAll().as('total'))
        .where('id', 'like', 'transport_%')
        .executeTakeFirst();

      const expectedTotal = Number(serverCount?.total ?? 0);
      expect(Number(directCount?.total ?? 0)).toBe(expectedTotal);
      expect(Number(relayCount?.total ?? 0)).toBe(expectedTotal);
      expect(Number(wsCount?.total ?? 0)).toBe(expectedTotal);
    } finally {
      await wsClient.destroy();
      await relayClient.destroy();
      await directClient.destroy();
      await writer.destroy();
      await transportServer.destroy();
    }
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
