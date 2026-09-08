import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBunDatabase } from '@syncular/client/bun';
import { createPerformanceServer } from './socket-server';
import {
  createBenchClient,
  closeBenchClients,
  type BenchClient,
} from './loopback';
import {
  measureMethods,
  withinDeadline,
  type MethodMeasurement,
} from './instrumentation';
import {
  observationFixture,
  assertObservationRows,
  assertObservationOutcomes,
  sqliteConfiguration,
  SQLITE_CONFIGURATION_SQL,
} from './fixture';

export async function runObservationLane(options: {
  readers: number;
  rows: number;
  reconnect: boolean;
  persistent: boolean;
  lane: 'engine';
  backend: 'sqlite' | 'postgres';
}) {
  const directory = await mkdtemp(join(tmpdir(), 'syncular-observation-'));
  const server = await createPerformanceServer(
    options.rows,
    options.lane,
    options.backend,
  ).catch(async (error: unknown) => {
    await rm(directory, { recursive: true, force: true });
    throw error;
  });
  const handles: BenchClient[] = [];
  const clientSqlite = [];
  const subscriptions: Array<() => void> = [];
  const pending = new Set<Promise<void>>();
  const errors: unknown[] = [];
  const measurements: Record<string, MethodMeasurement> = {};
  const observations = Array.from({ length: options.readers }, () => ({
    changes: 0,
  }));
  try {
    for (let index = 0; index <= options.readers; index++) {
      const handle = await createBenchClient(server.endpoints, {
        realtime: index > 0,
        database: measureMethods(
          openBunDatabase(
            options.persistent
              ? join(directory, `${index}.sqlite`)
              : ':memory:',
          ),
          measurements,
          `client${index}`,
        ),
      });
      handles.push(handle);
      clientSqlite.push({
        role: index === 0 ? 'writer' : `reader-${index}`,
        pid: process.pid,
        clientId: handle.client.clientId,
        ...sqliteConfiguration(
          handle.client.query(SQLITE_CONFIGURATION_SQL),
          options.persistent,
        ),
      });
      await handle.client.syncUntilIdle();
      if (index > 0) {
        await handle.client.connectRealtime();
        await handle.client.syncUntilIdle();
        if (options.reconnect) handle.client.disconnectRealtime();
      }
    }
    const writer = handles[0];
    if (!writer) throw new Error('Observation writer missing');
    const readers = handles.slice(1);
    const commits = options.reconnect ? 100 : 1;
    const initialSeq = (await server.metrics()).maxCommitSeq;
    const fixture = observationFixture(options.rows, commits);
    const sql =
      'SELECT id, project_id, title, done, priority, updated_at_ms FROM tasks ORDER BY id';
    for (const handle of handles)
      assertObservationRows(handle.client.query(sql), fixture.initial);
    const ids = fixture.commits.map((commit) =>
      writer.client.mutate(commit.mutations),
    );
    if (new Set(ids).size !== commits)
      throw new Error('Observation commit identities are not distinct');
    assertObservationRows(writer.client.query(sql), fixture.expected);
    if (options.reconnect) await writer.client.syncUntilIdle();
    const expected = JSON.stringify(fixture.expected);
    for (const key of Object.keys(measurements)) delete measurements[key];
    await server.metrics(true);
    const beforeCpu = process.cpuUsage();
    const rssBefore = process.memoryUsage().rss;
    const started = performance.now();
    const drives: Array<() => Promise<void>> = [];
    const completions = readers.map((reader, index) => {
      subscriptions.push(
        reader.client.onChange(() => {
          const observation = observations[index];
          if (observation) observation.changes++;
        }),
      );
      let current: Promise<void> | undefined;
      const drive = () => {
        if (current) return current;
        const job = reader.client
          .syncUntilIdle()
          .then(() => undefined)
          .catch((error: unknown) => {
            errors.push(error);
          })
          .finally(() => {
            current = undefined;
            pending.delete(job);
          });
        current = job;
        pending.add(job);
        return job;
      };
      drives.push(drive);
      subscriptions.push(
        reader.client.onSyncNeeded(() => {
          void drive();
        }),
      );
      return reader
        .waitForAck(initialSeq + commits)
        .then(() => performance.now() - started);
    });
    if (options.reconnect) {
      await withinDeadline(
        Promise.all(
          readers.map(async (reader, index) => {
            await reader.client.connectRealtime();
            await drives[index]?.();
          }),
        ),
        'reconnect catch-up',
      );
    } else {
      const result = await withinDeadline(
        writer.client.syncUntilIdle(),
        'fanout writer drain',
      );
      if (
        result.rejected.length ||
        result.conflicts.length ||
        result.retryable.length
      )
        throw new Error('Fanout write failed');
    }
    const perReaderMs = await withinDeadline(
      Promise.all(completions),
      'all readers visible',
    );
    const allReadersMs = performance.now() - started;
    const cpu = process.cpuUsage(beforeCpu);
    const rssAfter = process.memoryUsage().rss;
    await withinDeadline(
      Promise.all(pending),
      'observation catch-up completion',
    );
    if (errors.length) throw errors[0];
    const phaseMeasurements = structuredClone(measurements);
    const serverMetrics = await server.metrics();
    if (serverMetrics.maxCommitSeq !== initialSeq + commits)
      throw new Error(
        'Observation outcomes or server sequence differ from fixture',
      );
    assertObservationOutcomes(writer.client.commitOutcomes(), ids);
    for (const handle of handles) {
      assertObservationRows(handle.client.query(sql), fixture.expected);
      if (handle.client.statusSnapshot().outbox !== 0)
        throw new Error('Observation client retains queued writes');
    }
    return {
      perReaderMs,
      allReadersMs,
      observations,
      clientSqlite,
      executionModel: 'shared-process',
      measurements: phaseMeasurements,
      serverMetrics,
      cpuMs: (cpu.user + cpu.system) / 1000,
      rssBefore,
      rssAfter,
      validatedReaders: readers.length,
      validatedCommits: commits,
      validatedRows: fixture.expected.length,
      validatedCommitIds: ids,
      validation: 'independent-fixture-and-original-outcomes',
      digest: createHash('sha256').update(expected).digest('hex'),
      boundaries: `${options.lane} ${options.reconnect ? 'reconnect' : 'fanout'}: full TS clients. Completion is each client sending its applied cursor acknowledgement; final SQL comparison is excluded. Change callbacks count events without querying. Client process CPU includes all readers; engine server CPU overlaps.`,
    };
  } finally {
    for (const unsubscribe of subscriptions) unsubscribe();
    try {
      await withinDeadline(Promise.all(pending), 'observation cleanup');
    } finally {
      try {
        await closeBenchClients(handles);
      } finally {
        try {
          await server.close();
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      }
    }
  }
}
