/**
 * SYNCULAR-PULL-ROUNDTRIPS-001: a pull's storage statements grow with the
 * tables it reads, not with its subscriptions, and the batched reads return
 * the frames the per-subscription SQLite path returns.
 */
import { describe, expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import {
  decodeMessage,
  REALTIME_TAG_ROUND,
  type PushOperation,
  type RequestFrame,
  type ResponseMessage,
  type SubscriptionFrame,
} from '@syncular/core';
import {
  compileSchema,
  createRealtimeHub,
  type D1Database,
  type D1PreparedStatement,
  D1ServerStorage,
  handleSyncRequest,
  MemorySegmentStore,
  type PgExecutor,
  type PgQueryable,
  PostgresServerStorage,
  type ServerStorage,
  SqliteServerStorage,
  type SyncRequestContext,
} from '@syncular/server';
import { pgliteExecutor } from '@syncular/server/pglite';
import { D1DatabaseDouble } from './d1-double';
import {
  del,
  docRow,
  pullHeader,
  pushCommit,
  pushResults,
  requestBytes,
  subFrame,
  TEST_LOG_EPOCH,
  TEST_SCHEMA,
  taskRow,
  upsert,
} from './helpers';

const PROJECTS = 34;

/** Counts every statement the storage sends, pool and transaction alike. */
function countingExecutor(inner: PgExecutor): {
  executor: PgExecutor;
  count: { statements: number; transactions: number };
} {
  const count = { statements: 0, transactions: 0 };
  const counted = (client: PgQueryable): PgQueryable => ({
    query: (text, params) => {
      count.statements += 1;
      return client.query(text, params);
    },
  });
  return {
    count,
    executor: {
      query: counted(inner).query,
      transaction: (fn) => {
        count.transactions += 1;
        return inner.transaction((client) => fn(counted(client)));
      },
    },
  };
}

/** Counts D1 round trips: one per `batch`, one per direct statement call. */
function countingD1(inner: D1Database): {
  db: D1Database;
  count: { statements: number };
} {
  const count = { statements: 0 };
  const sources = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const wrapped: D1PreparedStatement = {
      bind: (...values) => wrap(statement.bind(...values)),
      first: () => {
        count.statements += 1;
        return statement.first();
      },
      all: () => {
        count.statements += 1;
        return statement.all();
      },
      run: () => {
        count.statements += 1;
        return statement.run();
      },
    };
    sources.set(wrapped, statement);
    return wrapped;
  };
  return {
    count,
    db: {
      prepare: (query) => wrap(inner.prepare(query)),
      batch: (statements) => {
        count.statements += 1;
        return inner.batch(
          statements.map((statement) => sources.get(statement) ?? statement),
        );
      },
      exec: (query) => {
        count.statements += 1;
        return inner.exec(query);
      },
    },
  };
}

async function context(storage: ServerStorage): Promise<SyncRequestContext> {
  const projects = Array.from({ length: PROJECTS }, (_, i) => `p${i}`);
  const ctx: SyncRequestContext = {
    partition: 'part-1',
    actorId: 'actor-1',
    schema: TEST_SCHEMA,
    storage,
    segments: new MemorySegmentStore(),
    resolveScopes: () => ({
      project_id: projects,
      projectId: projects,
      org_id: ['o1'],
    }),
    clock: () => 1_750_000_000_000,
  };
  await storage.ensureSchema(compileSchema(TEST_SCHEMA));
  await storage.touchPartition(
    ctx.partition,
    1_750_000_000_000,
    TEST_LOG_EPOCH,
  );
  return ctx;
}

async function sync(
  ctx: SyncRequestContext,
  frames: RequestFrame[],
): Promise<ResponseMessage> {
  const message = decodeMessage(
    await handleSyncRequest(requestBytes(frames), ctx),
  );
  if (message.msgKind !== 'response') throw new Error('expected a response');
  return message;
}

async function push(
  ctx: SyncRequestContext,
  id: string,
  operations: PushOperation[],
): Promise<void> {
  const result = pushResults(await sync(ctx, [pushCommit(id, operations)]))[0];
  if (result?.status !== 'applied') throw new Error('seed push not applied');
}

/** Tasks in every project (70 commits in p0, so its window pages twice). */
async function seed(ctx: SyncRequestContext, round: string): Promise<void> {
  for (let i = 0; i < PROJECTS; i++) {
    await push(ctx, `${round}-t${i}`, [
      upsert('tasks', `${round}-t${i}`, taskRow(`${round}-t${i}`, `p${i}`)),
      upsert('docs', `${round}-d${i}`, docRow(`${round}-d${i}`, 'o1', `p${i}`)),
    ]);
  }
  for (let i = 0; i < 70; i++) {
    await push(ctx, `${round}-hot${i}`, [
      upsert('tasks', `${round}-hot${i}`, taskRow(`${round}-hot${i}`, 'p0')),
    ]);
  }
}

/** One tasks and one docs subscription per project, plus a revoked one. */
function subscriptions(
  count: number,
  cursors?: ReadonlyMap<string, number>,
): SubscriptionFrame[] {
  const frames: SubscriptionFrame[] = [];
  for (let i = 0; frames.length < count - 1; i++) {
    const project = `p${Math.floor(i / 2) % PROJECTS}`;
    const table = i % 2 === 0 ? 'tasks' : 'docs';
    const id = `s${i}`;
    frames.push(
      subFrame(
        id,
        table,
        table === 'tasks'
          ? { project_id: [project] }
          : { projectId: [project] },
        cursors?.get(id) ?? -1,
      ),
    );
  }
  frames.push(subFrame('revoked', 'tasks', { project_id: ['nope'] }, -1));
  return frames;
}

function cursorsOf(message: ResponseMessage): Map<string, number> {
  const cursors = new Map<string, number>();
  let current: string | undefined;
  for (const frame of message.frames) {
    if (frame.type === 'SUB_START') current = frame.id;
    if (frame.type === 'SUB_END' && current !== undefined) {
      cursors.set(current, frame.nextCursor);
    }
  }
  return cursors;
}

async function scenario(storage: ServerStorage, count: number) {
  const ctx = await context(storage);
  await seed(ctx, 'a');
  const bootstrap = await sync(ctx, [pullHeader(), ...subscriptions(count)]);
  await seed(ctx, 'b');
  const incremental = await sync(ctx, [
    pullHeader(),
    ...subscriptions(count, cursorsOf(bootstrap)),
  ]);
  return { bootstrap, incremental };
}

async function counted(
  count: number,
  open: () => Promise<{
    storage: ServerStorage;
    counter: { statements: number };
    close: () => Promise<void>;
  }>,
) {
  const { storage, counter, close } = await open();
  const counting = { count: counter };
  const ctx = await context(storage);
  await seed(ctx, 'a');
  counting.count.statements = 0;
  const bootstrap = await sync(ctx, [pullHeader(), ...subscriptions(count)]);
  const bootstrapStatements = counting.count.statements;
  await seed(ctx, 'b');
  counting.count.statements = 0;
  await sync(ctx, [
    pullHeader(),
    ...subscriptions(count, cursorsOf(bootstrap)),
  ]);
  const incrementalStatements = counting.count.statements;
  await close();
  return { bootstrapStatements, incrementalStatements };
}

// Each test seeds about 200 pushes per storage; CI runners need more than
// bun's 5 s default.
describe('pull statement count (SYNCULAR-PULL-ROUNDTRIPS-001)', () => {
  const postgres = async () => {
    const db = await PGlite.create();
    const counting = countingExecutor(pgliteExecutor(db));
    return {
      storage: new PostgresServerStorage(counting.executor),
      counter: counting.count,
      close: () => db.close(),
    };
  };
  const d1 = async () => {
    const counting = countingD1(new D1DatabaseDouble());
    const storage = new D1ServerStorage(counting.db, {
      pushApplySerialized: true,
    });
    // D1 migrates across invocations; finish it before counting.
    while (
      !(await storage.migrateSchema(compileSchema(TEST_SCHEMA))).complete
    ) {}
    return {
      storage,
      counter: counting.count,
      close: async () => {},
    };
  };

  test('D1: round trips grow with tables, not subscriptions', async () => {
    const small = await counted(8, d1);
    const large = await counted(68, d1);
    expect(large.bootstrapStatements).toBe(small.bootstrapStatements);
    expect(large.incrementalStatements).toBe(small.incrementalStatements);
  }, 60_000);

  test('PostgreSQL: statements grow with tables, not subscriptions', async () => {
    const small = await counted(8, postgres);
    const large = await counted(68, postgres);
    expect(large.bootstrapStatements).toBe(small.bootstrapStatements);
    // The hot p0 window pages a second time in both runs.
    expect(large.incrementalStatements).toBe(small.incrementalStatements);
    // 5 ms per round trip keeps a 68-subscription pull far under 500 ms.
    expect(large.incrementalStatements * 5).toBeLessThan(500);
    expect(large.bootstrapStatements * 5).toBeLessThan(500);
  }, 60_000);

  test('PostgreSQL serves the frames of the per-subscription SQLite path', async () => {
    const db = await PGlite.create();
    const postgres = await scenario(
      new PostgresServerStorage(pgliteExecutor(db)),
      68,
    );
    const sqlite = await scenario(new SqliteServerStorage(), 68);
    expect(postgres.bootstrap.frames).toEqual(sqlite.bootstrap.frames);
    expect(postgres.incremental.frames).toEqual(sqlite.incremental.frames);
    const commits = postgres.incremental.frames.filter(
      (frame) => frame.type === 'COMMIT',
    );
    // 34 tasks and 33 docs subscriptions each deliver their project's
    // round-b commit; the p0 tasks subscription also delivers 70 hot commits.
    expect(commits.length).toBe(PROJECTS + (PROJECTS - 1) + 70);
    await db.close();
  }, 60_000);
});

/**
 * A realtime client's first round (§8.7) carrying its outbox and every
 * subscription: `count` push commits of three writes each, then a bootstrap
 * of `subscriptionCount` subscriptions, driven through `handleBinary`.
 */
async function firstSocketRound(
  subscriptionCount: number,
  commitCount: number,
) {
  const db = await PGlite.create();
  const counting = countingExecutor(pgliteExecutor(db));
  const ctx = await context(new PostgresServerStorage(counting.executor));
  await seed(ctx, 'a');
  const hub = createRealtimeHub({
    schema: ctx.schema,
    storage: ctx.storage,
    segments: ctx.segments,
    resolveScopes: ctx.resolveScopes,
    clock: () => 1_750_000_000_000,
  });
  const chunks: Uint8Array[] = [];
  const session = await hub.connect({
    partition: ctx.partition,
    actorId: ctx.actorId,
    clientId: 'client-1',
    send: (data) => {
      if (typeof data !== 'string') chunks.push(data.subarray(1));
    },
  });
  const frames: RequestFrame[] = [];
  for (let i = 0; i < commitCount; i++) {
    const project = `p${i % PROJECTS}`;
    frames.push(
      pushCommit(`outbox-${i}`, [
        upsert('tasks', `outbox-t${i}`, taskRow(`outbox-t${i}`, project)),
        upsert('docs', `outbox-d${i}`, docRow(`outbox-d${i}`, 'o1', project)),
        upsert('docs', `outbox-e${i}`, docRow(`outbox-e${i}`, 'o1', project)),
      ]),
    );
  }
  frames.push(pullHeader(), ...subscriptions(subscriptionCount));
  const request = requestBytes(frames);
  const tagged = new Uint8Array(request.length + 1);
  tagged[0] = REALTIME_TAG_ROUND;
  tagged.set(request, 1);
  counting.count.statements = 0;
  counting.count.transactions = 0;
  await session.handleBinary(tagged);
  const response = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    response.set(chunk, offset);
    offset += chunk.length;
  }
  const message = decodeMessage(response);
  const counts = { ...counting.count };
  session.close();
  await db.close();
  return { message, counts };
}

describe('first realtime socket round (SYNCULAR-PULL-ROUNDTRIPS-001)', () => {
  test('PostgreSQL: statements grow with commits and tables, transactions with commits only', async () => {
    const small = await firstSocketRound(8, 10);
    const large = await firstSocketRound(68, 10);
    for (const { message } of [small, large]) {
      expect(message.frames.some((frame) => frame.type === 'ERROR')).toBe(
        false,
      );
      expect(
        message.frames.filter(
          (frame) => frame.type === 'PUSH_RESULT' && frame.status === 'applied',
        ),
      ).toHaveLength(10);
    }
    expect(
      large.message.frames.filter((frame) => frame.type === 'SUB_START'),
    ).toHaveLength(68);
    // Each PUSH_COMMIT is its own atomic transaction (§6.4); the pull half
    // of the round opens none and its statements do not depend on the
    // subscription count.
    expect(small.counts.transactions).toBe(10);
    expect(large.counts.transactions).toBe(10);
    expect(large.counts.statements).toBe(small.counts.statements);
    // Per commit: 8 fixed statements (idempotency lookup and locked
    // re-check, partition lock, serve gate, savepoint, commit allocation,
    // change log, push result), one read-ahead per table, one write per
    // row; the pull half adds 11 for the round.
    expect(large.counts.statements).toBe(10 * (8 + 2 + 3) + 11);
  }, 60_000);
});

describe('push read-ahead (SYNCULAR-PULL-ROUNDTRIPS-001)', () => {
  test('PostgreSQL answers repeated writes to one row like SQLite', async () => {
    const run = async (storage: ServerStorage) => {
      const ctx = await context(storage);
      const t = (title: string) => taskRow('r1', 'p1', title);
      return sync(ctx, [
        // Insert, versioned update, delete, then an unversioned re-insert:
        // every operation must see the previous one's write.
        pushCommit('same-row', [
          upsert('tasks', 'r1', t('a')),
          upsert('tasks', 'r1', t('b'), 1),
          del('tasks', 'r1'),
          upsert('tasks', 'r1', t('c')),
        ]),
        // Delete, explicit re-insert, delete again: two tombstone candidates.
        pushCommit('twice-deleted', [
          del('tasks', 'r1'),
          upsert('tasks', 'r1', t('d'), 0),
          del('tasks', 'r1'),
        ]),
        // The tombstone rejects an unversioned upsert.
        pushCommit('after-delete', [upsert('tasks', 'r1', t('e'))]),
        pullHeader(),
        subFrame('s', 'tasks', { project_id: ['p1'] }, 0),
      ]);
    };
    const db = await PGlite.create();
    const postgres = await run(new PostgresServerStorage(pgliteExecutor(db)));
    const sqlite = await run(new SqliteServerStorage());
    expect(postgres.frames).toEqual(sqlite.frames);
    expect(pushResults(postgres).map((result) => result.status)).toEqual([
      'applied',
      'applied',
      'rejected',
    ]);
    await db.close();
  }, 60_000);
});
