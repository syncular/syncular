import { createHash } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { httpBlobTransport } from '@syncular/client';
import { openBunDatabase } from '@syncular/client/bun';
import { createSyncularHono } from '@syncular/server-hono';
import {
  ACTOR_ID,
  BLOB_SCHEMA,
  PROJECT_ID,
  rowId,
  writeBlobFixture,
  sqliteConfiguration,
  SQLITE_CONFIGURATION_SQL,
} from './fixture';
import { createBenchClient, closeBenchClients } from './loopback';
import {
  createPerformanceServer,
  startSocketServer,
  startBlobObjectStore,
} from './socket-server';
import {
  assertProcessSync,
  createProcessDriver,
  processObject,
  processPhases,
} from './process-driver';
import {
  measureMethods,
  withinDeadline,
  type MethodMeasurement,
} from './instrumentation';

/** File input and digest-only IPC, with the shipping byte-array API timed. */
export async function runBlobFile(options: {
  binary: string | readonly string[];
  byteLength: number;
  rows: number;
  backend: 'sqlite' | 'postgres';
  blobStore: 'memory' | 'minio';
  blobDiagnostics?: boolean;
  localReferenceRows?: number;
  rustResultSurface?: 'typed' | 'legacy';
}) {
  if (options.byteLength > 16 * 1024 * 1024 && options.blobStore !== 'minio')
    throw new Error('Large blob files require the MinIO profile');
  const directory = await mkdtemp(join(tmpdir(), 'syncular-blob-file-'));
  let objectStore: Awaited<ReturnType<typeof startBlobObjectStore>> | undefined;
  let server: Awaited<ReturnType<typeof startSocketServer>> | undefined;
  const clients: Array<Awaited<ReturnType<typeof createProcessDriver>>> = [];
  const clientSqlite: Array<
    { role: string; pid: number; clientId: string } & ReturnType<
      typeof sqliteConfiguration
    >
  > = [];
  const disk: Array<{
    phase: string;
    files: Array<{ suffix: string; bytes: number; allocatedBytes: number }>;
  }> = [];
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      const cleanup = await Promise.allSettled(
        clients.map((client) => client.close()),
      );
      for (const action of [
        () => server?.close(),
        () => objectStore?.close(),
        () => rm(directory, { recursive: true, force: true }),
      ]) {
        try {
          await action();
        } catch (reason) {
          cleanup.push({ status: 'rejected', reason });
        }
      }
      const failures = cleanup.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      );
      if (failures.length)
        throw new AggregateError(
          failures,
          'Blob file benchmark cleanup failed',
        );
    })());
  try {
    const path = join(directory, 'fixture.bin');
    const fixture = await writeBlobFixture(path, options.byteLength);
    if (options.blobStore === 'minio')
      objectStore = await startBlobObjectStore();
    server = await startSocketServer(options.rows, options.backend, {
      blobs: true,
      ...(objectStore ? { s3: objectStore.config } : {}),
    });
    const endpoints = server.endpoints;
    const openClient = async (
      role: string,
      dbPath: string,
      clientId?: ReturnType<typeof crypto.randomUUID>,
    ) => {
      const client = await createProcessDriver(
        options.binary,
        endpoints,
        dbPath,
        clientId,
        BLOB_SCHEMA,
        false,
        undefined,
        options.blobDiagnostics,
      );
      clients.push(client);
      clientSqlite.push({
        role,
        pid: client.pid,
        clientId: client.clientId,
        ...sqliteConfiguration(
          processObject(
            await client.invoke('query', { sql: SQLITE_CONFIGURATION_SQL }),
          ).rows,
          true,
        ),
      });
      return client;
    };
    const query = async (
      client: (typeof clients)[number],
      sql: string,
      params: unknown[] = [],
    ) => {
      const rows = processObject(
        await client.invoke('query', { sql, params }),
      ).rows;
      if (!Array.isArray(rows))
        throw new Error('Blob file query returned no rows');
      return rows.map(processObject);
    };
    const measure = async (
      client: (typeof clients)[number],
      operation: 'uploadBlob' | 'fetchBlob',
      params: Record<string, unknown>,
    ) => {
      const beforeStats = await client.invoke('stats', { reset: true });
      const before = client.deliveryStats();
      const started = performance.now();
      const result = processObject(
        await client.invoke('benchBlobFile', {
          mode: 'direct',
          operation,
          ...(options.rustResultSurface
            ? { resultSurface: options.rustResultSurface }
            : {}),
          ...params,
        }),
      );
      const deliveryMs = performance.now() - started;
      const validation = processObject(result.validation);
      const ref = processObject(result.ref);
      if (
        validation.sha256 !== fixture.sha256 ||
        validation.byteLength !== fixture.byteLength ||
        ref.blobId !== `sha256:${fixture.sha256}` ||
        ref.byteLength !== fixture.byteLength
      )
        throw new Error('Blob file receipt differs from independent fixture');
      for (const key of [
        'elapsedNs',
        'validationNs',
        ...(operation === 'uploadBlob' ? ['sourceReadNs'] : []),
      ]) {
        if (
          typeof result[key] !== 'number' ||
          !Number.isFinite(result[key]) ||
          result[key] < 0
        )
          throw new Error('Blob file operation timer is invalid');
      }
      const responseBytes =
        client.deliveryStats().responseBytes - before.responseBytes;
      const requestBytes =
        client.deliveryStats().requestBytes - before.requestBytes;
      if (responseBytes > 65_536 || requestBytes > 4096)
        throw new Error('Blob file receipt exceeds bounded IPC budget');
      return {
        ...result,
        ref,
        validation,
        operationMs: Number(result.elapsedNs) / 1_000_000,
        beforeStats,
        deliveryMs,
        delivery: { requestBytes, responseBytes },
      };
    };
    const snapshotDisk = async (phase: string, dbPath: string) => {
      const files = [];
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          const file = await stat(`${dbPath}${suffix}`);
          files.push({
            suffix,
            bytes: file.size,
            allocatedBytes: file.blocks * 512,
          });
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !('code' in error) ||
            error.code !== 'ENOENT'
          )
            throw error;
          files.push({ suffix, bytes: 0, allocatedBytes: 0 });
        }
      }
      disk.push({ phase, files });
    };
    const writerPath = join(directory, 'writer.sqlite');
    const writer = await openClient('writer', writerPath);
    assertProcessSync(await writer.invoke('syncUntilIdle'));
    const staged = await measure(writer, 'uploadBlob', { path });
    await snapshotDisk('staged', writerPath);
    // The attachment row shares the seeded task's primary key and project.
    const row = {
      id: rowId(0),
      project_id: PROJECT_ID,
      body: JSON.stringify(staged.ref),
    };
    const mutation = processObject(
      await writer.invoke('benchMutate', {
        mode: 'direct',
        commits: [
          { mutations: [{ table: 'attachments', op: 'upsert', values: row }] },
        ],
      }),
    );
    if (
      !Array.isArray(mutation.ids) ||
      mutation.ids.length !== 1 ||
      typeof mutation.ids[0] !== 'string'
    )
      throw new Error('Blob file commit identity missing');
    if (
      (await query(writer, 'SELECT blob_id FROM _syncular_blob_uploads'))[0]
        ?.blob_id !== staged.ref.blobId
    )
      throw new Error('Blob file upload pin missing');
    await rm(path);
    await writer.invoke('stats', { reset: true });
    const uploadStarted = performance.now();
    const uploadAndCommit = processObject(
      await writer.invoke('benchSync', { mode: 'direct' }),
    );
    const uploadAndCommitDeliveryMs = performance.now() - uploadStarted;
    const report = assertProcessSync(uploadAndCommit.outcome, 1);
    if (JSON.stringify(report.applied) !== JSON.stringify(mutation.ids))
      throw new Error('Original blob commit was not applied');
    if (
      (await query(writer, 'SELECT blob_id FROM _syncular_blob_uploads'))
        .length !== 0
    )
      throw new Error('Blob upload pin did not drain');
    const outcome = processObject(
      processObject(
        await writer.invoke('commitOutcome', {
          clientCommitId: mutation.ids[0],
        }),
      ).outcome,
    );
    if (outcome.status !== 'applied')
      throw new Error('Blob file outcome was not durably applied');
    await snapshotDisk('uploaded', writerPath);
    const storageReceipt = objectStore
      ? await objectStore.head(String(staged.ref.blobId))
      : undefined;
    if (storageReceipt && storageReceipt.byteLength !== fixture.byteLength)
      throw new Error('Object store length differs from fixture');
    const writerRequests = await server.requests(writer.clientId);
    if (!Array.isArray(writerRequests))
      throw new Error('Blob writer trace missing');
    const requests = writerRequests.map(processObject);
    if (
      objectStore &&
      (!requests.some(
        (r) =>
          r.method === 'POST' &&
          String(r.path).endsWith('/upload-grant') &&
          r.status === 200,
      ) ||
        requests.some(
          (r) => r.method === 'PUT' && String(r.path).startsWith('/blobs/'),
        ))
    )
      throw new Error('Blob file upload did not use the presigned route');
    await writer.close();

    const readerPath = join(directory, 'reader.sqlite');
    const reader = await openClient('reader', readerPath);
    const visibilityStarted = performance.now();
    await reader.invoke('subscribe', {
      id: 'attachments',
      table: 'attachments',
      scopes: { project_id: [PROJECT_ID] },
    });
    assertProcessSync(await reader.invoke('syncUntilIdle'));
    const readerVisibilityMs = performance.now() - visibilityStarted;
    const visible = await query(
      reader,
      'SELECT id, project_id, body FROM attachments WHERE id = ?',
      [row.id],
    );
    if (
      visible.length !== 1 ||
      visible[0]?.id !== row.id ||
      visible[0]?.project_id !== row.project_id ||
      visible[0]?.body !== row.body
    )
      throw new Error('Independent reader attachment differs from fixture');
    const localReferenceRows = options.localReferenceRows ?? 1;
    if (
      !Number.isInteger(localReferenceRows) ||
      localReferenceRows < 1 ||
      localReferenceRows > 100_000
    )
      throw new Error('Blob local reference rows must be in 1..100000');
    if (localReferenceRows > 1) {
      const seeded = processObject(
        await reader.invoke('benchSeedBlobRefs', {
          blob: row.body,
          count: localReferenceRows - 1,
        }),
      );
      if (seeded.inserted !== localReferenceRows - 1)
        throw new Error('Blob reference fixture insert count differs');
    }
    if (
      (
        await query(
          reader,
          'SELECT count(*) AS n FROM attachments WHERE body = ?',
          [row.body],
        )
      )[0]?.n !== localReferenceRows
    )
      throw new Error('Blob reference fixture row count differs');
    if (
      (await query(reader, 'SELECT count(*) AS n FROM _syncular_blobs'))[0]
        ?.n !== 0
    )
      throw new Error('Fresh blob reader has a nonempty body cache');
    const downloaded = await measure(reader, 'fetchBlob', { blob: row.body });
    const cached = await query(
      reader,
      'SELECT refcount FROM _syncular_blobs WHERE blob_id = ?',
      [staged.ref.blobId],
    );
    if (cached.length !== 1 || cached[0]?.refcount !== localReferenceRows)
      throw new Error(
        'Downloaded blob refcount differs from visible references',
      );
    await snapshotDisk('downloaded', readerPath);
    const beforeHitRequests = await server.requests(reader.clientId);
    const cacheHit = await measure(reader, 'fetchBlob', { blob: row.body });
    if (
      JSON.stringify(await server.requests(reader.clientId)) !==
      JSON.stringify(beforeHitRequests)
    )
      throw new Error('Blob cache hit unexpectedly used the network');
    await reader.close();
    const reopenStarted = performance.now();
    const reopened = await openClient(
      'reopened-reader',
      readerPath,
      reader.clientId,
    );
    const reopenMs = performance.now() - reopenStarted;
    // Stop the sync server before reading to establish an offline cache hit.
    const serverMetrics = await server.metrics();
    await server.close();
    server = undefined;
    const reopenedHit = await measure(reopened, 'fetchBlob', {
      blob: row.body,
    });
    await reopened.close();
    const clientResources = clients.map((client) => client.resourceUsage());
    const result = {
      executionModel: 'isolated-client-processes',
      blobProfile: 'file',
      blobDiagnostics: options.blobDiagnostics !== false,
      localReferenceRows,
      ...(options.rustResultSurface
        ? { rustResultSurface: options.rustResultSurface }
        : {}),
      blobStore: options.blobStore,
      validatedObjects: 1,
      validation: 'independent-file-sha256-and-original-outcome',
      fixture,
      source: 'file-read-before-array-api',
      consumer: 'complete-public-result-before-digest',
      productCache: 'empty-reader-database',
      osCache: 'uncontrolled-warm',
      stages: {
        staged,
        uploadAndCommit,
        uploadAndCommitDeliveryMs,
        readerVisibilityMs,
        downloaded,
        cacheHit,
        reopenMs,
        reopenedHit,
      },
      boundaries:
        'Operation timers exclude fixture preparation and final digest validation. Delivery includes validation and IPC. Process resources include setup, all phases, and validation. Reopen includes launch, client setup, and configuration queries. UploadAndCommit includes upload plus metadata acceptance.',
      clientSqlite,
      clientResources,
      disk,
      serverMetrics,
      writerRequests,
      readerRequests: beforeHitRequests,
      objectStore: objectStore
        ? {
            ...objectStore.metadata,
            storageReceipt,
            finalMetrics: await objectStore.metrics(),
          }
        : null,
    };
    await close();
    return result;
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      if (cleanupError !== error)
        throw new AggregateError(
          [error, cleanupError],
          `Blob file benchmark and cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
    throw error;
  }
}

/** Full TS blob lifecycle. Fault injection cancels an actual response body. */
export async function runBlobLane(options: {
  rows?: number;
  byteLength: number;
  objects: number;
  persistent: boolean;
  lane: 'engine' | 'socket';
  backend: 'sqlite' | 'postgres';
}) {
  const directory = await mkdtemp(join(tmpdir(), 'syncular-blobs-'));
  const server = await createPerformanceServer(
    options.rows ?? 2000,
    options.lane,
    options.backend,
    { blobs: true },
  ).catch(async (error: unknown) => {
    await rm(directory, { recursive: true, force: true });
    throw error;
  });
  const endpoints = server.endpoints;
  const app =
    'ctx' in endpoints
      ? createSyncularHono({
          config: endpoints.ctx,
          authenticate: async () => ({
            actorId: ACTOR_ID,
            partition: endpoints.ctx.partition,
          }),
        })
      : undefined;
  const base =
    'syncUrl' in endpoints
      ? new URL(endpoints.syncUrl).origin
      : 'http://syncular-bench';
  const clients = [];
  const clientSqlite = [];
  let interruptedId: string | undefined;
  let interruptedBytes = 0;
  const interruption = new Error('bench.interrupted_download');
  try {
    for (const name of ['writer', 'reader', 'recovery']) {
      const measurements: Record<string, MethodMeasurement> = {};
      const requests: Array<{ method: string; path: string }> = [];
      const database = openBunDatabase(
        options.persistent ? join(directory, `${name}.sqlite`) : ':memory:',
      );
      const doFetch = Object.assign(
        async (...args: Parameters<typeof fetch>) => {
          const request = new Request(args[0], args[1]);
          const path = new URL(request.url).pathname;
          requests.push({ method: request.method, path });
          const response = app
            ? await app.fetch(request)
            : await fetch(request);
          if (
            name !== 'recovery' ||
            !interruptedId ||
            request.method !== 'GET' ||
            decodeURIComponent(path.split('/').at(-1) ?? '') !== interruptedId
          )
            return response;
          interruptedId = undefined;
          if (!response.ok || !response.body)
            throw new Error('Recovery fixture did not produce a blob body');
          const body = response.body.getReader();
          let sent = false;
          return new Response(
            new ReadableStream<Uint8Array>({
              async pull(controller) {
                if (sent) {
                  controller.error(interruption);
                  return;
                }
                sent = true;
                const chunk = await body.read();
                if (chunk.done || !chunk.value.length)
                  throw new Error('Recovery body ended before interruption');
                const prefix = chunk.value.subarray(
                  0,
                  Math.min(
                    chunk.value.length,
                    Math.floor(options.byteLength / 2),
                  ),
                );
                interruptedBytes += prefix.length;
                controller.enqueue(prefix);
                await body.cancel();
              },
              async cancel() {
                await body.cancel();
              },
            }),
            { status: response.status, headers: response.headers },
          );
        },
        { preconnect: fetch.preconnect },
      );
      const handle = await createBenchClient(endpoints, {
        schema: {
          version: BLOB_SCHEMA.version,
          tables: BLOB_SCHEMA.tables.map((table) => ({
            name: table.name,
            columns: table.columns,
            primaryKey: table.primaryKey,
            scopes: table.scopes,
          })),
        },
        database: measureMethods(database, measurements, 'database', true),
        blobs: measureMethods(
          httpBlobTransport(`${base}/blobs`, { fetch: doFetch }),
          measurements,
          'blobTransport',
        ),
      });
      clients.push({ name, handle, database, measurements, requests });
      clientSqlite.push({
        role: name,
        pid: process.pid,
        clientId: handle.client.clientId,
        ...sqliteConfiguration(
          handle.client.query(SQLITE_CONFIGURATION_SQL),
          options.persistent,
        ),
      });
      handle.client.subscribe({
        id: 'attachments',
        table: 'attachments',
        scopes: { project_id: [PROJECT_ID] },
      });
      await withinDeadline(handle.client.syncUntilIdle(), 'blob bootstrap');
    }
    const writer = clients[0]!,
      reader = clients[1]!,
      recovery = clients[2]!;
    const bytes = Array.from({ length: options.objects }, (_, object) =>
      Uint8Array.from(
        { length: options.byteLength },
        (_, index) =>
          (index * 131 + Math.floor(index / 251) + object * 17) % 256,
      ),
    );
    const ids = bytes.map(
      (body) => `sha256:${createHash('sha256').update(body).digest('hex')}`,
    );
    if (new Set(ids).size !== ids.length)
      throw new Error('Blob fixture bodies must be distinct');
    const samples = [];
    const expectedRows = [];
    await server.metrics(true);
    for (const entry of clients) {
      entry.requests.length = 0;
      for (const key of Object.keys(entry.measurements))
        delete entry.measurements[key];
    }
    async function measurePhase<T>(
      entry: typeof writer,
      operation: () => Promise<T>,
    ) {
      const before = structuredClone(entry.measurements);
      const started = performance.now();
      const value = await operation();
      const elapsedMs = performance.now() - started;
      const measurements: Record<string, MethodMeasurement> = {};
      for (const [name, current] of Object.entries(entry.measurements)) {
        const previous = before[name];
        const calls = current.calls - (previous?.calls ?? 0);
        if (calls > 0)
          measurements[name] = {
            calls,
            elapsedMs: current.elapsedMs - (previous?.elapsedMs ?? 0),
            failures: current.failures - (previous?.failures ?? 0),
          };
      }
      return { value, elapsedMs, measurements };
    }
    const cpuStart = process.cpuUsage();
    const rssBefore = process.memoryUsage().rss;
    for (let index = 0; index < bytes.length; index++) {
      const body = bytes[index]!,
        blobId = ids[index]!;
      const { value: ref, ...stage } = await measurePhase(writer, () =>
        writer.handle.client.uploadBlob(body, {
          mediaType: 'application/octet-stream',
        }),
      );
      if (ref.blobId !== blobId || ref.byteLength !== body.length)
        throw new Error('Staged blob differs from content address');
      if (
        writer.database.query(
          'SELECT blob_id FROM _syncular_blob_uploads WHERE blob_id = ?',
          [blobId],
        ).length !== 1
      )
        throw new Error('Staged blob lost its upload pin');
      const row = {
        id: `attachment-${index}`,
        project_id: PROJECT_ID,
        body: writer.handle.client.blobRefString(ref),
      };
      expectedRows.push(row);
      const commitId = writer.handle.client.mutate([
        { table: 'attachments', op: 'upsert', values: row },
      ]);
      const { value: _uploadResult, ...uploadAndCommit } = await measurePhase(
        writer,
        () =>
          withinDeadline(
            writer.handle.client.syncUntilIdle(),
            'blob upload and reference push',
          ),
      );
      if (
        writer.handle.client.commitOutcome(commitId)?.status !== 'applied' ||
        writer.database.query('SELECT blob_id FROM _syncular_blob_uploads')
          .length !== 0
      )
        throw new Error(
          'Blob reference did not apply or upload pin survived sync',
        );
      for (const entry of [reader, recovery])
        await withinDeadline(
          entry.handle.client.syncUntilIdle(),
          'blob reference convergence',
        );
      const beforeDownload = reader.requests.length;
      const { value: downloaded, ...download } = await measurePhase(
        reader,
        () => reader.handle.client.fetchBlob(blobId),
      );
      if (
        !Buffer.from(downloaded.bytes).equals(body) ||
        reader.requests.length !== beforeDownload + 1
      )
        throw new Error('Fresh blob download differs or did not fetch once');
      const beforeHit = reader.requests.length;
      const { value: cached, ...cacheHit } = await measurePhase(reader, () =>
        reader.handle.client.fetchBlob(blobId),
      );
      if (
        !Buffer.from(cached.bytes).equals(body) ||
        reader.requests.length !== beforeHit
      )
        throw new Error('Blob cache hit changed bytes or contacted the server');
      interruptedId = blobId;
      const { value: failure, ...interrupted } = await measurePhase(
        recovery,
        async () => {
          try {
            await recovery.handle.client.fetchBlob(blobId);
            return undefined;
          } catch (error) {
            return error;
          }
        },
      );
      if (
        failure !== interruption ||
        recovery.database.query(
          'SELECT blob_id FROM _syncular_blobs WHERE blob_id = ?',
          [blobId],
        ).length !== 0
      )
        throw new Error('Interrupted download succeeded or polluted the cache');
      const beforeRecovery = recovery.requests.length;
      const { value: recovered, ...recoveredPhase } = await measurePhase(
        recovery,
        () => recovery.handle.client.fetchBlob(blobId),
      );
      if (
        !Buffer.from(recovered.bytes).equals(body) ||
        recovery.requests.length !== beforeRecovery + 1
      )
        throw new Error('Blob recovery did not refetch the complete body');
      samples.push({
        blobId,
        byteLength: body.length,
        stageMs: stage.elapsedMs,
        uploadAndCommitMs: uploadAndCommit.elapsedMs,
        downloadMs: download.elapsedMs,
        cacheHitMs: cacheHit.elapsedMs,
        interruptedMs: interrupted.elapsedMs,
        recoveryMs: recoveredPhase.elapsedMs,
        phases: {
          stage,
          uploadAndCommit,
          download,
          cacheHit,
          interrupted,
          recovery: recoveredPhase,
        },
      });
    }
    const cacheState = [];
    for (const entry of clients) {
      if (
        entry.handle.client.statusSnapshot().outbox !== 0 ||
        JSON.stringify(
          entry.handle.client.query(
            'SELECT id, project_id, body FROM attachments ORDER BY id',
          ),
        ) !== JSON.stringify(expectedRows)
      )
        throw new Error('Blob references failed to converge');
      const entries = entry.database.query(
        'SELECT blob_id, byte_length, refcount FROM _syncular_blobs ORDER BY blob_id',
      );
      if (
        entries.length !== options.objects ||
        entries.some(
          (row) => row.byte_length !== options.byteLength || row.refcount !== 1,
        )
      )
        throw new Error(
          `Blob cache metadata differs from live references: ${entry.name} ${JSON.stringify(entries)}`,
        );
      cacheState.push({ client: entry.name, entries });
    }
    const cpu = process.cpuUsage(cpuStart);
    return {
      samples,
      clientSqlite,
      cacheState,
      interruptedBytes,
      validatedObjects: ids.length,
      validatedBytes: options.byteLength * ids.length,
      cpuMs: (cpu.user + cpu.system) / 1000,
      rssBefore,
      rssAfter: process.memoryUsage().rss,
      measurements: Object.fromEntries(
        clients.map((entry) => [entry.name, entry.measurements]),
      ),
      requests: Object.fromEntries(
        clients.map((entry) => [entry.name, entry.requests]),
      ),
      serverMetrics: await server.metrics(),
      boundaries: `${options.lane} TS lifecycle with inline HTTP blob bodies and a memory server blob store. Staging includes content addressing and local cache/pin writes. Upload-and-commit includes upload grant, body transfer, server verification/storage, and reference push. Downloads include hashing, cache insertion and materialization; cache hits include materialization. Recovery consumes a response prefix then cancels/errors the body, followed by a complete authorized retry. Validation is outside individual phase timers. CPU includes validation; RSS is process-wide. Each phase includes method counts and inclusive durations for its client, plus SQL shapes without bound values. SQL durations are subsets of method durations; transactions include nested SQL. Do not sum these durations. Snapshot/delta bookkeeping and validation are outside phase timers. Aggregate measurements also include reference convergence and mutation between phases.`,
    };
  } finally {
    try {
      await closeBenchClients(clients.map((entry) => entry.handle));
    } finally {
      try {
        await server.close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
}

/** Rust core and shared-command lifecycle over the shipping native HTTP transport. */
export async function runProcessBlobs(options: {
  binary: string;
  rows: number;
  byteLength: number;
  objects: number;
  persistent: boolean;
  backend: 'sqlite' | 'postgres';
  boundary: 'direct' | 'command' | 'ffi';
  nativePhases?: boolean;
}) {
  if (options.nativePhases && options.boundary === 'ffi')
    throw new Error('Native phases require the direct or command boundary');
  const directory = await mkdtemp(join(tmpdir(), 'syncular-native-blobs-'));
  const server = await startSocketServer(options.rows, options.backend, {
    blobs: true,
  }).catch(async (error: unknown) => {
    await rm(directory, { recursive: true, force: true });
    throw error;
  });
  const clients: Array<Awaited<ReturnType<typeof createProcessDriver>>> = [];
  const clientSqlite = [];
  try {
    for (const name of ['writer', 'reader', 'recovery']) {
      const client = await createProcessDriver(
        options.binary,
        server.endpoints,
        options.persistent ? join(directory, `${name}.sqlite`) : undefined,
        undefined,
        BLOB_SCHEMA,
        options.boundary === 'ffi',
      );
      clients.push(client);
      clientSqlite.push({
        role: name,
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
      await client.invoke('subscribe', {
        id: 'attachments',
        table: 'attachments',
        scopes: { project_id: [PROJECT_ID] },
      });
      assertProcessSync(await client.invoke('syncUntilIdle'));
    }
    const writer = clients[0]!,
      reader = clients[1]!,
      recovery = clients[2]!;
    const bytes = Array.from({ length: options.objects }, (_, object) =>
      Uint8Array.from(
        { length: options.byteLength },
        (_, index) =>
          (index * 131 + Math.floor(index / 251) + object * 17) % 256,
      ),
    );
    const ids = bytes.map(
      (body) => `sha256:${createHash('sha256').update(body).digest('hex')}`,
    );
    if (new Set(ids).size !== ids.length)
      throw new Error('Blob fixture bodies must be distinct');
    async function query(
      client: typeof writer,
      sql: string,
      params: unknown[] = [],
    ) {
      const rows = processObject(
        await client.invoke('query', { sql, params }),
      ).rows;
      if (!Array.isArray(rows))
        throw new Error('Native query returned no rows');
      return rows.map(processObject);
    }
    async function blobRequests(client: typeof writer) {
      if (options.boundary !== 'ffi') {
        const rows = processObject(await client.invoke('stats')).blobRequests;
        if (!Array.isArray(rows))
          throw new Error('Native transport statistics missing');
        return rows.map(processObject);
      }
      const rows = await server.requests(client.clientId);
      if (!Array.isArray(rows))
        throw new Error('FFI server request trace missing');
      return rows
        .map(processObject)
        .filter(
          (row) =>
            typeof row.path === 'string' &&
            (row.path.startsWith('/blobs/') ||
              row.path === '/__bench/signed-blob'),
        )
        .map((row) => {
          if (
            typeof row.path !== 'string' ||
            typeof row.status !== 'number' ||
            typeof row.method !== 'string'
          )
            throw new Error('FFI server request trace is malformed');
          return {
            method:
              row.path === '/__bench/signed-blob'
                ? 'fetchUrl'
                : row.method === 'GET'
                  ? 'download'
                  : row.method === 'POST'
                    ? 'uploadGrant'
                    : 'upload',
            path: row.path,
            status: row.status,
            failed: row.interrupted === true || row.status >= 400,
            observedAtServer: true,
          };
        });
    }
    async function measure(
      client: typeof writer,
      operation: 'uploadBlob' | 'fetchBlob',
      params: Record<string, unknown>,
    ) {
      if (options.nativePhases) await client.invoke('stats', { phases: true });
      const before = client.deliveryStats();
      const started = performance.now();
      const result = processObject(
        await client.invoke('benchBlob', {
          operation,
          mode: options.boundary,
          ...params,
        }),
      );
      const deliveryMs = performance.now() - started;
      if (
        typeof result.elapsedNs !== 'number' ||
        !Number.isFinite(result.elapsedNs) ||
        result.elapsedNs < 0
      )
        throw new Error('Native blob operation has invalid timing');
      const after = client.deliveryStats();
      const delivery = {
        requestBytes: after.requestBytes - before.requestBytes,
        responseBytes: after.responseBytes - before.responseBytes,
        requestSerializeMs:
          after.requestSerializeMs - before.requestSerializeMs,
        responseParseMs: after.responseParseMs - before.responseParseMs,
        responseFramingMs: after.responseFramingMs - before.responseFramingMs,
        responseChunks: after.responseChunks - before.responseChunks,
        responseScanChars: after.responseScanChars - before.responseScanChars,
      };
      const phases = options.nativePhases
        ? processPhases(processObject(await client.invoke('stats')).phases)
        : undefined;
      if (options.nativePhases) await client.invoke('stats', { phases: false });
      const requests =
        options.boundary === 'ffi'
          ? await blobRequests(client)
          : processObject(result.stats).blobRequests;
      if (!Array.isArray(requests))
        throw new Error('Native blob transport statistics missing');
      const ffi =
        options.boundary === 'ffi' ? processObject(result.ffi) : undefined;
      if (ffi)
        for (const key of [
          'requestSerializeNs',
          'callNs',
          'responseCopyNs',
          'responseFreeNs',
          'responseParseNs',
          'requestBytes',
          'responseBytes',
        ]) {
          if (
            typeof ffi[key] !== 'number' ||
            !Number.isFinite(ffi[key]) ||
            ffi[key] < 0
          )
            throw new Error('FFI timing or byte count missing');
        }
      return {
        result,
        phases,
        ffi,
        delivery,
        deliveryMs,
        operationMs: result.elapsedNs / 1e6,
        requests: requests.map(processObject),
      };
    }
    function validateBody(
      result: Record<string, unknown>,
      body: Uint8Array,
      blobId: string,
    ) {
      if ('error' in result)
        throw new Error(
          `Native blob operation failed: ${JSON.stringify(result.error)}`,
        );
      const blob = processObject(processObject(result.value).blob);
      const encoded = processObject(blob.bytes).$bytes;
      if (
        blob.blobId !== blobId ||
        blob.byteLength !== body.length ||
        typeof encoded !== 'string' ||
        encoded.length !== body.length * 2 ||
        !/^[a-f0-9]+$/.test(encoded)
      )
        throw new Error('Native blob delivery differs from expected bytes');
      const started = performance.now();
      const decoded = Buffer.from(encoded, 'hex');
      const decodeMs = performance.now() - started;
      if (!decoded.equals(body))
        throw new Error('Native decoded bytes differ from fixture');
      return decodeMs;
    }
    const samples = [];
    const expectedRows = [];
    const faultUrl = `${new URL(server.endpoints.syncUrl).origin}/__bench/interrupt-blob`;
    await server.metrics(true);
    const cpuStart = process.cpuUsage();
    const rssBefore = process.memoryUsage().rss;
    for (let index = 0; index < bytes.length; index++) {
      const body = bytes[index]!,
        blobId = ids[index]!;
      // Encoding the input envelope is outside the delivery timer, as in other process workloads.
      const encodeStarted = performance.now();
      const encoded = Buffer.from(body).toString('hex');
      const inputEncodeMs = performance.now() - encodeStarted;
      const stage = await measure(writer, 'uploadBlob', {
        bytes: { $bytes: encoded },
        mediaType: 'application/octet-stream',
      });
      if ('error' in stage.result)
        throw new Error(
          `Native blob staging failed: ${JSON.stringify(stage.result.error)}`,
        );
      const ref = processObject(processObject(stage.result.value).ref);
      if (
        ref.blobId !== blobId ||
        ref.byteLength !== body.length ||
        ref.mediaType !== 'application/octet-stream'
      )
        throw new Error('Native staged reference differs from content address');
      if (
        (
          await query(
            writer,
            'SELECT blob_id FROM _syncular_blob_uploads WHERE blob_id = ?',
            [blobId],
          )
        ).length !== 1
      )
        throw new Error('Native staging lost its upload pin');
      const row = {
        id: `attachment-${index}`,
        project_id: PROJECT_ID,
        body: JSON.stringify({
          blobId,
          byteLength: body.length,
          mediaType: 'application/octet-stream',
        }),
      };
      expectedRows.push(row);
      const mutation = processObject(
        await writer.invoke('mutate', {
          mutations: [{ table: 'attachments', op: 'upsert', values: row }],
        }),
      );
      const uploadStarted = performance.now();
      const upload = processObject(
        await writer.invoke('benchSync', { mode: options.boundary }),
      );
      const uploadAndCommitMs = performance.now() - uploadStarted;
      assertProcessSync(upload.outcome, 1);
      if (
        typeof upload.elapsedNs !== 'number' ||
        !Number.isFinite(upload.elapsedNs) ||
        upload.elapsedNs < 0
      )
        throw new Error('Native upload sync has invalid timing');
      const outcome = processObject(
        await writer.invoke('commitOutcome', {
          clientCommitId: mutation.clientCommitId,
        }),
      );
      if (
        processObject(outcome.outcome).status !== 'applied' ||
        (await query(writer, 'SELECT blob_id FROM _syncular_blob_uploads'))
          .length !== 0
      )
        throw new Error(
          'Native blob reference did not apply or upload pin survived',
        );
      for (const client of [reader, recovery])
        assertProcessSync(await client.invoke('syncUntilIdle'));
      const beforeDownload = await blobRequests(reader);
      if (!Array.isArray(beforeDownload))
        throw new Error('Native transport statistics missing');
      const download = await measure(reader, 'fetchBlob', { blob: blobId });
      const downloadDecodeMs = validateBody(download.result, body, blobId);
      if (
        download.requests.length !== beforeDownload.length + 1 ||
        download.requests.at(-1)?.method !== 'download' ||
        download.requests.at(-1)?.failed !== false
      )
        throw new Error('Native fresh download did not fetch once');
      const hit = await measure(reader, 'fetchBlob', { blob: blobId });
      const cacheHitDecodeMs = validateBody(hit.result, body, blobId);
      if (hit.requests.length !== download.requests.length)
        throw new Error('Native cache hit contacted the server');
      const armed = await fetch(faultUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blobId }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!armed.ok)
        throw new Error('Could not arm native download interruption');
      await armed.arrayBuffer();
      const interrupted = await measure(recovery, 'fetchBlob', {
        blob: blobId,
      });
      const error = processObject(interrupted.result.error);
      if (
        error.code !== 'transport.failed' ||
        interrupted.requests.at(-1)?.failed !== true ||
        (
          await query(
            recovery,
            'SELECT blob_id FROM _syncular_blobs WHERE blob_id = ?',
            [blobId],
          )
        ).length !== 0
      )
        throw new Error(
          `Native interrupted download did not fail cleanly: ${JSON.stringify(error)}`,
        );
      const recovered = await measure(recovery, 'fetchBlob', { blob: blobId });
      const recoveryDecodeMs = validateBody(recovered.result, body, blobId);
      if (
        recovered.requests.length !== interrupted.requests.length + 1 ||
        recovered.requests.at(-1)?.failed !== false
      )
        throw new Error(
          'Native recovery did not issue a successful fresh download',
        );
      samples.push({
        blobId,
        ...(options.nativePhases
          ? {
              nativePhases: {
                stage: stage.phases,
                download: download.phases,
                cacheHit: hit.phases,
                interrupted: interrupted.phases,
                recovery: recovered.phases,
              },
            }
          : {}),
        byteLength: body.length,
        inputEncodeMs,
        delivery: {
          stage: stage.delivery,
          download: download.delivery,
          cacheHit: hit.delivery,
          recovery: recovered.delivery,
          interrupted: interrupted.delivery,
        },
        decodeMs: {
          download: downloadDecodeMs,
          cacheHit: cacheHitDecodeMs,
          recovery: recoveryDecodeMs,
        },
        stageMs: stage.deliveryMs,
        uploadAndCommitMs,
        downloadMs: download.deliveryMs,
        cacheHitMs: hit.deliveryMs,
        interruptedMs: interrupted.deliveryMs,
        recoveryMs: recovered.deliveryMs,
        ...(options.boundary === 'ffi'
          ? {
              ffi: {
                stage: stage.ffi,
                uploadAndCommit: processObject(upload.ffi),
                download: download.ffi,
                cacheHit: hit.ffi,
                interrupted: interrupted.ffi,
                recovery: recovered.ffi,
              },
            }
          : {
              nativeOperationMs: {
                stage: stage.operationMs,
                uploadAndCommit: upload.elapsedNs / 1e6,
                download: download.operationMs,
                cacheHit: hit.operationMs,
                interrupted: interrupted.operationMs,
                recovery: recovered.operationMs,
              },
            }),
        transport: {
          writer:
            options.boundary === 'ffi'
              ? await blobRequests(writer)
              : processObject(upload.stats).blobRequests,
          reader: hit.requests,
          recovery: recovered.requests,
        },
        interruptionError: error,
      });
    }
    const cacheState = [];
    for (const [index, client] of clients.entries()) {
      if (
        processObject(await client.invoke('statusSnapshot')).outbox !== 0 ||
        JSON.stringify(
          (
            await query(
              client,
              'SELECT id, project_id, body FROM attachments ORDER BY id',
            )
          ).map((row) => ({
            id: row.id,
            project_id: row.project_id,
            body: row.body,
          })),
        ) !== JSON.stringify(expectedRows)
      )
        throw new Error('Native blob references did not converge');
      const entries = await query(
        client,
        'SELECT blob_id, byte_length, refcount FROM _syncular_blobs ORDER BY blob_id',
      );
      if (
        entries.length !== options.objects ||
        entries.some(
          (row) => row.byte_length !== options.byteLength || row.refcount !== 1,
        )
      )
        throw new Error(
          'Native blob cache metadata differs from live references',
        );
      cacheState.push({
        client: ['writer', 'reader', 'recovery'][index],
        entries,
      });
    }
    const faultResponse = await fetch(faultUrl, {
      signal: AbortSignal.timeout(120_000),
    });
    if (!faultResponse.ok) throw new Error('Native blob fault report failed');
    const faults = processObject(await faultResponse.json());
    if (
      faults.armed !== null ||
      faults.pendingUrls !== 0 ||
      !Array.isArray(faults.faults) ||
      faults.faults.length !== options.objects
    )
      throw new Error(
        'Native blob fault fixture did not consume every interruption',
      );
    let interruptedBytes = 0;
    for (const [index, raw] of faults.faults.entries()) {
      const fault = processObject(raw);
      if (
        fault.blobId !== ids[index] ||
        fault.declaredBytes !== options.byteLength ||
        typeof fault.sentBytes !== 'number' ||
        fault.sentBytes <= 0 ||
        fault.sentBytes >= options.byteLength
      )
        throw new Error(
          'Native download interruption did not send a body prefix',
        );
      interruptedBytes += fault.sentBytes;
    }
    const cpu = process.cpuUsage(cpuStart);
    const rssAfter = process.memoryUsage().rss;
    const serverMetrics = await server.metrics();
    await closeBenchClients(clients);
    return {
      samples,
      clientSqlite,
      cacheState,
      interruptedBytes,
      validatedObjects: ids.length,
      validatedBytes: options.byteLength * ids.length,
      serverMetrics,
      clientResources: clients.map((client, index) => ({
        role: ['writer', 'reader', 'recovery'][index],
        ...client.resourceUsage(),
      })),
      orchestratorCpuMs: (cpu.user + cpu.system) / 1000,
      rssBefore,
      rssAfter,
      boundaries:
        options.boundary === 'ffi'
          ? 'The release Rust benchmark executable calls the shipping exported C ABI. Each FFI command records request JSON/C-string construction, the complete C call (including input parse, core work, event collection and returned JSON allocation), copying the NUL-terminated result into host-owned bytes, freeing the library string exactly once, and host JSON parsing. Byte counts include the NUL terminator. Native core time is not isolated inside the C call. Parent stdio delivery and hex decoding remain separate. Server request traces, read outside delivery timers, verify cache hits and interrupted/retried downloads because the FFI owns its transport. The top-level CPU and RSS fields describe the orchestrator. clientResources records each native process from launch through shutdown, including setup, validation, stdio, and teardown. Peak RSS is a lifetime high-water mark; it is not an operation allocation or an additive simultaneous-memory total. This is a Rust C-ABI host, not a Swift/Kotlin/Flutter/React Native/Tauri runtime.'
          : `Rust ${options.boundary} operation timing excludes outer stdio JSON parsing/serialization and input envelope creation. Direct staging also excludes envelope decoding; command staging includes it. Fetch operation time includes the shipping core's hexadecimal result construction. Delivery time includes stdio serialization, transfer, and parent JSON parsing, but excludes byte-envelope decoding and exact-byte validation. The interrupted attempt receives a one-use signed URL after ordinary row authorization. Its HTTP endpoint sends a prefix with the original Content-Length then closes the connection; the native transport must report failure before caching. Transport durations are inclusive subsets of operation time and counters accumulate per client. The top-level CPU and RSS fields describe the orchestrator. clientResources records each native process from launch through shutdown, including setup, validation, stdio, and teardown. Peak RSS is a lifetime high-water mark; it is not an operation allocation or an additive simultaneous-memory total. FFI delivery is measured by the separate ffi boundary.`,
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
