import Database from 'bun:sqlite';
import type {
  SyncCombinedRequest,
  SyncCombinedResponse,
  SyncPushRequest,
  SyncTransport,
} from '@syncular/core';
import { createServerHandlerCollection } from '@syncular/server';
import { createSqliteServerDialect } from '@syncular/server-dialect-sqlite';
import type { Dialect, QueryResult } from 'kysely';
import {
  Kysely,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
} from 'kysely';
import { ForwardEngine } from '../client-role/forward-engine';
import { PullEngine } from '../client-role/pull-engine';
import { SequenceMapper } from '../client-role/sequence-mapper';
import { ensureRelaySchema } from '../migrate';
import { createRelayWebSocketConnection, RelayRealtime } from '../realtime';
import type { RelayDatabase } from '../schema';
import { relayPull } from '../server-role/pull';
import { relayPushCommit } from '../server-role/push';

const DEFAULT_ITERATIONS = 100;
const DEFAULT_WARMUP_ITERATIONS = 10;
const DEFAULT_REALTIME_CONNECTIONS = 100;

export interface RelayAppPathEvaluationOptions {
  iterations?: number;
  warmupIterations?: number;
  realtimeConnections?: number;
}

export interface RelayAppPathMetric {
  name: string;
  iterations: number;
  totalUs: number;
  minUs: number;
  avgUs: number;
  p50Us: number;
  p95Us: number;
  maxUs: number;
}

export interface RelayAppPathEvaluationResult {
  fixture: {
    name: string;
    database: 'bun:sqlite:memory';
    dialect: 'server-dialect-sqlite';
    table: 'tasks';
  };
  config: {
    iterations: number;
    warmupIterations: number;
    realtimeConnections: number;
  };
  counters: {
    localPushCommits: number;
    forwardedCommits: number;
    mainPullAppliedCommits: number;
    localPullResponses: number;
    realtimeMessages: number;
  };
  metrics: RelayAppPathMetric[];
  notes: string[];
}

interface EvaluationContext {
  db: Kysely<RelayDatabase>;
  sqlite: Database;
  dialect: ReturnType<typeof createSqliteServerDialect>;
  handlers: ReturnType<typeof createEvaluationHandlers>;
}

let appPathSink: unknown;

export async function evaluateRelayAppPaths(
  options: RelayAppPathEvaluationOptions = {}
): Promise<RelayAppPathEvaluationResult> {
  const iterations = positiveIntegerOrDefault(
    options.iterations,
    DEFAULT_ITERATIONS
  );
  const warmupIterations = positiveIntegerOrDefault(
    options.warmupIterations,
    DEFAULT_WARMUP_ITERATIONS
  );
  const realtimeConnections = positiveIntegerOrDefault(
    options.realtimeConnections,
    DEFAULT_REALTIME_CONNECTIONS
  );

  const localPush = await measureLocalPush(iterations, warmupIterations);
  const forward = await measureForwardOnce(iterations, warmupIterations);
  const mainPullApply = await measureMainPullApply(
    iterations,
    warmupIterations
  );
  const localPull = await measureLocalPull(iterations, warmupIterations);
  const realtime = measureRealtimeNotify(
    iterations,
    warmupIterations,
    realtimeConnections
  );

  return {
    fixture: {
      name: 'relay-app-path-baseline-v1',
      database: 'bun:sqlite:memory',
      dialect: 'server-dialect-sqlite',
      table: 'tasks',
    },
    config: {
      iterations,
      warmupIterations,
      realtimeConnections,
    },
    counters: {
      localPushCommits: localPush.count,
      forwardedCommits: forward.count,
      mainPullAppliedCommits: mainPullApply.count,
      localPullResponses: localPull.count,
      realtimeMessages: realtime.count,
    },
    metrics: [
      localPush.metric,
      forward.metric,
      mainPullApply.metric,
      localPull.metric,
      realtime.metric,
    ],
    notes: [
      'This is an in-memory relay app-path baseline, not a production Rust integration.',
      'Local push and main pull/apply use the same server handler collection shape as relay runtime paths.',
      'Forward and pull transports are deterministic in-process controls, so network latency is intentionally excluded.',
      'Realtime measures scope fanout serialization to open mock connections.',
    ],
  };
}

export function assertRelayAppPathEvaluation(
  result: RelayAppPathEvaluationResult
): void {
  if (result.metrics.length !== 5) {
    throw new Error(
      'Relay app-path evaluation produced an incomplete metric set'
    );
  }
  const emptyMetric = result.metrics.find(
    (metric) => metric.iterations <= 0 || metric.totalUs <= 0
  );
  if (emptyMetric) {
    throw new Error(`Relay app-path metric ${emptyMetric.name} has no timing`);
  }
  if (
    result.counters.localPushCommits !== result.config.iterations ||
    result.counters.forwardedCommits !== result.config.iterations ||
    result.counters.mainPullAppliedCommits !== result.config.iterations ||
    result.counters.localPullResponses !== result.config.iterations
  ) {
    throw new Error(
      'Relay app-path evaluation counters did not match iterations'
    );
  }
  if (
    result.counters.realtimeMessages !==
    result.config.iterations * result.config.realtimeConnections
  ) {
    throw new Error('Relay realtime fanout counter did not match iterations');
  }
}

async function measureLocalPush(iterations: number, warmupIterations: number) {
  const context = await createEvaluationContext();
  let nextIndex = 0;
  let measuredCommits = 0;
  try {
    const metric = await measureAsyncOperation(
      'relay.local_push_commit',
      iterations,
      warmupIterations,
      async (measured) => {
        nextIndex += 1;
        const commitSeq = await pushOne(context, nextIndex, 'local-push');
        if (measured) {
          measuredCommits += 1;
        }
        return commitSeq;
      }
    );
    return { metric, count: measuredCommits };
  } finally {
    await destroyEvaluationContext(context);
  }
}

async function measureForwardOnce(
  iterations: number,
  warmupIterations: number
) {
  const context = await createEvaluationContext();
  const totalCommits = iterations + warmupIterations;
  for (let index = 1; index <= totalCommits; index += 1) {
    await pushOne(context, index, 'forward');
  }

  let mainCommitSeq = 10_000;
  const transport: SyncTransport = {
    async sync(request: SyncCombinedRequest): Promise<SyncCombinedResponse> {
      const commit = request.push?.commits[0];
      if (!commit) {
        throw new Error('Forward evaluation expected a push commit');
      }
      mainCommitSeq += 1;
      return {
        ok: true,
        push: {
          ok: true,
          commits: [
            {
              clientCommitId: commit.clientCommitId,
              ok: true,
              status: 'applied',
              commitSeq: mainCommitSeq,
              results: commit.operations.map((_operation, opIndex) => ({
                opIndex,
                status: 'applied',
              })),
            },
          ],
        },
      };
    },
    async fetchSnapshotChunk(): Promise<Uint8Array> {
      return new Uint8Array();
    },
  };
  const engine = new ForwardEngine({
    db: context.db,
    transport,
    clientId: 'relay-main-client',
    sequenceMapper: new SequenceMapper({ db: context.db }),
  });

  let forwarded = 0;
  try {
    const metric = await measureAsyncOperation(
      'relay.forward_once_to_main',
      iterations,
      warmupIterations,
      async (measured) => {
        const ok = await engine.forwardOnce();
        if (!ok) {
          throw new Error('Forward evaluation ran out of pending commits');
        }
        if (measured) {
          forwarded += 1;
        }
        return ok;
      }
    );
    return { metric, count: forwarded };
  } finally {
    await destroyEvaluationContext(context);
  }
}

async function measureMainPullApply(
  iterations: number,
  warmupIterations: number
) {
  const context = await createEvaluationContext();
  let mainCommitSeq = 20_000;
  const transport: SyncTransport = {
    async sync(request: SyncCombinedRequest): Promise<SyncCombinedResponse> {
      if (!request.pull) {
        throw new Error('Pull evaluation expected a pull request');
      }
      mainCommitSeq += 1;
      const rowId = `main-pull-task-${mainCommitSeq}`;
      return {
        ok: true,
        pull: {
          ok: true,
          subscriptions: [
            {
              id: 'tasks',
              status: 'active',
              scopes: { user_id: 'u1' },
              bootstrap: false,
              nextCursor: mainCommitSeq,
              commits: [
                {
                  commitSeq: mainCommitSeq,
                  createdAt: new Date(mainCommitSeq).toISOString(),
                  actorId: 'main-actor',
                  changes: [
                    {
                      table: 'tasks',
                      row_id: rowId,
                      op: 'upsert',
                      row_json: {
                        id: rowId,
                        title: `from-main-${mainCommitSeq}`,
                        user_id: 'u1',
                      },
                      row_version: mainCommitSeq,
                      scopes: { user_id: 'u1' },
                    },
                  ],
                },
              ],
            },
          ],
        },
      };
    },
    async fetchSnapshotChunk(): Promise<Uint8Array> {
      return new Uint8Array();
    },
  };
  const engine = new PullEngine({
    db: context.db,
    dialect: context.dialect,
    transport,
    clientId: 'relay-main-client',
    tables: ['tasks'],
    scopes: { user_id: 'u1' },
    handlers: context.handlers,
    sequenceMapper: new SequenceMapper({ db: context.db }),
    realtime: new RelayRealtime({ heartbeatIntervalMs: 0 }),
  });

  let applied = 0;
  try {
    const metric = await measureAsyncOperation(
      'relay.pull_from_main_apply_one_commit',
      iterations,
      warmupIterations,
      async (measured) => {
        const changed = await engine.pullOnce();
        if (!changed) {
          throw new Error('Main pull evaluation expected one applied commit');
        }
        if (measured) {
          applied += 1;
        }
        return changed;
      }
    );
    return { metric, count: applied };
  } finally {
    await destroyEvaluationContext(context);
  }
}

async function measureLocalPull(iterations: number, warmupIterations: number) {
  const context = await createEvaluationContext();
  const totalMeasuredPulls = iterations + warmupIterations;
  const commitSeqs: number[] = [];
  for (let index = 1; index <= totalMeasuredPulls + 1; index += 1) {
    commitSeqs.push(await pushOne(context, index, 'local-pull'));
  }

  let pullIndex = 1;
  let localPullResponses = 0;
  try {
    const metric = await measureAsyncOperation(
      'relay.local_client_pull_incremental_one_commit',
      iterations,
      warmupIterations,
      async (measured) => {
        const commitSeq = commitSeqs[pullIndex];
        pullIndex += 1;
        if (commitSeq === undefined) {
          throw new Error('Local pull evaluation ran out of seeded commits');
        }
        const result = await relayPull({
          db: context.db,
          dialect: context.dialect,
          handlers: context.handlers,
          auth: { actorId: 'u1' },
          request: {
            clientId: 'local-reader',
            schemaVersion: 1,
            limitCommits: 1,
            subscriptions: [
              {
                id: 'tasks',
                table: 'tasks',
                scopes: { user_id: 'u1' },
                cursor: commitSeq - 1,
                crdtStateVectors: [],
              },
            ],
          },
        });
        const commitCount =
          result.response.subscriptions[0]?.commits.length ?? 0;
        if (commitCount !== 1) {
          throw new Error(
            `Local pull evaluation expected 1 commit, got ${commitCount}`
          );
        }
        if (measured) {
          localPullResponses += 1;
        }
        return result.response;
      }
    );
    return { metric, count: localPullResponses };
  } finally {
    await destroyEvaluationContext(context);
  }
}

function measureRealtimeNotify(
  iterations: number,
  warmupIterations: number,
  realtimeConnections: number
) {
  const realtime = new RelayRealtime({ heartbeatIntervalMs: 0 });
  let messages = 0;
  for (let index = 0; index < realtimeConnections; index += 1) {
    const connection = createRelayWebSocketConnection(
      {
        readyState: 1,
        send() {
          messages += 1;
        },
        close() {},
      },
      { actorId: 'u1', clientId: `client-${index}` }
    );
    realtime.register(connection, ['tasks']);
  }

  let measuredMessagesStart = 0;
  try {
    const metric = measureOperation(
      `relay.realtime_notify_${realtimeConnections}_connections`,
      iterations,
      warmupIterations,
      (measured, index) => {
        if (measured && measuredMessagesStart === 0) {
          measuredMessagesStart = messages;
        }
        realtime.notifyScopeKeys(['tasks'], index);
        return messages;
      }
    );
    return {
      metric,
      count: messages - measuredMessagesStart,
    };
  } finally {
    realtime.closeAll();
  }
}

async function pushOne(
  context: EvaluationContext,
  index: number,
  prefix: string
): Promise<number> {
  const response = await relayPushCommit({
    db: context.db,
    dialect: context.dialect,
    handlers: context.handlers,
    auth: { actorId: 'u1' },
    request: createPushRequest(index, prefix),
  });
  const commitSeq = response.response.commitSeq;
  if (response.response.status !== 'applied' || typeof commitSeq !== 'number') {
    throw new Error(`Relay push evaluation failed for ${prefix}-${index}`);
  }
  return commitSeq;
}

function createPushRequest(index: number, prefix: string): SyncPushRequest {
  const rowId = `${prefix}-task-${index}`;
  return {
    clientId: `${prefix}-client`,
    clientCommitId: `${prefix}-commit-${index}`,
    schemaVersion: 1,
    operations: [
      {
        table: 'tasks',
        row_id: rowId,
        op: 'upsert',
        payload: {
          id: rowId,
          title: `${prefix} task ${index}`,
          user_id: 'u1',
        },
        base_version: null,
      },
    ],
  };
}

async function createEvaluationContext(): Promise<EvaluationContext> {
  const { db, sqlite } = createEvaluationDb();
  const dialect = createSqliteServerDialect();
  const handlers = createEvaluationHandlers();
  await ensureRelaySchema(db, dialect);
  return {
    db,
    sqlite,
    dialect,
    handlers,
  };
}

async function destroyEvaluationContext(
  context: EvaluationContext
): Promise<void> {
  await context.db.destroy();
  context.sqlite.close();
}

function createEvaluationHandlers() {
  return createServerHandlerCollection<RelayDatabase>([
    {
      table: 'tasks',
      scopePatterns: ['user:{user_id}'],
      resolveScopes: async () => ({ user_id: ['u1'] }),
      extractScopes: () => ({ user_id: 'u1' }),
      snapshot: async () => ({ rows: [], nextCursor: null }),
      async applyOperation(_context, operation, opIndex) {
        return {
          result: {
            opIndex,
            status: 'applied',
          },
          emittedChanges: [
            {
              table: operation.table,
              row_id: operation.row_id,
              op: operation.op,
              row_json: operation.payload,
              row_version: opIndex + 1,
              scopes: { user_id: 'u1' },
            },
          ],
        };
      },
    },
  ]);
}

function createEvaluationDb() {
  const sqlite = new Database(':memory:');

  const dialect: Dialect = {
    createAdapter: () => new SqliteAdapter(),
    createDriver: () => ({
      init: async () => {},
      acquireConnection: async () => ({
        executeQuery: async <R>(compiledQuery: {
          sql: string;
          parameters: readonly unknown[];
        }): Promise<QueryResult<R>> => {
          const query = compiledQuery.sql;
          const params = compiledQuery.parameters ?? [];

          const normalizedSql = query.trimStart().toLowerCase();
          if (
            normalizedSql.startsWith('select') ||
            normalizedSql.startsWith('with') ||
            normalizedSql.startsWith('pragma')
          ) {
            const stmt = sqlite.prepare(query);
            return { rows: stmt.all(...params) as R[] };
          }

          const stmt = sqlite.prepare(query);
          const result = stmt.run(...params);
          return {
            rows: [] as R[],
            numAffectedRows: BigInt(result.changes),
            insertId:
              result.lastInsertRowid != null
                ? BigInt(result.lastInsertRowid)
                : undefined,
          };
        },
        streamQuery: <R>(): AsyncIterableIterator<QueryResult<R>> => {
          throw new Error('Not implemented');
        },
      }),
      beginTransaction: async () => {},
      commitTransaction: async () => {},
      rollbackTransaction: async () => {},
      releaseConnection: async () => {},
      destroy: async () => {},
    }),
    createIntrospector: (db) => new SqliteIntrospector(db),
    createQueryCompiler: () => new SqliteQueryCompiler(),
  };

  return {
    db: new Kysely<RelayDatabase>({ dialect }),
    sqlite,
  };
}

async function measureAsyncOperation(
  name: string,
  iterations: number,
  warmupIterations: number,
  operation: (measured: boolean, index: number) => Promise<unknown>
): Promise<RelayAppPathMetric> {
  for (let index = 0; index < warmupIterations; index += 1) {
    appPathSink = await operation(false, index);
  }

  const samples = new Array<number>(iterations);
  const totalStart = process.hrtime.bigint();
  for (let index = 0; index < iterations; index += 1) {
    const start = process.hrtime.bigint();
    appPathSink = await operation(true, index);
    samples[index] = Number(process.hrtime.bigint() - start) / 1_000;
  }
  const totalUs = Number(process.hrtime.bigint() - totalStart) / 1_000;
  return metricFromSamples(name, iterations, totalUs, samples);
}

function measureOperation(
  name: string,
  iterations: number,
  warmupIterations: number,
  operation: (measured: boolean, index: number) => unknown
): RelayAppPathMetric {
  for (let index = 0; index < warmupIterations; index += 1) {
    appPathSink = operation(false, index);
  }

  const samples = new Array<number>(iterations);
  const totalStart = process.hrtime.bigint();
  for (let index = 0; index < iterations; index += 1) {
    const start = process.hrtime.bigint();
    appPathSink = operation(true, index);
    samples[index] = Number(process.hrtime.bigint() - start) / 1_000;
  }
  const totalUs = Number(process.hrtime.bigint() - totalStart) / 1_000;
  return metricFromSamples(name, iterations, totalUs, samples);
}

function metricFromSamples(
  name: string,
  iterations: number,
  totalUs: number,
  samples: number[]
): RelayAppPathMetric {
  samples.sort((left, right) => left - right);
  return {
    name,
    iterations,
    totalUs: roundUs(totalUs),
    minUs: roundUs(samples[0] ?? 0),
    avgUs: roundUs(totalUs / iterations),
    p50Us: roundUs(percentile(samples, 0.5)),
    p95Us: roundUs(percentile(samples, 0.95)),
    maxUs: roundUs(samples[samples.length - 1] ?? 0),
  };
}

function percentile(sortedSamples: number[], percentileValue: number): number {
  if (sortedSamples.length === 0) {
    return 0;
  }
  const index = Math.min(
    sortedSamples.length - 1,
    Math.floor((sortedSamples.length - 1) * percentileValue)
  );
  return sortedSamples[index] ?? 0;
}

function positiveIntegerOrDefault(
  value: number | undefined,
  defaultValue: number
): number {
  if (Number.isInteger(value) && value !== undefined && value > 0) {
    return value;
  }
  return defaultValue;
}

function roundUs(value: number): number {
  return Math.round(value * 100) / 100;
}

export function relayAppPathEvaluationSink(): unknown {
  return appPathSink;
}
