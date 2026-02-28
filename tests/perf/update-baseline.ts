#!/usr/bin/env bun
/**
 * Update performance baselines
 *
 * Run this script after intentional performance changes to update
 * the baseline values used for regression detection.
 *
 * Usage: bun run tests/perf/update-baseline.ts
 */

import path from 'node:path';
import {
  createClientHandler,
  enqueueOutboxCommit,
  type SyncClientDb,
  syncPullOnce,
  syncPushOnce,
} from '@syncular/client';
import { createDatabase } from '@syncular/core';
import { createBunSqliteDialect } from '@syncular/dialect-bun-sqlite';
import { createLibsqlDialect } from '@syncular/dialect-libsql';
import { createPgliteDialect } from '@syncular/dialect-pglite';
import { createSqlite3Dialect } from '@syncular/dialect-sqlite3';
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
} from '@syncular/testkit';
import { createConformanceColumnCodecsPlugin } from '@syncular/tests-dialects/column-codecs';
import type { DialectConformanceDb } from '@syncular/tests-dialects/conformance-db';
import { createConformanceSchema } from '@syncular/tests-dialects/schema';
import { createHttpTransport } from '@syncular/transport-http';
import { createWebSocketTransport } from '@syncular/transport-ws';
import { Kysely } from 'kysely';
import {
  type BenchmarkResult,
  benchmark,
  formatBenchmarkTable,
} from './benchmark';
import type { Baseline } from './regression';

const REPO_ROOT = path.resolve(import.meta.dir, '..', '..');
const BASELINE_PATH = path.join(import.meta.dir, 'baseline.json');

async function resolveGitCommitSha(): Promise<string | null> {
  const proc = Bun.spawn(['git', 'rev-parse', 'HEAD'], {
    cwd: REPO_ROOT,
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) return null;
  const sha = stdout.trim();
  return sha.length > 0 ? sha : null;
}

/**
 * Save baseline to file
 */
async function saveBaseline(
  filePath: string,
  results: BenchmarkResult[]
): Promise<void> {
  const baseline: Baseline = {};
  const timestamp = new Date().toISOString();
  const commit =
    process.env.GITHUB_SHA ?? (await resolveGitCommitSha()) ?? 'local';
  const source = process.env.GITHUB_ACTIONS === 'true' ? 'ci' : 'local';
  const environment = {
    platform: process.platform,
    arch: process.arch,
    bunVersion: Bun.version,
    runnerOs: process.env.RUNNER_OS,
    runnerName: process.env.RUNNER_NAME,
  };

  for (const result of results) {
    baseline[result.name] = {
      median: result.median,
      p95: result.p95,
      p99: result.p99,
      timestamp,
      commit,
      source,
      environment,
    };
  }

  await Bun.write(filePath, JSON.stringify(baseline, null, 2));
}
const userId = 'perf-user';

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

interface PerfDialect {
  name: string;
  kind: 'sqlite' | 'postgres';
  createDb(): Promise<Kysely<DialectConformanceDb>>;
}

const PERF_DIALECTS: PerfDialect[] = [
  {
    name: 'bun-sqlite',
    kind: 'sqlite',
    async createDb() {
      return new Kysely<DialectConformanceDb>({
        dialect: createBunSqliteDialect({ path: ':memory:' }),
        plugins: [createConformanceColumnCodecsPlugin('sqlite')],
      });
    },
  },
  {
    name: 'sqlite3',
    kind: 'sqlite',
    async createDb() {
      return createDatabase<DialectConformanceDb>({
        dialect: createSqlite3Dialect({
          path: ':memory:',
        }),
        family: 'sqlite',
      }).withPlugin(createConformanceColumnCodecsPlugin('sqlite'));
    },
  },
  {
    name: 'pglite',
    kind: 'postgres',
    async createDb() {
      return new Kysely<DialectConformanceDb>({
        dialect: createPgliteDialect(),
        plugins: [createConformanceColumnCodecsPlugin('postgres')],
      });
    },
  },
  {
    name: 'libsql',
    kind: 'sqlite',
    async createDb() {
      return createDatabase<DialectConformanceDb>({
        dialect: createLibsqlDialect({
          url: ':memory:',
        }),
        family: 'sqlite',
      }).withPlugin(createConformanceColumnCodecsPlugin('sqlite'));
    },
  },
];

function buildDialectRows(kind: PerfDialect['kind'], count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `p-${i}`,
    n_int: i,
    n_bigint: kind === 'sqlite' ? i : BigInt(i),
    bigint_text: String(BigInt(i)),
    t_text: `row-${i}`,
    u_unique: `u-${i}`,
    b_bool: i % 2 === 0,
    j_json: { i } as const,
    j_large: { i, large: true } as const,
    d_date: new Date('2025-01-01T00:00:00.000Z'),
    bytes: new Uint8Array([i % 256]),
    nullable_text: null,
    nullable_int: null,
    nullable_bigint: null,
    nullable_bool: null,
    nullable_bytes: null,
    nullable_json: null,
    nullable_date: null,
  }));
}

async function insertDialectRowsChunked(
  db: Kysely<DialectConformanceDb>,
  rows: Array<DialectConformanceDb['dialect_conformance']>,
  chunkSize: number
): Promise<void> {
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    await db.insertInto('dialect_conformance').values(chunk).execute();
  }
}

async function runBenchmarks(): Promise<BenchmarkResult[]> {
  const results: BenchmarkResult[] = [];

  console.log('Running performance benchmarks...\n');

  // Bootstrap 1K
  console.log('  Running: bootstrap_1k');
  const bootstrap1k = await benchmark(
    'bootstrap_1k',
    async () => {
      const testServer = await createTestServer('sqlite');
      await seedServerData(testServer, { userId, count: 1000 });

      const client = await createTestClient('bun-sqlite', testServer, {
        actorId: userId,
        clientId: `client-${Date.now()}`,
      });

      await syncPullOnce(client.db, client.transport, client.handlers, {
        clientId: `client-${Date.now()}`,
        subscriptions: [
          { id: 'my-tasks', table: 'tasks', scopes: { user_id: userId } },
        ],
      });

      await client.destroy();
      await testServer.destroy();
    },
    { iterations: 5, warmup: 1 }
  );
  results.push(bootstrap1k);

  // Bootstrap 10K
  console.log('  Running: bootstrap_10k');
  const bootstrap10k = await benchmark(
    'bootstrap_10k',
    async () => {
      const testServer = await createTestServer('sqlite');
      await seedServerData(testServer, { userId, count: 10000 });

      const client = await createTestClient('bun-sqlite', testServer, {
        actorId: userId,
        clientId: `client-${Date.now()}`,
      });

      await syncPullOnce(client.db, client.transport, client.handlers, {
        clientId: `client-${Date.now()}`,
        subscriptions: [
          { id: 'my-tasks', table: 'tasks', scopes: { user_id: userId } },
        ],
      });

      await client.destroy();
      await testServer.destroy();
    },
    { iterations: 3, warmup: 1 }
  );
  results.push(bootstrap10k);

  // Forced rebootstrap after prune
  console.log('  Running: rebootstrap_after_prune');
  {
    const testServer = await createTestServer('sqlite');
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
      throw new Error(`Expected prune watermark > 0, received ${watermark}`);
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

    const result = await benchmark(
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

    await laggingClient.destroy();
    await fastClient.destroy();
    await writerClient.destroy();
    await testServer.destroy();
    results.push(result);
  }

  // Push single row
  console.log('  Running: push_single_row');
  {
    const testServer = await createTestServer('sqlite');
    const client = await createTestClient('bun-sqlite', testServer, {
      actorId: userId,
      clientId: 'push-client',
    });

    await syncPullOnce(client.db, client.transport, client.handlers, {
      clientId: 'push-client',
      subscriptions: [
        { id: 'my-tasks', table: 'tasks', scopes: { user_id: userId } },
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
  }

  // Push batch 100
  console.log('  Running: push_batch_100');
  {
    const testServer = await createTestServer('sqlite');
    const client = await createTestClient('bun-sqlite', testServer, {
      actorId: userId,
      clientId: 'batch-client',
    });

    await syncPullOnce(client.db, client.transport, client.handlers, {
      clientId: 'batch-client',
      subscriptions: [
        { id: 'my-tasks', table: 'tasks', scopes: { user_id: userId } },
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
  }

  // Maintenance prune under active churn
  console.log('  Running: maintenance_prune');
  {
    const testServer = await createTestServer('sqlite');
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

      const result = await benchmark(
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
      results.push(result);
    } finally {
      await writer.destroy();
      await testServer.destroy();
    }
  }

  // Incremental pull
  console.log('  Running: incremental_pull');
  {
    const testServer = await createTestServer('sqlite');
    const client = await createTestClient('bun-sqlite', testServer, {
      actorId: userId,
      clientId: 'pull-client',
    });

    await syncPullOnce(client.db, client.transport, client.handlers, {
      clientId: 'pull-client',
      subscriptions: [
        { id: 'my-tasks', table: 'tasks', scopes: { user_id: userId } },
      ],
    });

    await seedServerData(testServer, { userId, count: 100 });

    const result = await benchmark(
      'incremental_pull',
      async () => {
        await syncPullOnce(client.db, client.transport, client.handlers, {
          clientId: 'pull-client',
          subscriptions: [
            { id: 'my-tasks', table: 'tasks', scopes: { user_id: userId } },
          ],
        });
      },
      { iterations: 20, warmup: 3 }
    );

    await client.destroy();
    await testServer.destroy();
    results.push(result);
  }

  // Reconnect catchup
  console.log('  Running: reconnect_catchup');
  {
    const testServer = await createTestServer('sqlite');
    const reconnectClient = await createTestClient('bun-sqlite', testServer, {
      actorId: userId,
      clientId: 'reconnect-client',
    });
    const writerClient = await createTestClient('bun-sqlite', testServer, {
      actorId: userId,
      clientId: 'reconnect-writer',
    });

    await syncPullOnce(
      reconnectClient.db,
      reconnectClient.transport,
      reconnectClient.handlers,
      {
        clientId: reconnectClient.clientId,
        subscriptions: [
          { id: 'my-tasks', table: 'tasks', scopes: { user_id: userId } },
        ],
      }
    );

    let batchIndex = 0;

    const result = await benchmark(
      'reconnect_catchup',
      async () => {
        batchIndex += 1;

        for (let i = 0; i < 100; i++) {
          const commitId = `reconnect-${batchIndex}-${i}`;
          const rowId = `reconnect-task-${batchIndex}-${i}`;

          await writerClient.transport.sync({
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
        }

        await syncPullOnce(
          reconnectClient.db,
          reconnectClient.transport,
          reconnectClient.handlers,
          {
            clientId: reconnectClient.clientId,
            subscriptions: [
              { id: 'my-tasks', table: 'tasks', scopes: { user_id: userId } },
            ],
            limitCommits: 500,
          }
        );
      },
      { iterations: 5, warmup: 1 }
    );

    await writerClient.destroy();
    await reconnectClient.destroy();
    await testServer.destroy();
    results.push(result);
  }

  // Reconnect storm
  console.log('  Running: reconnect_storm');
  {
    const testServer = await createTestServer('sqlite');
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
    const result = await benchmark(
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

    await writerClient.destroy();
    await reconnectClient.destroy();
    await testServer.destroy();
    results.push(result);
  }

  // Pglite concurrent push contention
  console.log('  Running: pglite_push_contention');
  {
    const testServer = await createTestServer('pglite');
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
      const result = await benchmark(
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
      results.push(result);
    } finally {
      for (const writer of writers) {
        await writer.destroy();
      }
      await testServer.destroy();
    }
  }

  // Transport lane catchup parity (direct/relay/ws)
  console.log('  Running: transport lane catchup benchmarks');
  {
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
        | ReturnType<typeof createWebSocketTransport>
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
        directTransport
      );
      await runLaneBenchmark(
        'transport_relay_catchup',
        relayClient,
        relayTransport
      );
      await runLaneBenchmark('transport_ws_catchup', wsClient, wsTransport);

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
      if (
        Number(directCount?.total ?? 0) !== expectedTotal ||
        Number(relayCount?.total ?? 0) !== expectedTotal ||
        Number(wsCount?.total ?? 0) !== expectedTotal
      ) {
        throw new Error(
          `Transport lane benchmark mismatch: expected ${expectedTotal}, direct=${Number(directCount?.total ?? 0)}, relay=${Number(relayCount?.total ?? 0)}, ws=${Number(wsCount?.total ?? 0)}`
        );
      }
    } finally {
      await wsClient.destroy();
      await relayClient.destroy();
      await directClient.destroy();
      await writer.destroy();
      await transportServer.destroy();
    }
  }

  // Dialect perf
  console.log('  Running: dialect benchmarks');
  for (const dialect of PERF_DIALECTS) {
    console.log(`    Running: dialect_${dialect.name}_insert_10k`);
    {
      const result = await benchmark(
        `dialect_${dialect.name}_insert_10k`,
        async () => {
          const db = await dialect.createDb();
          try {
            await createConformanceSchema(db, dialect.kind);
            await insertDialectRowsChunked(
              db,
              buildDialectRows(dialect.kind, 10_000),
              500
            );
          } finally {
            await db.destroy();
          }
        },
        { iterations: 1, warmup: 0, trackMemory: true }
      );
      results.push(result);
    }

    console.log(`    Running: dialect_${dialect.name}_select_10k`);
    {
      const db = await dialect.createDb();
      try {
        await createConformanceSchema(db, dialect.kind);
        await insertDialectRowsChunked(
          db,
          buildDialectRows(dialect.kind, 10_000),
          500
        );

        const result = await benchmark(
          `dialect_${dialect.name}_select_10k`,
          async () => {
            const rows = await db
              .selectFrom('dialect_conformance')
              .select(['id', 'n_int', 'n_bigint'])
              .orderBy('n_int', 'asc')
              .execute();
            if (rows.length !== 10_000) {
              throw new Error(`unexpected row count: ${rows.length}`);
            }
          },
          { iterations: 3, warmup: 1, trackMemory: false }
        );
        results.push(result);
      } finally {
        await db.destroy();
      }
    }
  }

  return results;
}

async function main() {
  const results = await runBenchmarks();

  console.log(`\n${formatBenchmarkTable(results)}`);

  await saveBaseline(BASELINE_PATH, results);
  console.log(`\n✅ Baseline updated: ${BASELINE_PATH}`);
}

main().catch(console.error);
