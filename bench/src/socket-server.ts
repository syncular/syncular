import { createServer } from 'node:http';
import {
  BunSqliteDatabase,
  MemoryBlobStore,
  S3BlobStore,
  s3PresignedBlobUploads,
  s3PresignedBlobUrls,
  type S3BlobStoreConfig,
  SqliteServerStorage,
  type RealtimeSession,
} from '@syncular/server';
import { createSyncularHono } from '@syncular/server-hono';
import {
  ACTOR_ID,
  PARTITION,
  RETAINED_PROJECT_ID,
  sqliteConfiguration,
  SQLITE_CONFIGURATION_SQL,
} from './fixture';
import {
  createBenchServer,
  seedServerRows,
  type BenchEndpoints,
  type BenchServer,
} from './loopback';
import {
  measureMethods,
  withinDeadline,
  type MethodMeasurement,
} from './instrumentation';
import { createPgServer } from './pg-lane';
import {
  EMPTY_PAYLOAD_SHA256,
  signRequest,
} from '../../packages/server/src/sigv4';

/** Own one fresh local object store; never connect to an existing bucket. */
export async function startBlobObjectStore() {
  const image =
    'minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e';
  const name = `syncular-blob-bench-${crypto.randomUUID()}`;
  const accessKeyId = crypto.randomUUID();
  const secretAccessKey = crypto.randomUUID();
  const docker = async (args: string[]) => {
    const child = Bun.spawn(['docker', ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    try {
      const [code, out, err] = await withinDeadline(
        Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]),
        'local blob store Docker command',
        30_000,
      );
      if (code !== 0)
        throw new Error(
          `Local blob store Docker command failed: ${err.trim()}`,
        );
      return out.trim();
    } catch (error) {
      child.kill('SIGKILL');
      await child.exited;
      throw error;
    }
  };
  // Refuse an unavailable image rather than adding network setup to a trial.
  await docker(['image', 'inspect', image, '--format', '{{.Id}}']);
  let created = false;
  try {
    await docker([
      'create',
      '--name',
      name,
      '--publish',
      '127.0.0.1::9000',
      '--mount',
      'type=volume,destination=/data',
      '--env',
      `MINIO_ROOT_USER=${accessKeyId}`,
      '--env',
      `MINIO_ROOT_PASSWORD=${secretAccessKey}`,
      image,
      'server',
      '/data',
      '--console-address',
      ':9001',
    ]);
    created = true;
    await docker(['start', name]);
    const address = await docker(['port', name, '9000/tcp']);
    if (!/^127\.0\.0\.1:\d+$/.test(address))
      throw new Error('Local blob store has no loopback port');
    const config: S3BlobStoreConfig = {
      endpoint: `http://${address}`,
      region: 'us-east-1',
      bucket: 'syncular-bench',
      accessKeyId,
      secretAccessKey,
    };
    const deadline = performance.now() + 30_000;
    while (true) {
      const response = await fetch(`${config.endpoint}/minio/health/ready`, {
        signal: AbortSignal.timeout(1000),
      }).catch(() => undefined);
      await response?.body?.cancel();
      if (response?.ok) break;
      if (performance.now() >= deadline)
        throw new Error('Local blob store did not become ready');
    }
    const url = new URL(`${config.endpoint}/${config.bucket}`);
    while (true) {
      const response = await fetch(url, {
        method: 'PUT',
        headers: await signRequest({
          method: 'PUT',
          url,
          region: config.region,
          credentials: config,
          payloadHash: EMPTY_PAYLOAD_SHA256,
          nowMs: Date.now(),
        }),
        signal: AbortSignal.timeout(30_000),
      });
      const bucketResponse = await response.text();
      if (response.ok) break;
      // The health route can precede MinIO's writable object layer on startup.
      if (
        response.status === 503 &&
        bucketResponse.includes('<Code>XMinioServerNotInitialized</Code>') &&
        performance.now() < deadline
      )
        continue;
      throw new Error(
        `Local blob store bucket creation failed (${response.status}): ${bucketResponse}`,
      );
    }
    return {
      config,
      metadata: {
        provider: 'minio',
        image,
        endpoint: config.endpoint,
        bucket: config.bucket,
        region: config.region,
        isolation: 'fresh-container-and-anonymous-volume',
        container: name,
        dockerVersion: await docker([
          'version',
          '--format',
          '{{.Server.Version}}',
        ]),
      },
      async head(blobId: string) {
        const key = new S3BlobStore(config).objectKeyFor(PARTITION, blobId);
        const url = new URL(`${config.endpoint}/${config.bucket}/${key}`);
        const response = await fetch(url, {
          method: 'HEAD',
          headers: await signRequest({
            method: 'HEAD',
            url,
            region: config.region,
            credentials: config,
            payloadHash: EMPTY_PAYLOAD_SHA256,
            nowMs: Date.now(),
          }),
          signal: AbortSignal.timeout(30_000),
        });
        const length = response.headers.get('content-length');
        if (!response.ok || length === null || !/^\d+$/.test(length))
          throw new Error('Object store receipt is missing');
        return {
          byteLength: Number(length),
          etag: response.headers.get('etag'),
        };
      },
      async metrics() {
        return JSON.parse(
          await docker([
            'stats',
            '--no-stream',
            '--format',
            '{{json .}}',
            name,
          ]),
        ) as Record<string, unknown>;
      },
      async close() {
        await docker(['rm', '--force', '--volumes', name]);
      },
    };
  } catch (error) {
    if (created) await docker(['rm', '--force', '--volumes', name]);
    throw error;
  }
}

export interface ServerSnapshot {
  database:
    | ({ backend: 'sqlite' } & ReturnType<typeof sqliteConfiguration>)
    | Awaited<ReturnType<typeof createPgServer>>['database'];
  maxCommitSeq: number;
  measurements: Record<string, MethodMeasurement>;
  cpuMs: number;
  rssBytes: number;
}

/** Identical storage fixture for the in-process and process-isolated lanes. */
export async function createPerformanceServer(
  rows: number,
  lane: 'engine' | 'socket',
  backend: 'sqlite' | 'postgres',
  profile: { rejectMiddle?: boolean; blobs?: boolean } = {},
) {
  if (lane === 'socket') return startSocketServer(rows, backend, profile);
  const measurements: Record<string, MethodMeasurement> = {};
  const serverOptions = {
    measurements,
    ...(profile.rejectMiddle ? { rejectMiddle: true } : {}),
    ...(profile.blobs
      ? {
          blobs: measureMethods(
            new MemoryBlobStore(),
            measurements,
            'blobStore',
          ),
        }
      : {}),
  };
  const sqlite =
    backend === 'sqlite'
      ? new SqliteServerStorage(
          measureMethods(
            new BunSqliteDatabase(),
            measurements,
            'serverDatabase',
          ),
        )
      : undefined;
  const pgUrl = process.env.SYNCULAR_PG_URL;
  if (!sqlite && !pgUrl)
    throw new Error('Postgres benchmark requires SYNCULAR_PG_URL');
  const server: BenchServer & { database?: ServerSnapshot['database'] } = sqlite
    ? createBenchServer({
        ...serverOptions,
        storage: measureMethods(sqlite, measurements, 'storage'),
        close: () => sqlite.db.close(),
      })
    : await createPgServer(pgUrl ?? '', measurements, serverOptions);
  let database: ServerSnapshot['database'];
  try {
    if (server.database) database = server.database;
    else if (sqlite)
      database = {
        backend: 'sqlite',
        ...sqliteConfiguration(
          sqlite.db.query(SQLITE_CONFIGURATION_SQL).all(),
          false,
        ),
      };
    else throw new Error('Server database metadata missing');
    await seedServerRows(server, rows);
  } catch (error) {
    await server.close();
    throw error;
  }
  let cpuStart = process.cpuUsage();
  return {
    endpoints: server,
    async metrics(reset = false): Promise<ServerSnapshot> {
      const maxCommitSeq = await server.storage.getMaxCommitSeq(
        server.ctx.partition,
      );
      if (reset) {
        for (const key of Object.keys(measurements)) delete measurements[key];
        cpuStart = process.cpuUsage();
      }
      const cpu = process.cpuUsage(cpuStart);
      return {
        maxCommitSeq,
        database,
        measurements: structuredClone(measurements),
        cpuMs: (cpu.user + cpu.system) / 1000,
        rssBytes: process.memoryUsage().rss,
      };
    },
    close: async () => {
      await server.close();
    },
  };
}

/** One actual server process per trial; all clients use its public transports. */
export async function startSocketServer(
  rows: number,
  backend: 'sqlite' | 'postgres',
  profile: {
    rejectMiddle?: boolean;
    blobs?: boolean;
    revocation?: boolean;
    s3?: S3BlobStoreConfig;
  } = {},
) {
  if (profile.s3 && !profile.blobs)
    throw new Error('S3 profile requires the blob fixture');
  if (backend === 'postgres' && !process.env.SYNCULAR_PG_URL) {
    throw new Error('Postgres benchmark requires SYNCULAR_PG_URL');
  }
  let ready: (port: number) => void = () => {};
  const readiness = new Promise<number>((resolve) => {
    ready = resolve;
  });
  const child = Bun.spawn(
    [
      process.execPath,
      import.meta.path,
      String(rows),
      backend,
      profile.rejectMiddle ? 'reject-middle' : 'accept-all',
      profile.s3
        ? 'blobs-s3'
        : profile.blobs
          ? 'blobs'
          : profile.revocation
            ? 'revocation'
            : 'tasks',
    ],
    {
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'pipe',
      env: {
        ...process.env,
        SYNCULAR_BENCH_S3_CONFIG: profile.s3
          ? JSON.stringify(profile.s3)
          : undefined,
      },
      ipc(message: unknown) {
        if (
          typeof message === 'object' &&
          message !== null &&
          'port' in message &&
          typeof message.port === 'number' &&
          Number.isInteger(message.port) &&
          message.port > 0
        )
          ready(message.port);
      },
    },
  );
  const errors = new Response(child.stderr).text();
  try {
    const port = await withinDeadline(
      Promise.race([
        readiness,
        child.exited.then(async (code) => {
          throw new Error(
            `Benchmark server exited before readiness (${code}): ${await errors}`,
          );
        }),
      ]),
      'server readiness',
    );
    const origin = `http://127.0.0.1:${port}`;
    const endpoints: BenchEndpoints = {
      syncUrl: `${origin}/sync`,
      segmentsUrl: `${origin}/segments`,
      realtimeUrl: `ws://127.0.0.1:${port}/realtime`,
    };
    return {
      endpoints,
      async revokeProject(): Promise<void> {
        if (!profile.revocation) throw new Error('Revocation fixture required');
        const response = await fetch(`${origin}/__bench/revoke-project`, {
          method: 'POST',
          signal: AbortSignal.timeout(120_000),
        });
        if (!response.ok) throw new Error('Benchmark revocation failed');
      },
      async requests(clientId: string): Promise<unknown> {
        const response = await fetch(
          `${origin}/__bench/requests?clientId=${encodeURIComponent(clientId)}`,
          { signal: AbortSignal.timeout(120_000) },
        );
        if (!response.ok) throw new Error('Benchmark request trace failed');
        return response.json();
      },
      async metrics(reset = false): Promise<ServerSnapshot> {
        const response = await fetch(`${origin}/__bench/metrics`, {
          method: reset ? 'POST' : 'GET',
          signal: AbortSignal.timeout(120_000),
        });
        if (!response.ok)
          throw new Error('Benchmark server metrics request failed');
        return (await response.json()) as ServerSnapshot;
      },
      async close() {
        child.kill('SIGTERM');
        try {
          const code = await withinDeadline(
            child.exited,
            'server shutdown',
            10_000,
          );
          if (code !== 0)
            throw new Error(
              `Benchmark server shutdown failed (${code}): ${await errors}`,
            );
        } catch (error) {
          child.kill('SIGKILL');
          await child.exited;
          throw error;
        }
      },
    };
  } catch (error) {
    child.kill('SIGTERM');
    await withinDeadline(child.exited, 'failed server cleanup', 10_000).catch(
      async () => {
        child.kill('SIGKILL');
        await child.exited;
      },
    );
    throw error;
  }
}

if (import.meta.main) {
  const rows = Number(process.argv[2]);
  const backend = process.argv[3];
  const validation = process.argv[4];
  const fixtureKind = process.argv[5] ?? 'tasks';
  if (
    !Number.isInteger(rows) ||
    rows < 1 ||
    rows > 100_000 ||
    !['sqlite', 'postgres'].includes(backend ?? '') ||
    !['accept-all', 'reject-middle'].includes(validation ?? 'accept-all') ||
    !['tasks', 'blobs', 'blobs-s3', 'revocation'].includes(fixtureKind)
  ) {
    throw new Error('Invalid benchmark server fixture');
  }
  const measurements: Record<string, MethodMeasurement> = {};
  const s3 =
    fixtureKind === 'blobs-s3'
      ? new S3BlobStore(
          JSON.parse(
            process.env.SYNCULAR_BENCH_S3_CONFIG ?? 'null',
          ) as S3BlobStoreConfig,
        )
      : undefined;
  let revoked = false;
  const serverOptions = {
    measurements,
    rejectMiddle: validation === 'reject-middle',
    ...(fixtureKind === 'revocation'
      ? {
          resolveScopes: () => ({
            project_id: revoked ? [RETAINED_PROJECT_ID] : ['*'],
          }),
        }
      : {}),
    ...(fixtureKind === 'blobs' || s3
      ? {
          blobs: measureMethods(
            s3 ?? new MemoryBlobStore(),
            measurements,
            'blobStore',
          ),
          ...(s3
            ? {
                blobSignedUrls: s3PresignedBlobUrls(s3, { ttlSeconds: 900 }),
                blobUploadUrls: s3PresignedBlobUploads(s3, { ttlSeconds: 900 }),
                maxBlobBytes: 500_000_000,
              }
            : {}),
        }
      : {}),
  };
  const sqlite =
    backend === 'sqlite'
      ? new SqliteServerStorage(
          measureMethods(
            new BunSqliteDatabase(),
            measurements,
            'serverDatabase',
          ),
        )
      : undefined;
  const pgUrl = process.env.SYNCULAR_PG_URL;
  if (backend === 'postgres' && !pgUrl)
    throw new Error('Postgres benchmark requires SYNCULAR_PG_URL');
  const fixture: BenchServer & { database?: ServerSnapshot['database'] } =
    sqlite
      ? createBenchServer({
          ...serverOptions,
          storage: measureMethods(sqlite, measurements, 'storage'),
          close: () => sqlite.db.close(),
        })
      : await createPgServer(pgUrl ?? '', measurements, serverOptions);
  let stop: (() => Promise<void>) | undefined;
  let closing = false;
  process.on('SIGTERM', () => {
    if (closing) return;
    closing = true;
    void (async () => {
      try {
        await stop?.();
        await fixture.close();
        process.exit(0);
      } catch (error) {
        console.error(error);
        process.exit(1);
      }
    })();
  });
  try {
    let database: ServerSnapshot['database'];
    if (fixture.database) database = fixture.database;
    else if (sqlite)
      database = {
        backend: 'sqlite',
        ...sqliteConfiguration(
          sqlite.db.query(SQLITE_CONFIGURATION_SQL).all(),
          false,
        ),
      };
    else throw new Error('Server database metadata missing');
    await seedServerRows(fixture, rows);
    const hono = createSyncularHono({
      config: fixture.ctx,
      authenticate: async () => ({
        actorId: ACTOR_ID,
        partition: fixture.ctx.partition,
      }),
    });
    let cpuStart = process.cpuUsage();
    const requests: Array<{
      clientId: string;
      method: string;
      path: string;
      status: number;
      interrupted?: boolean;
    }> = [];
    const faultBodies = new Map<
      string,
      { prefix: Uint8Array; byteLength: number; clientId: string }
    >();
    const faultServer =
      fixtureKind === 'blobs'
        ? createServer((request, response) => {
            const key = request.url ?? '';
            const body = faultBodies.get(key);
            if (
              request.method !== 'GET' ||
              !body ||
              request.headers.authorization ||
              request.headers['x-bench-client-id']
            ) {
              response.writeHead(403);
              response.end();
              return;
            }
            faultBodies.delete(key);
            requests.push({
              clientId: body.clientId,
              method: 'GET',
              path: '/__bench/signed-blob',
              status: 200,
              interrupted: true,
            });
            response.writeHead(200, {
              'Content-Type': 'application/octet-stream',
              'Content-Length': body.byteLength,
              Connection: 'close',
            });
            response.end(body.prefix);
          })
        : undefined;
    let faultOrigin: string | undefined;
    if (faultServer) {
      await new Promise<void>((resolve, reject) => {
        faultServer.once('error', reject);
        faultServer.listen(0, '127.0.0.1', () => {
          faultServer.off('error', reject);
          resolve();
        });
      });
      const address = faultServer.address();
      if (!address || typeof address === 'string')
        throw new Error('Blob fault server has no TCP address');
      faultOrigin = `http://127.0.0.1:${address.port}`;
    }
    // Register cleanup before the public socket listener is created.
    stop = async () => {
      if (faultServer)
        await new Promise<void>((resolve, reject) => {
          faultServer.close((error) => (error ? reject(error) : resolve()));
          faultServer.closeAllConnections();
        });
    };
    const stopFaultServer = stop;
    let interruptBlob: string | undefined;
    const blobFaults: Array<{
      blobId: string;
      declaredBytes: number;
      sentBytes: number;
    }> = [];
    const server = Bun.serve<{
      clientId: string;
      session?: Promise<RealtimeSession>;
    }>({
      hostname: '127.0.0.1',
      port: 0,
      idleTimeout: 120,
      async fetch(request, host) {
        const url = new URL(request.url);
        if (url.pathname === '/realtime') {
          const clientId = url.searchParams.get('clientId');
          if (!clientId)
            return new Response('clientId required', { status: 400 });
          if (host.upgrade(request, { data: { clientId } })) return;
          return new Response('WebSocket required', { status: 400 });
        }
        if (
          fixtureKind === 'revocation' &&
          url.pathname === '/__bench/revoke-project'
        ) {
          if (request.method !== 'POST')
            return new Response('POST required', { status: 405 });
          revoked = true;
          return new Response(null, { status: 204 });
        }
        if (url.pathname === '/__bench/requests') {
          return Response.json(
            requests.filter(
              (entry) => entry.clientId === url.searchParams.get('clientId'),
            ),
          );
        }
        if (url.pathname === '/__bench/metrics') {
          const maxCommitSeq = await fixture.storage.getMaxCommitSeq(
            fixture.ctx.partition,
          );
          if (request.method === 'POST') {
            for (const key of Object.keys(measurements))
              delete measurements[key];
            cpuStart = process.cpuUsage();
            requests.length = 0;
          }
          const cpu = process.cpuUsage(cpuStart);
          return Response.json({
            maxCommitSeq,
            database,
            measurements,
            cpuMs: (cpu.user + cpu.system) / 1000,
            rssBytes: process.memoryUsage().rss,
          } satisfies ServerSnapshot);
        }
        if (
          fixtureKind === 'blobs' &&
          url.pathname === '/__bench/interrupt-blob'
        ) {
          if (request.method === 'POST') {
            const body: unknown = await request.json();
            if (
              typeof body !== 'object' ||
              body === null ||
              !('blobId' in body) ||
              typeof body.blobId !== 'string' ||
              !/^sha256:[a-f0-9]{64}$/.test(body.blobId) ||
              interruptBlob
            )
              return new Response('Invalid or already armed blob fault', {
                status: 400,
              });
            interruptBlob = body.blobId;
          }
          return Response.json({
            armed: interruptBlob ?? null,
            faults: blobFaults,
            pendingUrls: faultBodies.size,
          });
        }
        if (
          interruptBlob &&
          request.method === 'GET' &&
          decodeURIComponent(url.pathname) === `/blobs/${interruptBlob}`
        ) {
          const response = await hono.fetch(request);
          const clientId = request.headers.get('x-bench-client-id');
          if (clientId)
            requests.push({
              clientId,
              method: request.method,
              path: url.pathname,
              status: response.status,
            });
          if (!response.ok) return response;
          const bytes = new Uint8Array(await response.arrayBuffer());
          const prefix = bytes.subarray(
            0,
            Math.min(65536, Math.floor(bytes.length / 2)),
          );
          blobFaults.push({
            blobId: interruptBlob,
            declaredBytes: bytes.length,
            sentBytes: prefix.length,
          });
          interruptBlob = undefined;
          if (!faultOrigin) throw new Error('Blob fault server is unavailable');
          const token = `/${crypto.randomUUID()}`;
          faultBodies.set(token, {
            prefix,
            byteLength: bytes.length,
            clientId: clientId ?? '',
          });
          return Response.json({
            url: `${faultOrigin}${token}`,
            urlExpiresAtMs: Date.now() + 120_000,
          });
        }
        const response = await hono.fetch(request);
        const clientId = request.headers.get('x-bench-client-id');
        if (clientId)
          requests.push({
            clientId,
            method: request.method,
            path: url.pathname,
            status: response.status,
          });
        return response;
      },
      websocket: {
        open(ws) {
          ws.data.session = fixture.hub.connect({
            partition: fixture.ctx.partition,
            actorId: ACTOR_ID,
            clientId: ws.data.clientId,
            send: (data) => {
              ws.send(data);
            },
            closeSocket: () => ws.close(1008),
          });
          void ws.data.session.catch(() => ws.close(1011));
        },
        async message(ws, message) {
          try {
            const session = await ws.data.session;
            if (!session) throw new Error('Benchmark socket has no session');
            if (typeof message === 'string')
              await session.handleMessage(message);
            else await session.handleBinary(new Uint8Array(message));
          } catch {
            ws.close(1011);
          }
        },
        async close(ws) {
          try {
            (await ws.data.session)?.close();
          } catch {
            /* Connect already failed. */
          }
        },
      },
    });
    stop = async () => {
      try {
        await server.stop(true);
      } finally {
        await stopFaultServer();
      }
    };
    process.send?.({ port: server.port });
  } catch (error) {
    await stop?.();
    await fixture.close();
    throw error;
  }
}
