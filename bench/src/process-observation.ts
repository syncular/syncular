import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  observationFixture,
  assertObservationRows,
  assertObservationOutcomes,
  sqliteConfiguration,
  SQLITE_CONFIGURATION_SQL,
} from './fixture';
import {
  createProcessDriver,
  processObject,
  assertProcessSync,
  processPhases,
  processSampling,
} from './process-driver';
import { closeBenchClients } from './loopback';
import { startSocketServer } from './socket-server';

export async function runProcessObservation(options: {
  binary: string | readonly string[];
  core: 'ts' | 'rust';
  rows: number;
  readers: number;
  persistent: boolean;
  reconnect: boolean;
  backend: 'sqlite' | 'postgres';
  boundary: 'direct' | 'command';
  nativeSql?: boolean;
  nativePhases?: boolean;
  tsProfile?: boolean;
}) {
  if (options.core === 'ts' && options.boundary !== 'direct')
    throw new Error('TS observation requires the direct boundary');
  if ((options.nativeSql || options.nativePhases) && options.core !== 'rust')
    throw new Error('Native diagnostics require Rust socket clients');
  if (options.tsProfile && options.core !== 'ts')
    throw new Error('TS sampling requires TS socket clients');
  const directory = await mkdtemp(
    join(tmpdir(), 'syncular-process-observation-'),
  );
  const server = await startSocketServer(options.rows, options.backend).catch(
    async (error: unknown) => {
      await rm(directory, { recursive: true, force: true });
      throw error;
    },
  );
  const clients: Array<Awaited<ReturnType<typeof createProcessDriver>>> = [];
  const clientSqlite = [];
  try {
    for (let index = 0; index <= options.readers; index++) {
      const client = await createProcessDriver(
        options.binary,
        server.endpoints,
        options.persistent ? join(directory, `${index}.sqlite`) : undefined,
      );
      clients.push(client);
      if (
        client.pid === process.pid ||
        clients.slice(0, -1).some((other) => other.pid === client.pid)
      )
        throw new Error('Observation clients must own distinct processes');
      clientSqlite.push({
        role: index === 0 ? 'writer' : `reader-${index}`,
        pid: client.pid,
        clientId: client.clientId,
        ...sqliteConfiguration(
          processObject(
            await client.invoke('query', {
              sql: SQLITE_CONFIGURATION_SQL,
            }),
          ).rows,
          options.persistent,
        ),
      });
      assertProcessSync(await client.invoke('syncUntilIdle'));
      if (index > 0) {
        await client.invoke('connectRealtime');
        assertProcessSync(await client.invoke('syncUntilIdle'));
        if (options.reconnect) await client.invoke('disconnectRealtime');
      }
    }
    const writer = clients[0];
    if (!writer) throw new Error('Native observation writer missing');
    const readers = clients.slice(1);
    const count = options.reconnect ? 100 : 1;
    const initialSeq = (await server.metrics()).maxCommitSeq;
    const fixture = observationFixture(options.rows, count);
    const sql =
      'SELECT id, project_id, title, done, priority, updated_at_ms FROM tasks ORDER BY id';
    for (const client of clients)
      assertObservationRows(
        processObject(await client.invoke('query', { sql })).rows,
        fixture.initial,
      );
    const constructed = processObject(
      await writer.invoke('benchMutate', {
        commits: fixture.commits,
        mode: options.boundary,
      }),
    );
    const ids = constructed.ids;
    if (
      !Array.isArray(ids) ||
      ids.length !== count ||
      ids.some((id) => typeof id !== 'string') ||
      new Set(ids).size !== count
    )
      throw new Error('Observation commit identities differ from fixture');
    assertObservationRows(
      processObject(await writer.invoke('query', { sql })).rows,
      fixture.expected,
    );
    let applied: unknown;
    if (options.reconnect)
      applied = assertProcessSync(
        await writer.invoke('syncUntilIdle'),
        count,
      ).applied;
    const expected = JSON.stringify(fixture.expected);
    for (const client of clients)
      await client.invoke('stats', {
        reset: true,
        ...(options.nativeSql ? { sqlCounts: true } : {}),
        ...(options.nativePhases ? { phases: true } : {}),
        ...(options.tsProfile ? { sampling: true } : {}),
      });
    await server.metrics(true);
    const started = performance.now();
    const waits = readers.map(async (reader) => {
      let reconnectSync: Record<string, unknown> | undefined;
      if (options.reconnect) {
        await reader.invoke('connectRealtime');
        reconnectSync = processObject(
          await reader.invoke('benchSync', { mode: options.boundary }),
        );
        assertProcessSync(reconnectSync.outcome);
        if (
          typeof reconnectSync.elapsedNs !== 'number' ||
          !Number.isFinite(reconnectSync.elapsedNs) ||
          reconnectSync.elapsedNs > Number.MAX_SAFE_INTEGER ||
          reconnectSync.elapsedNs < 0
        )
          throw new Error('Reconnect sync duration is invalid');
      }
      const result = processObject(
        await reader.invoke('waitForAck', { cursor: initialSeq + count }),
      );
      const observation: Record<string, unknown> = {
        ...result,
        ...(reconnectSync ? { reconnectSync } : {}),
      };
      return {
        elapsedMs: performance.now() - started,
        result: observation,
      };
    });
    const completion = Promise.all(waits);
    void completion.catch(() => undefined);
    if (!options.reconnect)
      applied = assertProcessSync(
        processObject(
          await writer.invoke('benchSync', { mode: options.boundary }),
        ).outcome,
        count,
      ).applied;
    const observations = await completion;
    const allReadersMs = performance.now() - started;
    const writerStats = processObject(
      await writer.invoke(
        'stats',
        options.tsProfile ? { sampling: false } : {},
      ),
    );
    if (options.nativePhases || options.tsProfile) {
      if (options.nativePhases)
        writerStats.phases = processPhases(writerStats.phases);
      else writerStats.sampling = processSampling(writerStats.sampling);
      for (const [index, reader] of readers.entries()) {
        const stats = processObject(
          await reader.invoke(
            'stats',
            options.tsProfile ? { sampling: false } : {},
          ),
        );
        if (options.nativePhases) stats.phases = processPhases(stats.phases);
        else stats.sampling = processSampling(stats.sampling);
        observations[index]!.result.stats = stats;
      }
    }
    if (options.nativeSql || options.nativePhases)
      for (const client of clients)
        await client.invoke('stats', {
          ...(options.nativeSql ? { sqlCounts: false } : {}),
          ...(options.nativePhases ? { phases: false } : {}),
        });
    const serverMetrics = await server.metrics();
    if (
      JSON.stringify(applied) !== JSON.stringify(ids) ||
      serverMetrics.maxCommitSeq !== initialSeq + count
    )
      throw new Error(
        'Observation outcomes or server sequence differ from fixture',
      );
    assertObservationOutcomes(
      processObject(await writer.invoke('commitOutcomes')).outcomes,
      ids,
    );
    for (const client of clients) {
      assertObservationRows(
        processObject(await client.invoke('query', { sql })).rows,
        fixture.expected,
      );
      if (processObject(await client.invoke('statusSnapshot')).outbox !== 0)
        throw new Error('Observation client retains queued writes');
    }
    await closeBenchClients(clients);
    return {
      perReaderMs: observations.map((value) => value.elapsedMs),
      allReadersMs,
      observations: observations.map((value) => value.result),
      serverMetrics,
      writerStats,
      clientSqlite,
      executionModel: 'isolated-client-processes',
      nativeSql: options.nativeSql ?? false,
      nativePhases: options.nativePhases ?? false,
      tsProfile: options.tsProfile ?? false,
      clientResources: clients.map((client, index) => ({
        role: index === 0 ? 'writer' : `reader-${index}`,
        ...client.resourceUsage(),
      })),
      validatedReaders: readers.length,
      validatedCommits: count,
      validatedRows: fixture.expected.length,
      validatedCommitIds: ids,
      validation: 'independent-fixture-and-original-outcomes',
      digest: createHash('sha256').update(expected).digest('hex'),
      boundaries: `Socket ${options.reconnect ? 'reconnect' : 'fanout'}, ${options.core} ${options.boundary}. Every writer and reader owns a separate client process; the server also owns a separate process. Parent elapsed includes command delivery and result receipt; client phase clocks remain local. Readiness uses applied acknowledgements and transport notifications without query polling. reconnectSync.elapsedNs covers the client's explicit sync after reconnect; the following waitForAck elapsedNs covers only the subsequent acknowledgement wait. Both are nested within parent elapsed and must not be added to it. Native SQL diagnostics are opt-in: statement verbs and pre-commit/rollback hook counts cover reset through the acknowledgement snapshot, excluding setup and final validation. Commit hooks include outermost savepoint release and implicit writes, and do not prove durable commits. SQLite tracing expands SQL internally before retaining only fixed verb counts; instrumented timings include that overhead. Final SQL validation is excluded. clientSqlite records actual version, journal mode, and synchronous setting for each client. clientResources records OS CPU and peak RSS separately for each client from launch through exit, including setup, validation, stdio, and shutdown. It excludes the server and controller. Peak RSS is a lifetime high-water mark; reader peaks cannot be added into simultaneous memory usage.`,
    };
  } finally {
    try {
      await closeBenchClients(clients);
    } finally {
      try {
        await server.close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
}
