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
  enqueueOutboxCommit,
  syncPullOnce,
  syncPushOnce,
} from '@syncular/client';
import { createDatabase } from '@syncular/core';
import { createBunSqliteDialect } from '@syncular/dialect-bun-sqlite';
import { createLibsqlDialect } from '@syncular/dialect-libsql';
import { createPgliteDialect } from '@syncular/dialect-pglite';
import { createSqlite3Dialect } from '@syncular/dialect-sqlite3';
import {
  createTestClient,
  createTestServer,
  seedServerData,
} from '@syncular/testkit';
import { createConformanceColumnCodecsPlugin } from '@syncular/tests-dialects/column-codecs';
import type { DialectConformanceDb } from '@syncular/tests-dialects/conformance-db';
import { createConformanceSchema } from '@syncular/tests-dialects/schema';
import { Kysely } from 'kysely';
import {
  type BenchmarkResult,
  benchmark,
  formatBenchmarkTable,
} from './benchmark';
import type { Baseline } from './regression';

const BASELINE_PATH = path.join(import.meta.dir, 'baseline.json');

/**
 * Save baseline to file
 */
async function saveBaseline(
  filePath: string,
  results: BenchmarkResult[]
): Promise<void> {
  const baseline: Baseline = {};
  const timestamp = new Date().toISOString();
  const commit = process.env.GITHUB_SHA ?? 'local';

  for (const result of results) {
    baseline[result.name] = {
      median: result.median,
      p95: result.p95,
      p99: result.p99,
      timestamp,
      commit,
    };
  }

  await Bun.write(filePath, JSON.stringify(baseline, null, 2));
}
const userId = 'perf-user';

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
