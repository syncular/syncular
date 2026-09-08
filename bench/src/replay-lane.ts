import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBunDatabase } from '@syncular/client/bun';
import { decodeMessage } from '@syncular/core';
import { handleSyncRequest } from '@syncular/server';
import { httpSyncTransport } from '@syncular/client';
import { createPerformanceServer } from './socket-server';
import {
  createBenchClient,
  closeBenchClients,
  type BenchClient,
} from './loopback';
import {
  queuedValues,
  sqliteConfiguration,
  SQLITE_CONFIGURATION_SQL,
} from './fixture';

import {
  measureMethods,
  withinDeadline,
  type MethodMeasurement,
} from './instrumentation';

export async function runReplayLane(options: {
  commits: number;
  repeated: boolean;
  persistent: boolean;
  rows: number;
  lane: 'engine' | 'socket';
  backend: 'sqlite' | 'postgres';
}) {
  const directory = await mkdtemp(join(tmpdir(), 'syncular-replay-'));
  const measurements: Record<string, MethodMeasurement> = {};
  const server = await createPerformanceServer(
    options.rows,
    options.lane,
    options.backend,
  ).catch(async (error: unknown) => {
    await rm(directory, { recursive: true, force: true });
    throw error;
  });
  const endpoints = server.endpoints;
  const transport =
    'syncUrl' in endpoints
      ? httpSyncTransport(endpoints.syncUrl)
      : (bytes: Uint8Array) => handleSyncRequest(bytes, endpoints.ctx);
  const handles: BenchClient[] = [];
  let unsubscribe: (() => void) | undefined;
  let catchup: Promise<void> | undefined;
  let catchupError: unknown;
  const requests: string[][] = [];
  let requestBytes = 0;
  let responseBytes = 0;
  let transportMs = 0;
  try {
    const writer = await createBenchClient(endpoints, {
      database: measureMethods(
        openBunDatabase(
          options.persistent ? join(directory, 'writer.sqlite') : ':memory:',
        ),
        measurements,
        'writerDatabase',
      ),
      transport: async (bytes) => {
        const message = decodeMessage(bytes);
        if (message.msgKind !== 'request')
          throw new Error('Expected sync request');
        const commits = message.frames.filter(
          (frame) => frame.type === 'PUSH_COMMIT',
        );
        if (commits.length > 0)
          requests.push(commits.map((commit) => commit.clientCommitId));
        requestBytes += bytes.byteLength;
        const started = performance.now();
        const response = await transport(bytes);
        transportMs += performance.now() - started;
        responseBytes += response.byteLength;
        return response;
      },
    });
    handles.push(writer);
    const reader = await createBenchClient(endpoints, {
      realtime: true,
      database: measureMethods(
        openBunDatabase(
          options.persistent ? join(directory, 'reader.sqlite') : ':memory:',
        ),
        measurements,
        'readerDatabase',
      ),
    });
    handles.push(reader);
    const clientSqlite = handles.map((handle, index) => ({
      role: index === 0 ? 'writer' : 'reader',
      pid: process.pid,
      clientId: handle.client.clientId,
      ...sqliteConfiguration(
        handle.client.query(SQLITE_CONFIGURATION_SQL),
        options.persistent,
      ),
    }));
    await writer.client.syncUntilIdle();
    await reader.client.syncUntilIdle();
    await reader.client.connectRealtime();
    unsubscribe = reader.client.onSyncNeeded(() => {
      if (catchup !== undefined) return;
      catchup = reader.client
        .syncUntilIdle(options.commits + 10)
        .then(() => undefined)
        .catch((error: unknown) => {
          catchupError = error;
        })
        .finally(() => {
          catchup = undefined;
        });
    });
    const columns = 'id, project_id, title, done, priority, updated_at_ms';
    const expected = new Map(
      writer.client
        .query(`SELECT ${columns} FROM tasks ORDER BY id`)
        .map((row) => [String(row.id), row]),
    );
    const sqlite = clientSqlite[0]!;
    const ids: string[] = [];
    const constructionStart = performance.now();
    for (let index = 0; index < options.commits; index++) {
      const values = queuedValues(index, options.repeated);
      ids.push(
        writer.client.mutate([{ table: 'tasks', op: 'upsert', values }]),
      );
      expected.set(values.id, { ...values, done: 0 });
    }
    const constructionMs = performance.now() - constructionStart;
    if (writer.client.statusSnapshot().outbox !== options.commits)
      throw new Error('Queue construction mismatch');
    const expectedSeq =
      (await server.metrics(true)).maxCommitSeq + options.commits;
    for (const key of Object.keys(measurements)) delete measurements[key];
    requestBytes = 0;
    responseBytes = 0;
    transportMs = 0;
    const usageBefore = process.cpuUsage();
    const rssBefore = process.memoryUsage().rss;
    const started = performance.now();
    const visible = reader
      .waitForAck(expectedSeq)
      .then(() => performance.now() - started);
    const summary = await withinDeadline(
      writer.client.syncUntilIdle(options.commits + 10),
      'writer drain',
    );
    const drainedMs = performance.now() - started;
    // A final drive handles a wake that arrived as the previous catch-up completed.
    await catchup;
    if (catchupError !== undefined) throw catchupError;
    if (reader.client.statusSnapshot().syncNeeded)
      await reader.client.syncUntilIdle(options.commits + 10);
    const readerVisibleMs = await withinDeadline(visible, 'reader convergence');
    const phaseMeasurements = structuredClone(measurements);
    const cpu = process.cpuUsage(usageBefore);
    const rssAfter = process.memoryUsage().rss;
    const serverMetrics = await server.metrics();
    if (
      summary.rejected.length ||
      summary.conflicts.length ||
      summary.retryable.length ||
      writer.client.statusSnapshot().outbox !== 0
    ) {
      throw new Error('Replay did not drain every commit successfully');
    }
    if (JSON.stringify(requests.flat()) !== JSON.stringify(ids))
      throw new Error('Push commit order changed');
    if (requests.some((request) => request.length > 500))
      throw new Error('Request exceeded operation cap');
    const expectedRequests = Array.from(
      { length: Math.ceil(options.commits / 500) },
      (_, index) => Math.min(500, options.commits - index * 500),
    );
    if (
      JSON.stringify(requests.map((request) => request.length)) !==
      JSON.stringify(expectedRequests)
    ) {
      throw new Error('Replay encoded unexpected commit prefixes');
    }
    const expectedRows = [...expected.values()].sort((a, b) =>
      String(a.id).localeCompare(String(b.id)),
    );
    const expectedJson = JSON.stringify(expectedRows);
    for (const handle of handles) {
      if (
        JSON.stringify(
          handle.client.query(`SELECT ${columns} FROM tasks ORDER BY id`),
        ) !== expectedJson
      ) {
        throw new Error('Replay final rows differ from fixture');
      }
    }
    return {
      constructionMs,
      drainedMs,
      readerVisibleMs,
      requestBytes,
      responseBytes,
      transportMs,
      measurements: phaseMeasurements,
      sqlite,
      clientSqlite,
      serverMetrics,
      requests: requests.map((request) => request.length),
      validatedCommits: ids.length,
      validatedRows: expectedRows.length,
      digest: createHash('sha256').update(expectedJson).digest('hex'),
      cpuMs: (cpu.user + cpu.system) / 1000,
      rssBefore,
      rssAfter,
      boundaries: `${options.lane} lane: TS full clients, ${options.backend} server. Inclusive method timings overlap; resources cover replay through reader acknowledgement, excluding fixture, queue construction, and validation. Engine server CPU overlaps client-process CPU. Socket server metrics use its own process clock.`,
    };
  } finally {
    unsubscribe?.();
    try {
      await withinDeadline(catchup ?? Promise.resolve(), 'replay cleanup');
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
