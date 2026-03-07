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
import { type BlobStorageAdapter, createDatabase } from '@syncular/core';
import { createBunSqliteDialect } from '@syncular/dialect-bun-sqlite';
import {
  BLOB_CLEANUP_TUNING_PRESETS,
  computePruneWatermarkCommitSeq,
  createBlobManager,
  ensureBlobStorageSchemaSqlite,
  ensureSyncSchema,
  pruneSync,
  type SyncBlobDb,
  type SyncCoreDb,
} from '@syncular/server';
import {
  createDbMetadataChunkStorage,
  SNAPSHOT_CHUNK_CLEANUP_TUNING_PRESETS,
} from '@syncular/server/snapshot-chunks';
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
import type { Kysely } from 'kysely';
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
import { installSilentSyncTelemetry } from './telemetry';

const BASELINE_PATH = path.join(import.meta.dir, 'baseline.json');
const RUN_LARGE_PERF = Bun.env.SYNC_PERF_LARGE === '1';

function parsePositiveIntEnv(
  name: string,
  fallback: number,
  minValue = 1
): number {
  const raw = Bun.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minValue, parsed);
}

const LARGE_BOOTSTRAP_ROWS = parsePositiveIntEnv(
  'SYNC_PERF_BOOTSTRAP_ROWS',
  100_000,
  100_000
);
const LARGE_CLEANUP_ROWS = parsePositiveIntEnv(
  'SYNC_PERF_CLEANUP_ROWS',
  50_000,
  10_000
);
const LARGE_PERF_ITERATIONS = parsePositiveIntEnv(
  'SYNC_PERF_LARGE_ITERATIONS',
  1
);

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

async function insertBlobRowsChunked(
  db: Kysely<SyncBlobDb>,
  rows: Array<{
    partition_id: string;
    hash: string;
    size: number;
    mime_type: string;
    status: 'pending' | 'complete';
    actor_id: string;
    expires_at: string;
    completed_at: string | null;
  }>,
  chunkSize = 1_000
): Promise<void> {
  for (let index = 0; index < rows.length; index += chunkSize) {
    const chunk = rows.slice(index, index + chunkSize);
    await db.insertInto('sync_blob_uploads').values(chunk).execute();
  }
}

async function insertSnapshotChunkRowsChunked(
  db: Kysely<SyncCoreDb>,
  rows: Array<{
    chunk_id: string;
    partition_id: string;
    scope_key: string;
    scope: string;
    as_of_commit_seq: number;
    row_cursor: string;
    row_limit: number;
    encoding: string;
    compression: string;
    sha256: string;
    byte_length: number;
    blob_hash: string;
    expires_at: string;
  }>,
  chunkSize = 1_000
): Promise<void> {
  for (let index = 0; index < rows.length; index += chunkSize) {
    const chunk = rows.slice(index, index + chunkSize);
    await db.insertInto('sync_snapshot_chunks').values(chunk).execute();
  }
}

describe('sync performance', () => {
  let server: TestServer;
  let restoreTelemetry: (() => void) | null = null;
  const results: BenchmarkResult[] = [];
  const userId = 'perf-user';
  const itLarge = RUN_LARGE_PERF ? it : it.skip;

  beforeAll(async () => {
    restoreTelemetry = installSilentSyncTelemetry();
    server = await createTestServer('sqlite');
  });

  afterAll(async () => {
    await server.destroy();
    restoreTelemetry?.();

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

  itLarge('bootstrap 100K rows (profile)', async () => {
    const result = await benchmark(
      'bootstrap_100k',
      async () => {
        await withTestServer('sqlite', async (testServer) => {
          await seedServerData(testServer, {
            userId,
            count: LARGE_BOOTSTRAP_ROWS,
          });

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
      { iterations: LARGE_PERF_ITERATIONS, warmup: 0 }
    );

    results.push(result);
    expect(result.median).toBeLessThan(defaultThresholds.bootstrap_100k);
  });

  itLarge(
    'blob cleanup throughput with server/edge presets (large catalog)',
    async () => {
      const blobPresets = [
        {
          presetName: 'server',
          tuning: BLOB_CLEANUP_TUNING_PRESETS.server,
        },
        {
          presetName: 'edge',
          tuning: BLOB_CLEANUP_TUNING_PRESETS.edge,
        },
      ] as const;

      for (const preset of blobPresets) {
        const metricName = `blob_cleanup_${preset.presetName}_${LARGE_CLEANUP_ROWS}`;
        const pendingCount = Math.floor(LARGE_CLEANUP_ROWS * 0.6);
        const completeCount = LARGE_CLEANUP_ROWS - pendingCount;
        const referencedCount = Math.floor(completeCount * 0.2);
        const expectedDeleted = LARGE_CLEANUP_ROWS - referencedCount;

        const result = await benchmark(
          metricName,
          async () => {
            const db = createDatabase<SyncBlobDb>({
              dialect: createBunSqliteDialect({ path: ':memory:' }),
              family: 'sqlite',
            });

            try {
              await ensureBlobStorageSchemaSqlite(db);

              let deletedFromStorage = 0;
              const adapter: BlobStorageAdapter = {
                name: 'perf-cleanup',
                async signUpload() {
                  return { url: 'http://example.test/upload', method: 'PUT' };
                },
                async signDownload() {
                  return 'http://example.test/download';
                },
                async exists() {
                  return false;
                },
                async delete() {
                  deletedFromStorage += 1;
                },
              };

              const manager = createBlobManager({
                db,
                adapter,
                cleanupTuning: preset.tuning,
              });

              const partitionId = 'perf';
              const expiredIso = new Date(Date.now() - 60_000).toISOString();
              const activeIso = new Date(Date.now() + 60_000).toISOString();
              const completedIso = new Date().toISOString();

              const pendingRows = Array.from(
                { length: pendingCount },
                (_, i) => ({
                  partition_id: partitionId,
                  hash: `sha256:pending-${preset.presetName}-${i}`,
                  size: 1,
                  mime_type: 'application/octet-stream',
                  status: 'pending' as const,
                  actor_id: 'perf',
                  expires_at: expiredIso,
                  completed_at: null,
                })
              );

              const completeRows = Array.from(
                { length: completeCount },
                (_, i) => ({
                  partition_id: partitionId,
                  hash: `sha256:complete-${preset.presetName}-${i}`,
                  size: 1,
                  mime_type: 'application/octet-stream',
                  status: 'complete' as const,
                  actor_id: 'perf',
                  expires_at: activeIso,
                  completed_at: completedIso,
                })
              );

              await insertBlobRowsChunked(db, [
                ...pendingRows,
                ...completeRows,
              ]);

              const referencedHashes = new Set(
                completeRows.slice(0, referencedCount).map((row) => row.hash)
              );

              const cleanup = await manager.cleanup({
                partitionId,
                deleteFromStorage: true,
                isReferenced: async (hash) => referencedHashes.has(hash),
              });

              if (cleanup.deleted !== expectedDeleted) {
                throw new Error(
                  `Expected ${expectedDeleted} deleted rows for ${metricName}, received ${cleanup.deleted}`
                );
              }
              if (deletedFromStorage !== expectedDeleted) {
                throw new Error(
                  `Expected ${expectedDeleted} storage deletes for ${metricName}, received ${deletedFromStorage}`
                );
              }
            } finally {
              await db.destroy();
            }
          },
          {
            iterations: LARGE_PERF_ITERATIONS,
            warmup: 0,
          }
        );

        results.push(result);
      }
    }
  );

  itLarge(
    'snapshot chunk cleanup throughput with server/edge presets (large catalog)',
    async () => {
      const snapshotPresets = [
        {
          presetName: 'server',
          tuning: SNAPSHOT_CHUNK_CLEANUP_TUNING_PRESETS.server,
        },
        {
          presetName: 'edge',
          tuning: SNAPSHOT_CHUNK_CLEANUP_TUNING_PRESETS.edge,
        },
      ] as const;

      for (const preset of snapshotPresets) {
        const metricName = `snapshot_cleanup_${preset.presetName}_${LARGE_CLEANUP_ROWS}`;

        const result = await benchmark(
          metricName,
          async () => {
            const db = createDatabase<SyncCoreDb>({
              dialect: createBunSqliteDialect({ path: ':memory:' }),
              family: 'sqlite',
            });

            try {
              await ensureSyncSchema(db, server.dialect);

              let deletedBlobCount = 0;
              const blobAdapter: BlobStorageAdapter = {
                name: 'perf-snapshot-cleanup',
                async signUpload() {
                  return { url: 'http://example.test/upload', method: 'PUT' };
                },
                async signDownload() {
                  return 'http://example.test/download';
                },
                async exists() {
                  return true;
                },
                async delete() {
                  deletedBlobCount += 1;
                },
              };

              const chunkStorage = createDbMetadataChunkStorage({
                db,
                blobAdapter,
                cleanupTuning: preset.tuning,
              });

              const expiredIso = new Date(Date.now() - 60_000).toISOString();
              const rows = Array.from(
                { length: LARGE_CLEANUP_ROWS },
                (_, i) => ({
                  chunk_id: `chunk-${preset.presetName}-${i}`,
                  partition_id: 'default',
                  scope_key: 'perf-scope',
                  scope: 'tasks',
                  as_of_commit_seq: 1,
                  row_cursor: String(i),
                  row_limit: 1000,
                  encoding: 'json-row-frame-v1',
                  compression: 'gzip',
                  sha256: `sha-${preset.presetName}-${i}`,
                  byte_length: 128,
                  blob_hash: `sha256:blob-${preset.presetName}-${i}`,
                  expires_at: expiredIso,
                })
              );

              await insertSnapshotChunkRowsChunked(db, rows);

              const deleted = await chunkStorage.cleanupExpired(
                new Date().toISOString()
              );
              if (deleted !== LARGE_CLEANUP_ROWS) {
                throw new Error(
                  `Expected ${LARGE_CLEANUP_ROWS} deleted snapshot rows for ${metricName}, received ${deleted}`
                );
              }
              if (deletedBlobCount !== LARGE_CLEANUP_ROWS) {
                throw new Error(
                  `Expected ${LARGE_CLEANUP_ROWS} blob deletes for ${metricName}, received ${deletedBlobCount}`
                );
              }
            } finally {
              await db.destroy();
            }
          },
          {
            iterations: LARGE_PERF_ITERATIONS,
            warmup: 0,
          }
        );

        results.push(result);
      }
    }
  );

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

  it(
    'transport lane catchup latency (direct/relay/ws)',
    async () => {
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
        await syncPullOnce(
          relayClient.db,
          relayTransport,
          relayClient.handlers,
          {
            clientId: relayClient.clientId,
            subscriptions: [subscription],
          }
        );
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
    },
    { timeout: 20_000 }
  );

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
