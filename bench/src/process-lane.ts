import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canonicalTaskRows,
  queuedValues,
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
import { createPerformanceServer } from './socket-server';
import { createEngineDriver } from './engine-driver';

export async function runProcessReplay(options: {
  binary: string | readonly string[];
  core: 'ts' | 'rust';
  rows: number;
  commits: number;
  repeated: boolean;
  persistent: boolean;
  backend: 'sqlite' | 'postgres';
  boundary: 'direct' | 'command';
  engineLibrary?: string;
  nativeSql?: boolean;
  nativePhases?: boolean;
  tsProfile?: boolean;
  restart?: boolean;
  mixed?: { firstOperations: 499 | 500; rejectMiddle: boolean };
}) {
  if (options.tsProfile && (options.core !== 'ts' || options.engineLibrary))
    throw new Error('TS sampling requires TS socket clients');
  if (
    (options.nativeSql || options.nativePhases) &&
    (options.core !== 'rust' || options.engineLibrary)
  )
    throw new Error('Native diagnostics require Rust socket clients');
  if (
    options.engineLibrary &&
    (options.core !== 'rust' || options.restart || options.mixed)
  )
    throw new Error('Rust engine currently supports ordinary replay');
  const directory = await mkdtemp(join(tmpdir(), 'syncular-process-replay-'));
  const server = await createPerformanceServer(
    options.rows,
    options.engineLibrary ? 'engine' : 'socket',
    options.backend,
    options.mixed ? { rejectMiddle: options.mixed.rejectMiddle } : {},
  ).catch(async (error: unknown) => {
    await rm(directory, { recursive: true, force: true });
    throw error;
  });
  const clients: Array<
    | Awaited<ReturnType<typeof createProcessDriver>>
    | Awaited<ReturnType<typeof createEngineDriver>>
  > = [];
  const clientSqlite = [];
  try {
    for (const name of ['writer', 'reader']) {
      const path = options.persistent
        ? join(directory, `${name}.sqlite`)
        : undefined;
      const client =
        'syncUrl' in server.endpoints
          ? await createProcessDriver(options.binary, server.endpoints, path)
          : await createEngineDriver(
              options.engineLibrary ?? '',
              server.endpoints,
              path,
            );
      clients.push(client);
      clientSqlite.push({
        role:
          name === 'writer' && options.restart ? 'writer-before-restart' : name,
        pid: 'pid' in client ? client.pid : process.pid,
        clientId: client.clientId,
        ...('info' in client ? { threadId: client.info.threadId } : {}),
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
    }
    let writer = clients[0];
    const reader = clients[1];
    if (!writer || !reader)
      throw new Error('Process benchmark clients missing');
    await reader.invoke('connectRealtime');
    assertProcessSync(await reader.invoke('syncUntilIdle'));
    const sql =
      'SELECT id, project_id, title, done, priority, updated_at_ms FROM tasks ORDER BY id';
    const expected = new Map(
      canonicalTaskRows(
        processObject(await writer.invoke('query', { sql })).rows,
      ).map((row) => [row.id, row]),
    );
    if (expected.size !== options.rows)
      throw new Error('Process bootstrap row count differs from fixture');
    const sqlite = clientSqlite[0]!;
    const offlineSeq = (await server.metrics()).maxCommitSeq;
    if (options.mixed && options.commits !== 3)
      throw new Error('Mixed fixture requires three commits');
    const optimistic = new Map(expected);
    const operationCounts = options.mixed
      ? [options.mixed.firstOperations, 2, 1]
      : Array.from({ length: options.commits }, () => 1);
    const commits = operationCounts.map((count, commitIndex) => ({
      mutations: Array.from({ length: count }, (_, opIndex) => {
        const values = options.mixed
          ? queuedValues(
              commitIndex === 0
                ? opIndex
                : commitIndex === 1 && opIndex === 1
                  ? options.mixed.firstOperations
                  : commitIndex === 2
                    ? 1
                    : 0,
              false,
            )
          : queuedValues(commitIndex, options.repeated);
        if (options.mixed && commitIndex > 0)
          values.title =
            commitIndex === 2
              ? 'after-middle'
              : opIndex === 1 && options.mixed.rejectMiddle
                ? 'bench-reject-middle'
                : 'middle-edit';
        optimistic.set(values.id, { ...values, done: 0 });
        if (!(options.mixed?.rejectMiddle && commitIndex === 1))
          expected.set(values.id, { ...values, done: 0 });
        return { op: 'upsert', table: 'tasks', values };
      }),
    }));
    const constructionStarted = performance.now();
    const constructed = processObject(
      await writer.invoke('benchMutate', { commits, mode: options.boundary }),
    );
    const constructionMs = performance.now() - constructionStarted;
    const ids = constructed.ids;
    const samples = constructed.nsPerCommit;
    if (
      !Array.isArray(ids) ||
      ids.length !== options.commits ||
      ids.some((id) => typeof id !== 'string') ||
      new Set(ids).size !== ids.length ||
      !Array.isArray(samples) ||
      samples.length !== ids.length ||
      samples.some(
        (sample) =>
          typeof sample !== 'number' || !Number.isFinite(sample) || sample < 0,
      )
    ) {
      throw new Error('Process mutation result differs from fixture');
    }
    if (
      processObject(await writer.invoke('statusSnapshot')).outbox !==
      options.commits
    )
      throw new Error('Process outbox count differs from fixture');
    const optimisticJson = JSON.stringify(
      canonicalTaskRows([...optimistic.values()]),
    );
    if (
      JSON.stringify(
        canonicalTaskRows(
          processObject(await writer.invoke('query', { sql })).rows,
        ),
      ) !== optimisticJson
    )
      throw new Error('Offline optimistic rows differ from fixture');
    let reopenMs: number | undefined;
    let terminatedResources:
      | ReturnType<
          Awaited<ReturnType<typeof createProcessDriver>>['resourceUsage']
        >
      | undefined;
    let restartProcess:
      | {
          killedPid: number;
          reopenedPid: number;
          signal: string;
          clientId: string;
        }
      | undefined;
    if (options.restart) {
      if (!('terminate' in writer) || !('syncUrl' in server.endpoints))
        throw new Error('Restart requires isolated client processes');
      if (!options.persistent)
        throw new Error('Restart requires persistent client storage');
      const identity = writer.clientId;
      const terminated = await writer.terminate();
      terminatedResources = writer.resourceUsage();
      clients.splice(0, 1);
      const reopenStarted = performance.now();
      writer = await createProcessDriver(
        options.binary,
        server.endpoints,
        join(directory, 'writer.sqlite'),
        identity,
      );
      clients.unshift(writer);
      reopenMs = performance.now() - reopenStarted;
      clientSqlite.push({
        role: 'writer',
        pid: writer.pid,
        clientId: writer.clientId,
        ...sqliteConfiguration(
          processObject(
            await writer.invoke('query', {
              sql: SQLITE_CONFIGURATION_SQL,
            }),
          ).rows,
          true,
        ),
      });
      if (writer.pid === terminated.pid)
        throw new Error('Restart reused the writer process');
      restartProcess = {
        killedPid: terminated.pid,
        reopenedPid: writer.pid,
        signal: terminated.signal,
        clientId: identity,
      };
      if (
        processObject(await writer.invoke('statusSnapshot')).outbox !==
          options.commits ||
        JSON.stringify(
          canonicalTaskRows(
            processObject(await writer.invoke('query', { sql })).rows,
          ),
        ) !== optimisticJson
      ) {
        throw new Error(
          'Persisted offline queue changed after process termination',
        );
      }
    }
    const replayStart = await server.metrics(true);
    if (replayStart.maxCommitSeq !== offlineSeq)
      throw new Error(
        'Offline construction or reopen contacted the server to push',
      );
    const rejectedIds: string[] = options.mixed?.rejectMiddle ? [ids[1]] : [];
    const appliedIds = ids.filter((id) => !rejectedIds.includes(id));
    const expectedSeq = offlineSeq + appliedIds.length;
    for (const client of [writer, reader])
      await client.invoke('stats', {
        reset: true,
        ...(options.nativeSql ? { sqlCounts: true } : {}),
        ...(options.nativePhases ? { phases: true } : {}),
        ...(options.tsProfile ? { sampling: true } : {}),
      });
    const started = performance.now();
    const visible = reader
      .invoke('waitForAck', { cursor: expectedSeq })
      .then((result) => ({
        result: processObject(result),
        elapsedMs: performance.now() - started,
      }));
    // Attach a rejection handler immediately; cleanup still waits for the reader.
    void visible.catch(() => undefined);
    const replayed = processObject(
      await writer.invoke('benchSync', { mode: options.boundary }),
    );
    const drainedMs = performance.now() - started;
    const report = assertProcessSync(
      replayed.outcome,
      appliedIds.length,
      rejectedIds,
    );
    if (JSON.stringify(report.applied) !== JSON.stringify(appliedIds))
      throw new Error(
        'Applied outcomes differ from the original commit identities',
      );
    const observed = await visible;
    const stats =
      options.nativeSql || options.nativePhases || options.tsProfile
        ? processObject(
            await writer.invoke(
              'stats',
              options.tsProfile ? { sampling: false } : {},
            ),
          )
        : processObject(replayed.stats);
    if (options.nativeSql || options.nativePhases || options.tsProfile) {
      observed.result.stats = processObject(
        await reader.invoke(
          'stats',
          options.tsProfile ? { sampling: false } : {},
        ),
      );
      if (options.tsProfile) {
        stats.sampling = processSampling(stats.sampling);
        const readerStats = processObject(observed.result.stats);
        readerStats.sampling = processSampling(readerStats.sampling);
      }
      if (options.nativePhases) {
        stats.phases = processPhases(stats.phases);
        const readerStats = processObject(observed.result.stats);
        readerStats.phases = processPhases(readerStats.phases);
      }
      if (options.nativeSql || options.nativePhases)
        for (const client of [writer, reader])
          await client.invoke('stats', {
            ...(options.nativeSql ? { sqlCounts: false } : {}),
            ...(options.nativePhases ? { phases: false } : {}),
          });
    }
    const serverMetrics = await server.metrics();
    if (serverMetrics.maxCommitSeq !== expectedSeq)
      throw new Error(
        'Rejected or replayed commits changed the durable sequence',
      );
    if (processObject(await writer.invoke('statusSnapshot')).outbox !== 0)
      throw new Error('Process queue did not drain');
    const pushes = stats.pushes;
    if (
      !Array.isArray(pushes) ||
      pushes.some(
        (request) =>
          !Array.isArray(request) ||
          request.some(
            (commit) =>
              !Array.isArray(commit) ||
              commit.length !== 2 ||
              !Number.isInteger(commit[1]) ||
              commit[1] < 1,
          ),
      )
    ) {
      throw new Error('Process transport returned invalid commit boundaries');
    }
    const expectedPushes = options.mixed
      ? [
          [[ids[0], options.mixed.firstOperations]],
          [
            [ids[1], 2],
            [ids[2], 1],
          ],
        ]
      : Array.from({ length: Math.ceil(options.commits / 500) }, (_, index) =>
          ids.slice(index * 500, (index + 1) * 500).map((id) => [id, 1]),
        );
    if (JSON.stringify(pushes) !== JSON.stringify(expectedPushes)) {
      throw new Error('Process replay changed FIFO request prefixes');
    }
    let rejectedOutcome: Record<string, unknown> | undefined;
    if (rejectedIds.length) {
      rejectedOutcome = processObject(
        processObject(
          await writer.invoke('commitOutcome', {
            clientCommitId: rejectedIds[0],
          }),
        ).outcome,
      );
      if (
        rejectedOutcome.status !== 'rejected' ||
        rejectedOutcome.clientCommitId !== rejectedIds[0] ||
        !Array.isArray(rejectedOutcome.results)
      )
        throw new Error('Missing durable rejected commit outcome');
      const failure = rejectedOutcome.results.find((result: unknown) => {
        const operation = processObject(result);
        if (operation.status !== 'error') return false;
        const rejection = processObject(operation.rejection);
        return (
          rejection.code === 'bench.middle_rejected' &&
          rejection.opIndex === 1 &&
          rejection.retryable === false
        );
      });
      if (!failure)
        throw new Error('Rejected middle commit lost its validator outcome');
    }
    const expectedJson = JSON.stringify(
      canonicalTaskRows([...expected.values()]),
    );
    for (const client of clients) {
      if (
        JSON.stringify(
          canonicalTaskRows(
            processObject(await client.invoke('query', { sql })).rows,
          ),
        ) !== expectedJson
      )
        throw new Error('Process replay final rows differ from fixture');
    }
    if (
      typeof replayed.elapsedNs !== 'number' ||
      !Number.isFinite(replayed.elapsedNs) ||
      replayed.elapsedNs < 0
    )
      throw new Error('Process drain duration missing');
    const operationConstructionMs =
      samples.reduce((sum: number, ns: number) => sum + ns, 0) / 1_000_000;
    const operationDrainMs = replayed.elapsedNs / 1_000_000;
    await closeBenchClients(clients);
    return {
      constructionMs,
      drainedMs,
      readerVisibleMs: observed.elapsedMs,
      operationConstructionMs,
      operationDrainMs,
      // Retain the original Rust artifact fields for existing comparison scripts.
      ...(options.core === 'rust'
        ? {
            nativeConstructionMs: operationConstructionMs,
            nativeDrainMs: operationDrainMs,
          }
        : {}),
      ...(reopenMs === undefined
        ? {}
        : {
            reopenMs,
            restartProcess,
            restart:
              'SIGKILL followed by fresh process, preserved identity and file',
          }),
      nsPerCommit: samples,
      writerStats: stats,
      readerObservation: observed.result,
      serverMetrics,
      sqlite,
      clientSqlite,
      clientResources: [
        ...(terminatedResources
          ? [{ role: 'writer-before-restart', ...terminatedResources }]
          : []),
        ...clients.flatMap((client, index) =>
          'resourceUsage' in client
            ? [
                {
                  role: index === 0 ? 'writer' : 'reader',
                  ...client.resourceUsage(),
                },
              ]
            : [],
        ),
      ],
      ...(options.engineLibrary
        ? {
            engineClients: clients.map((client, index) => {
              if (!('info' in client))
                throw new Error('Engine client metadata missing');
              return {
                role: index === 0 ? 'writer' : 'reader',
                ...client.info,
                delivery: client.deliveryStats(),
              };
            }),
          }
        : {}),
      validatedCommits: ids.length,
      validatedOperations: operationCounts.reduce(
        (sum, count) => sum + count,
        0,
      ),
      appliedCommits: appliedIds.length,
      rejectedCommits: rejectedIds.length,
      ...(options.mixed ? { operationCounts, rejectedOutcome } : {}),
      validatedRows: expected.size,
      digest: createHash('sha256').update(expectedJson).digest('hex'),
      boundaries: options.engineLibrary
        ? `Engine lane, Rust ${options.boundary}. Rust clients run on distinct Bun worker threads in the server/controller process. Private C ABI callbacks exchange SSP2 with the real async server and realtime session through a shared response buffer. Operation times exclude outer command JSON and worker delivery, but include host callback, worker scheduling, SSP2 copying, and server time. Reader completion uses applied cursor acknowledgements. Host callback time overlaps native operation time. Final SQL validation is excluded. serverMetrics CPU and RSS cover the shared process, including both clients and controller; no per-client OS resource attribution is available. This private bridge does not measure the shipping FFI boundary.`
        : `Socket lane, ${options.core} ${options.boundary}. Each client and server owns a separate process. Operation times exclude controller IPC. Reader completion uses the shipping transport's applied cursor acknowledgement; no query polling. Reader elapsed includes waiting for writer restoration and controller receipt. Reopen includes process launch and client setup. Final SQL comparison is excluded. clientResources records OS CPU and peak RSS separately for each client from launch through exit, including setup, validation, stdio, and shutdown. It excludes the server and controller. Peak RSS is a lifetime high-water mark; reader peaks cannot be added into simultaneous memory usage.`,
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
