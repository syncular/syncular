import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { profile } from 'bun:jsc';
import {
  httpBlobTransport,
  httpSyncTransport,
  type MutationInput,
} from '@syncular/client';
import { BunClientDatabase } from '@syncular/client/bun';
import { decodeMessage, type PushResultFrame } from '@syncular/core';
import { createBenchClient, type BenchClient } from './loopback';
import { processObject, processSampling } from './process-driver';
import { BLOB_SCHEMA, PROJECT_ID } from './fixture';
import {
  measureMethods,
  withinDeadline,
  type MethodMeasurement,
} from './instrumentation';

// Private benchmark protocol shared with the Rust driver. No shipping API changes.
if (import.meta.main) {
  let handle: BenchClient | undefined;
  let unsubscribe: (() => void) | undefined;
  let catchup: Promise<void> | undefined;
  let catchupError: unknown;
  let explicitSync = false;
  let blobFixture = false;
  let sampling:
    | { stop: () => void; result: Promise<unknown>; started: number }
    | undefined;
  const measurements: Record<string, MethodMeasurement> = {};
  let pushes: Array<Array<[string, number]>> = [];
  let pushResults: PushResultFrame[] = [];
  let requestBytes = 0;
  let responseBytes = 0;
  let transportMs = 0;
  let cpuStart = process.cpuUsage();
  const stats = () => {
    const cpu = process.cpuUsage(cpuStart);
    return {
      pushes,
      requestBytes,
      responseBytes,
      transportMs,
      measurements: structuredClone(measurements),
      cpuMs: (cpu.user + cpu.system) / 1000,
      rssBytes: process.memoryUsage().rss,
    };
  };
  const dispatch = async (
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> => {
    if (method === 'create') {
      if (handle) throw new Error('Client already created');
      if (typeof params.clientId !== 'string')
        throw new Error('Missing client identity');
      if (params.dbPath !== undefined && typeof params.dbPath !== 'string')
        throw new Error('Invalid database path');
      const transport = processObject(params.transport);
      if (
        typeof transport.baseUrl !== 'string' ||
        typeof transport.wsUrl !== 'string'
      )
        throw new Error('Missing transport endpoints');
      const syncUrl = new URL('/sync', transport.baseUrl).href;
      const schema = processObject(params.schema);
      if (!Array.isArray(schema.tables))
        throw new Error('Missing benchmark schema');
      blobFixture = schema.tables.some(
        (table: unknown) => processObject(table).name === 'attachments',
      );
      const clientBlobSchema = {
        ...BLOB_SCHEMA,
        tables: BLOB_SCHEMA.tables.map((table) => ({
          ...table,
          scopes: table.scopes.map((scope) =>
            typeof scope === 'string' ? { pattern: scope } : scope,
          ),
        })),
      };
      if (
        blobFixture &&
        JSON.stringify(schema) !== JSON.stringify(clientBlobSchema)
      )
        throw new Error('Unsupported blob benchmark schema');
      const http = httpSyncTransport(syncUrl);
      const database = new BunClientDatabase(params.dbPath);
      // The adapter runs transaction control through this owned SQLite method.
      // Prepared data statements use query().run(), a separate surface.
      database.db.run = measureMethods(
        { run: database.db.run.bind(database.db) },
        measurements,
        'clientSqlite',
        true,
      ).run;
      handle = await createBenchClient(
        {
          syncUrl,
          segmentsUrl: new URL('/segments', transport.baseUrl).href,
          realtimeUrl: transport.wsUrl.split('?')[0]!,
        },
        {
          clientId: params.clientId,
          realtime: true,
          database: measureMethods(database, measurements, 'database', true),
          ...(blobFixture
            ? {
                schema: {
                  version: BLOB_SCHEMA.version,
                  tables: BLOB_SCHEMA.tables.map((table) => ({
                    name: table.name,
                    columns: table.columns,
                    primaryKey: table.primaryKey,
                    scopes: table.scopes,
                  })),
                },
                blobs: measureMethods(
                  httpBlobTransport(new URL('/blobs', transport.baseUrl).href, {
                    headers: { 'x-bench-client-id': params.clientId },
                  }),
                  measurements,
                  'blobTransport',
                ),
              }
            : {}),
          transport: async (bytes) => {
            const message = decodeMessage(bytes);
            if (message.msgKind !== 'request')
              throw new Error('Expected sync request');
            const commits = message.frames.filter(
              (frame) => frame.type === 'PUSH_COMMIT',
            );
            if (commits.length)
              pushes.push(
                commits.map((commit) => [
                  commit.clientCommitId,
                  commit.operations.length,
                ]),
              );
            requestBytes += bytes.byteLength;
            const started = performance.now();
            const response = await http(bytes);
            transportMs += performance.now() - started;
            responseBytes += response.byteLength;
            const decoded = decodeMessage(response);
            if (decoded.msgKind !== 'response')
              throw new Error('Expected sync response');
            pushResults.push(
              ...decoded.frames.filter((frame) => frame.type === 'PUSH_RESULT'),
            );
            return response;
          },
        },
      );
      return { created: true };
    }
    if (!handle) throw new Error('Client not created');
    const client = handle.client;
    if (method === 'subscribe') {
      const scopes = processObject(params.scopes);
      const projects = scopes.project_id;
      if (
        typeof params.id !== 'string' ||
        params.id.length === 0 ||
        (params.table !== 'tasks' &&
          !(blobFixture && params.table === 'attachments')) ||
        Object.keys(scopes).length !== 1 ||
        !Array.isArray(projects) ||
        projects.length === 0 ||
        !projects.every((project) => typeof project === 'string')
      )
        throw new Error('Invalid benchmark subscription');
      if (
        params.id === 'bench' &&
        (projects.length !== 1 || projects[0] !== PROJECT_ID)
      )
        throw new Error('Default fixture subscription cannot change scopes');
      // createBenchClient has already installed the default fixture subscription.
      if (params.id !== 'bench')
        client.subscribe({
          id: params.id,
          table: params.table,
          scopes: { project_id: projects },
        });
      return { subscribed: true };
    }
    if (method === 'subscriptionState') {
      if (typeof params.id !== 'string')
        throw new Error('Missing subscription identity');
      return { state: client.subscription(params.id) ?? null };
    }
    if (method === 'query') {
      if (typeof params.sql !== 'string') throw new Error('Missing SQL');
      const bindings = params.params ?? [];
      if (
        !Array.isArray(bindings) ||
        !bindings.every(
          (value: unknown) =>
            value === null ||
            typeof value === 'string' ||
            (typeof value === 'number' && Number.isFinite(value)),
        )
      )
        throw new Error('Invalid benchmark query bindings');
      return { rows: client.query(params.sql, bindings) };
    }
    if (method === 'benchBlobFile') {
      if (
        !blobFixture ||
        params.mode !== 'direct' ||
        !['uploadBlob', 'fetchBlob'].includes(String(params.operation))
      )
        throw new Error(
          'Blob file measurement requires the blob fixture and direct boundary',
        );
      let bytes: Uint8Array;
      let sourceReadNs: number | undefined;
      let elapsedNs: number;
      let ref;
      if (params.operation === 'uploadBlob') {
        if (typeof params.path !== 'string' || params.path.length === 0)
          throw new Error('Missing blob fixture path');
        const sourceStarted = performance.now();
        bytes = await readFile(params.path);
        sourceReadNs = (performance.now() - sourceStarted) * 1_000_000;
        const started = performance.now();
        ref = await client.uploadBlob(bytes, {
          mediaType: 'application/octet-stream',
        });
        elapsedNs = (performance.now() - started) * 1_000_000;
      } else {
        if (typeof params.blob !== 'string')
          throw new Error('Missing blob reference');
        const started = performance.now();
        const cached = await client.fetchBlob(params.blob);
        elapsedNs = (performance.now() - started) * 1_000_000;
        bytes = cached.bytes;
        ref = {
          blobId: cached.blobId,
          byteLength: cached.byteLength,
          ...(cached.mediaType ? { mediaType: cached.mediaType } : {}),
        };
      }
      const operationStats = stats();
      const validationStarted = performance.now();
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      if (ref.blobId !== `sha256:${sha256}` || ref.byteLength !== bytes.length)
        throw new Error('Blob result differs from complete bytes');
      return {
        ref,
        elapsedNs,
        ...(sourceReadNs !== undefined ? { sourceReadNs } : {}),
        validation: { byteLength: bytes.length, sha256 },
        validationNs: (performance.now() - validationStarted) * 1_000_000,
        stats: operationStats,
      };
    }
    if (method === 'statusSnapshot') return client.statusSnapshot();
    if (method === 'commitOutcome') {
      if (typeof params.clientCommitId !== 'string')
        throw new Error('Missing commit identity');
      return { outcome: client.commitOutcome(params.clientCommitId) ?? null };
    }
    if (method === 'commitOutcomes')
      return { outcomes: client.commitOutcomes() };
    if (method === 'benchMutate') {
      if (
        params.mode !== 'direct' ||
        !Array.isArray(params.commits) ||
        params.commits.length < 1 ||
        params.commits.length > 10_000
      )
        throw new Error('Expected direct mutation loop with 1..10000 commits');
      const commits = params.commits.map((commit: unknown) => {
        const input = processObject(commit);
        if (!Array.isArray(input.mutations) || input.mutations.length === 0)
          throw new Error('Missing mutations');
        return input.mutations.map((value: unknown): MutationInput => {
          const mutation = processObject(value);
          if (
            mutation.op !== 'upsert' ||
            (mutation.table !== 'tasks' &&
              !(blobFixture && mutation.table === 'attachments'))
          )
            throw new Error('Expected fixture upsert');
          return {
            op: 'upsert',
            table: mutation.table,
            values: processObject(mutation.values),
          };
        });
      });
      const ids: string[] = [];
      const nsPerCommit: number[] = [];
      for (const mutations of commits) {
        const started = performance.now();
        ids.push(client.mutate(mutations));
        nsPerCommit.push((performance.now() - started) * 1_000_000);
      }
      return { ids, nsPerCommit };
    }
    if (method === 'syncUntilIdle' || method === 'benchSync') {
      if (method === 'benchSync' && params.mode !== 'direct')
        throw new Error('TS process requires direct boundary');
      const started = performance.now();
      const resultStart = pushResults.length;
      explicitSync = true;
      let summary;
      try {
        await catchup;
        if (catchupError !== undefined) throw catchupError;
        summary = await client.syncUntilIdle(10_100);
      } finally {
        explicitSync = false;
      }
      const elapsedNs = (performance.now() - started) * 1_000_000;
      // TS syncUntilIdle returns its last round. Preserve every HTTP push result
      // when adapting it to the benchmark's aggregate outcome contract.
      const delivered = pushResults.slice(resultStart);
      const outcome = {
        ok: true,
        report: {
          ...summary,
          applied: delivered
            .filter((frame) => frame.status !== 'rejected')
            .map((frame) => frame.clientCommitId),
          rejected: delivered
            .filter((frame) => frame.status === 'rejected')
            .map((frame) => frame.clientCommitId),
          retryable: delivered
            .filter((frame) =>
              frame.results.some(
                (result) => result.status === 'error' && result.retryable,
              ),
            )
            .map((frame) => frame.clientCommitId),
          conflicts: delivered.length
            ? delivered.reduce(
                (count, frame) =>
                  count +
                  frame.results.filter((result) => result.status === 'conflict')
                    .length,
                0,
              )
            : summary.conflicts.length,
          deferredCommits: summary.deferredCommits ?? 0,
        },
      };
      return method === 'benchSync'
        ? { outcome, elapsedNs, stats: stats() }
        : outcome;
    }
    if (method === 'connectRealtime') {
      if (!unsubscribe)
        unsubscribe = client.onSyncNeeded(() => {
          if (catchup || explicitSync || catchupError !== undefined) return;
          catchup = (async () => {
            do {
              await client.syncUntilIdle(10_100);
            } while (client.statusSnapshot().syncNeeded);
          })()
            .catch((error: unknown) => {
              catchupError = error;
            })
            .finally(() => {
              catchup = undefined;
            });
        });
      await client.connectRealtime();
      return { connected: true };
    }
    if (method === 'disconnectRealtime') {
      unsubscribe?.();
      unsubscribe = undefined;
      await withinDeadline(
        catchup ?? Promise.resolve(),
        'TS reader disconnect',
      );
      if (catchupError !== undefined) throw catchupError;
      client.disconnectRealtime();
      return { disconnected: true };
    }
    if (method === 'waitForAck') {
      if (
        typeof params.cursor !== 'number' ||
        !Number.isSafeInteger(params.cursor) ||
        params.cursor < 0
      )
        throw new Error('Expected nonnegative cursor');
      const started = performance.now();
      await withinDeadline(
        handle.waitForAck(params.cursor),
        'TS reader acknowledgement',
      );
      await catchup;
      if (catchupError !== undefined) throw catchupError;
      return {
        cursor: params.cursor,
        elapsedNs: (performance.now() - started) * 1_000_000,
        stats: stats(),
      };
    }
    if (method === 'stats') {
      if (params.sampling !== undefined && typeof params.sampling !== 'boolean')
        throw new Error('TS sampling requires a boolean');
      if (sampling && (params.reset === true || params.sampling === true))
        throw new Error('TS sampling interval is already active');
      if (params.sampling === false) {
        if (!sampling || params.reset === true)
          throw new Error(
            'TS sampling interval is not active or cannot reset while stopping',
          );
        const current = sampling;
        const snapshot = stats();
        const elapsedMs = performance.now() - current.started;
        current.stop();
        try {
          const raw = processObject(await current.result);
          const stacks = processObject(raw.stackTraces);
          if (!Array.isArray(stacks.traces))
            throw new Error('TS sampling traces are missing');
          return {
            ...snapshot,
            sampling: processSampling({
              version: 1,
              format: 'bun-jsc-sampling',
              encoding: 'gzip-base64',
              bunVersion: Bun.version,
              intervalUs: 1000,
              elapsedMs,
              samples: stacks.traces.length,
              data: Buffer.from(Bun.gzipSync(JSON.stringify(raw))).toString(
                'base64',
              ),
            }),
          };
        } finally {
          sampling = undefined;
        }
      }

      if (params.reset === true) {
        pushes = [];
        pushResults = [];
        requestBytes = 0;
        responseBytes = 0;
        transportMs = 0;
        for (const key of Object.keys(measurements)) delete measurements[key];
        cpuStart = process.cpuUsage();
      }
      if (params.sampling === true) {
        const gate = Promise.withResolvers<void>();
        const started = performance.now();
        const result: Promise<unknown> = profile(async () => {
          await gate.promise;
        }, 1000);
        void result.catch(() => undefined); // A failed profiler is reported by the stop command.
        sampling = { stop: gate.resolve, result, started };
      }
      return stats();
    }
    throw new Error('Unknown TS benchmark command');
  };
  try {
    for await (const line of createInterface({
      input: process.stdin,
      crlfDelay: Infinity,
    })) {
      const request = processObject(JSON.parse(line));
      if (typeof request.id !== 'number' || typeof request.method !== 'string')
        throw new Error('Malformed TS benchmark request');
      try {
        const result = await dispatch(
          request.method,
          processObject(request.params),
        );
        process.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
      } catch (error) {
        process.stdout.write(
          `${JSON.stringify({ id: request.id, error: String(error) })}\n`,
        );
      }
    }
  } finally {
    unsubscribe?.();
    try {
      await withinDeadline(catchup ?? Promise.resolve(), 'TS process shutdown');
    } finally {
      try {
        if (sampling) {
          sampling.stop();
          await sampling.result;
        }
      } finally {
        await handle?.close();
      }
    }
  }
}
