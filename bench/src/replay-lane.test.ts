import { expect, test } from 'bun:test';
import { runReplayLane } from './replay-lane';
import { closeBenchClients, createBenchClient } from './loopback';
import { measureMethods, type MethodMeasurement } from './instrumentation';
import { createPerformanceServer } from './socket-server';
import { queuedValues } from './fixture';

test('cleanup waits for every client even when one close fails', async () => {
  const gate = Promise.withResolvers<void>();
  let released = false;
  const closing = closeBenchClients([
    {
      close: async () => {
        throw new Error('injected close failure');
      },
    },
    {
      close: async () => {
        await gate.promise;
        released = true;
      },
    },
  ]);
  const result = closing.catch((error: unknown) => error);
  expect(released).toBe(false);
  gate.resolve();
  expect(await result).toBeInstanceOf(AggregateError);
  expect(released).toBe(true);
});

test.each([false, true])(
  'replay validates FIFO and client metadata (persistent=%s)',
  async (persistent) => {
    const result = await runReplayLane({
      commits: 501,
      rows: 32,
      repeated: true,
      persistent,
      lane: 'engine',
      backend: 'sqlite',
    });
    expect(result.requests).toEqual([500, 1]);
    expect(result.clientSqlite.map((client) => client.role)).toEqual([
      'writer',
      'reader',
    ]);
    expect(
      new Set(result.clientSqlite.map((client) => client.clientId)).size,
    ).toBe(2);
    for (const client of result.clientSqlite) {
      expect(client.pid).toBe(process.pid);
      expect(client.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(client.journalMode).toBe(persistent ? 'wal' : 'memory');
      expect(client.synchronous).toBe(2);
    }
    expect(result.serverMetrics.database).toMatchObject({
      backend: 'sqlite',
      journalMode: 'memory',
      synchronous: 2,
    });

    expect(result.validatedCommits).toBe(501);
    expect(result.validatedRows).toBe(32);
    expect(result.measurements['writerDatabase.close']).toBeUndefined();
    expect(result.serverMetrics.maxCommitSeq).toBe(501);
    expect(
      result.serverMetrics.measurements['realtime.notifyCommit']?.calls,
    ).toBe(501);
    expect(
      result.serverMetrics.measurements['realtime.notifyCommit']?.failures,
    ).toBe(0);
  },
);

test('method instrumentation preserves receiver, values, and rejected operations', async () => {
  class Target {
    #value = 7;
    read() {
      return this.#value;
    }
    async begin() {
      return { commit: async () => this.#value };
    }
    fail() {
      throw new Error('injected');
    }
    async reject() {
      throw new Error('rejected');
    }
  }
  const counts: Record<string, MethodMeasurement> = {};
  const measured = measureMethods(new Target(), counts, 'storage');
  expect(measured.read()).toBe(7);
  expect(await (await measured.begin()).commit()).toBe(7);
  expect(() => measured.fail()).toThrow('injected');
  await expect(measured.reject()).rejects.toThrow('rejected');
  expect(counts['storage.read']?.calls).toBe(1);
  expect(counts['transaction.commit']?.calls).toBe(1);
  expect(counts['storage.fail']?.failures).toBe(1);
  expect(counts['storage.reject']?.failures).toBe(1);
});

test.each(['engine', 'socket'] as const)(
  'notification attribution includes pushes through the hub request context (%s)',
  async (lane) => {
    const server = await createPerformanceServer(2, lane, 'sqlite');
    const clients: Awaited<ReturnType<typeof createBenchClient>>[] = [];
    try {
      const writer = await createBenchClient(server.endpoints, {
        realtime: true,
      });
      clients.push(writer);
      await writer.client.syncUntilIdle();
      await writer.client.connectRealtime();
      await writer.client.syncUntilIdle();
      await server.metrics(true);
      writer.client.mutate([
        { table: 'tasks', op: 'upsert', values: queuedValues(0, false) },
      ]);
      await writer.client.syncUntilIdle();
      const result = await server.metrics();
      expect(result.maxCommitSeq).toBe(1);
      expect(result.measurements['realtime.notifyCommit']?.calls).toBe(1);
      expect(result.measurements['realtime.notifyCommit']?.failures).toBe(0);
      expect(
        result.measurements['realtime.notifyCommit']?.elapsedMs,
      ).toBeGreaterThanOrEqual(0);
      await server.metrics(true);
      expect(
        (await server.metrics()).measurements['realtime.notifyCommit'],
      ).toBeUndefined();
    } finally {
      try {
        await closeBenchClients(clients);
      } finally {
        await server.close();
      }
    }
  },
);

test('statement instrumentation counts execution separately from preparation', () => {
  const counts: Record<string, MethodMeasurement> = {};
  const db = measureMethods(
    { query: () => ({ all: () => [1], run: () => 2 }) },
    counts,
    'serverDatabase',
  );
  const statement = db.query();
  expect(statement.all()).toEqual([1]);
  expect(statement.run()).toBe(2);
  expect(counts['serverDatabase.query']?.calls).toBe(1);
  expect(counts['serverStatement.all']?.calls).toBe(1);
  expect(counts['serverStatement.run']?.calls).toBe(1);
});

test('SQL attribution shares method timing and omits bound values on failure', () => {
  const counts: Record<string, MethodMeasurement> = {};
  const db = measureMethods(
    {
      exec(_sql: string, values: string[]) {
        if (values[0] === 'reject') throw new Error('injected');
        return values[0];
      },
    },
    counts,
    'database',
    true,
  );
  expect(db.exec('UPDATE example\nSET body = ?', ['private-body'])).toBe(
    'private-body',
  );
  expect(() => db.exec('UPDATE example SET body = ?', ['reject'])).toThrow(
    'injected',
  );
  expect(Object.keys(counts)).toEqual([
    'database.exec',
    'database.exec: UPDATE example SET body = ?',
  ]);
  expect(counts['database.exec: UPDATE example SET body = ?']).toEqual(
    counts['database.exec'],
  );
  expect(counts['database.exec']?.calls).toBe(2);
  expect(counts['database.exec']?.failures).toBe(1);
});

test.each([false, true])(
  'row counts preserve query results and exclude rejected reads (async=%s)',
  async (asyncResult) => {
    const counts: Record<string, MethodMeasurement> = {};
    const rows = [{ body: 'private-value' }, { body: 'another-private-value' }];
    const error = new Error('injected');
    const db = measureMethods(
      {
        query(_sql: string, reject: boolean) {
          if (asyncResult)
            return reject ? Promise.reject(error) : Promise.resolve(rows);
          if (reject) throw error;
          return rows;
        },
      },
      counts,
      'database',
      true,
    );
    expect(await db.query('SELECT body\nFROM fixture', false)).toBe(rows);
    expect(await db.query('SELECT body FROM fixture', false)).toBe(rows);
    try {
      await db.query('SELECT body FROM fixture', true);
      throw new Error('query did not reject');
    } catch (caught) {
      expect(caught).toBe(error);
    }
    expect(counts['database.query']?.calls).toBe(3);
    expect(counts['database.query']?.failures).toBe(1);
    expect(counts['database.query']?.rowsReturned).toBe(4);
    expect(counts['database.query: SELECT body FROM fixture']).toEqual(
      counts['database.query'],
    );
    expect(JSON.stringify(counts)).not.toContain('private-value');
  },
);

test('SQLite control attribution records SQL while prepared-statement arguments remain private', () => {
  const counts: Record<string, MethodMeasurement> = {};
  const db = measureMethods(
    {
      run(sql: string, _params: string[]) {
        return sql;
      },
    },
    counts,
    'clientSqlite',
    true,
  );
  expect(db.run('COMMIT', ['private-value'])).toBe('COMMIT');
  expect(counts['clientSqlite.run: COMMIT']?.calls).toBe(1);
  const statement = measureMethods(
    {
      run(value: string) {
        return value;
      },
    },
    counts,
    'serverStatement',
    true,
  );
  expect(statement.run('private-value')).toBe('private-value');
  expect(counts['serverStatement.run']?.calls).toBe(1);
  expect(JSON.stringify(counts)).not.toContain('private-value');
});

test('async instrumentation counts overlap and settles rejected calls without changing results', async () => {
  const counts: Record<string, MethodMeasurement> = {};
  const first = Promise.withResolvers<number>();
  const second = Promise.withResolvers<number>();
  const failure = new Error('injected');
  const target = measureMethods(
    {
      query: (sql: string) =>
        sql === 'first' ? first.promise : second.promise,
    },
    counts,
    'storage',
    true,
  );
  const a = target.query('first');
  const b = target.query('second');
  const rejected = b.catch((error: unknown) => error);
  expect(counts['storage.query']?.pending).toBe(2);
  expect(counts['storage.query']?.maxPending).toBe(2);
  expect(counts['storage.query']?.overlappingCalls).toBe(1);
  expect(counts['storage.query: first']?.maxPending).toBe(1);
  second.reject(failure);
  expect(await rejected).toBe(failure);
  expect(counts['storage.query']?.pending).toBe(1);
  first.resolve(42);
  expect(await a).toBe(42);
  expect(counts['storage.query']?.pending).toBe(0);
  expect(counts['storage.query']?.maxPending).toBe(2);
  expect(counts['storage.query']?.failures).toBe(1);
});

test('resetting measurements keeps a preceding pending call outside the new epoch', async () => {
  const counts: Record<string, MethodMeasurement> = {};
  const preceding = Promise.withResolvers<number>();
  const current = Promise.withResolvers<number>();
  const target = measureMethods(
    { query: (old: boolean) => (old ? preceding.promise : current.promise) },
    counts,
    'storage',
  );
  const a = target.query(true);
  const previous = counts['storage.query'];
  delete counts['storage.query'];
  const b = target.query(false);
  preceding.resolve(1);
  expect(await a).toBe(1);
  expect(previous?.pending).toBe(0);
  expect(counts['storage.query']?.pending).toBe(1);
  expect(counts['storage.query']?.maxPending).toBe(1);
  expect(counts['storage.query']?.overlappingCalls).toBe(0);
  current.resolve(2);
  expect(await b).toBe(2);
  expect(counts['storage.query']?.pending).toBe(0);
  expect(counts['storage.query']?.calls).toBe(1);
});
