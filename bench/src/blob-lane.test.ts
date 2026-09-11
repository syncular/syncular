import { expect, test } from 'bun:test';
import { runBlobLane, runProcessBlobs, runBlobFile } from './blob-lane';
import { performanceOptions } from './performance';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { BLOB_SCHEMA, PROJECT_ID, writeBlobFixture } from './fixture';
import {
  assertProcessSync,
  createProcessDriver,
  processObject,
} from './process-driver';
import { startSocketServer } from './socket-server';

test('large blob file options require isolated persistent direct clients and MinIO', () => {
  const base = [
    '--workload',
    'blobs',
    '--lane',
    'socket',
    '--storage',
    'file',
    '--blob-profile',
    'file',
  ];
  const large = [...base, '--blob-store', 'minio', '--sizes', '500000000'];
  expect(performanceOptions(large).sizes).toEqual([500_000_000]);
  expect(performanceOptions([...large, '--core', 'rust']).blobStore).toBe(
    'minio',
  );
  expect(
    performanceOptions([...large, '--core', 'rust', '--blob-result', 'legacy'])
      .blobResult,
  ).toBe('legacy');
  expect(
    performanceOptions([...large, '--blob-reference-rows', '100000'])
      .blobReferenceRows,
  ).toBe(100_000);
  for (const args of [
    [...base, '--sizes', '500000000'],
    [...large, '--sizes', '500000001'],
    [...large, '--lane', 'engine'],
    [...large, '--storage', 'memory'],
    [...large, '--core', 'rust', '--boundary', 'command'],
    [...large, '--core', 'rust', '--native-phases'],
    [...large, '--blob-profile', 'lifecycle'],
    [...large, '--blob-store', 'unknown'],
    [...large, '--blob-diagnostics', 'unknown'],
    [...large, '--blob-result', 'typed'],
    [...large, '--core', 'rust', '--blob-result', 'unknown'],
    [...large, '--blob-reference-rows', '0'],
    [...large, '--blob-reference-rows', '100001'],
    [...large, '--workload', 'replay'],
  ])
    expect(() => performanceOptions(args)).toThrow();
});

for (const core of ['ts', 'rust'] as const)
  for (const blobStore of ['memory', 'minio'] as const)
    for (const blobDiagnostics of [true, false])
      test.skipIf(
        (core === 'rust' && !process.env.SYNCULAR_NATIVE_BENCH) ||
          (blobStore === 'minio' && process.env.SYNCULAR_BLOB_S3_TEST !== '1'),
      )(
        `${core} file profile validates ${blobStore} transfers and offline reopen (diagnostics=${blobDiagnostics})`,
        async () => {
          const binary =
            core === 'ts'
              ? [process.execPath, join(import.meta.dir, 'ts-process.ts')]
              : process.env.SYNCULAR_NATIVE_BENCH;
          if (!binary) throw new Error('Native benchmark executable required');
          const result = await runBlobFile({
            binary,
            byteLength: 65_537,
            rows: 1,
            backend: 'sqlite',
            blobStore,
            blobDiagnostics,
          });
          expect(result.fixture.sha256).toBe(
            'fd38c4d8477e4584f719145445f1c2497a64636450eb3c82b98fdab04c42fdd5',
          );
          expect(result.validatedObjects).toBe(1);
          expect(
            new Set(result.clientResources.map((client) => client.pid)).size,
          ).toBe(3);
          expect(
            result.clientResources.every((client) => client.peakRssBytes > 0),
          ).toBe(true);
          expect(result.clientSqlite).toHaveLength(3);
          for (const phase of [
            result.stages.staged,
            result.stages.downloaded,
            result.stages.cacheHit,
            result.stages.reopenedHit,
          ]) {
            expect(phase.operationMs).toBeGreaterThanOrEqual(0);
            expect(phase.delivery.responseBytes).toBeLessThan(65_536);
            expect(processObject(phase.validation).byteLength).toBe(65_537);
            const stats = processObject(processObject(phase).stats);
            expect(stats.blobDiagnostics).toBe(blobDiagnostics);
            if (!blobDiagnostics) {
              if (core === 'ts') expect(stats.measurements).toEqual({});
              else expect(stats.blobRequests).toEqual([]);
            }
          }
          expect(result.disk.map((phase) => phase.phase)).toEqual([
            'staged',
            'uploaded',
            'downloaded',
          ]);
          if (result.objectStore) {
            expect(result.objectStore.storageReceipt?.byteLength).toBe(65_537);
            const uploadStats = processObject(
              result.stages.uploadAndCommit.stats,
            );
            if (!blobDiagnostics) {
              if (core === 'ts') expect(uploadStats.measurements).toEqual({});
              else expect(uploadStats.blobRequests).toEqual([]);
            } else if (core === 'rust')
              expect(uploadStats.blobRequests).toEqual(
                expect.arrayContaining([
                  expect.objectContaining({
                    method: 'putUrl',
                    bytes: 65_537,
                    failed: false,
                    elapsedNs: expect.any(Number),
                  }),
                ]),
              );
            else
              expect(
                processObject(
                  processObject(uploadStats.measurements)[
                    'blobTransport.uploadToUrl'
                  ],
                ).calls,
              ).toBe(1);
            expect(
              result.serverMetrics.measurements['blobStore.get'],
            ).toBeUndefined();
            expect(
              Bun.spawnSync(['docker', 'inspect', result.objectStore.container])
                .exitCode,
            ).not.toBe(0);
          }
        },
        60_000,
      );

test('blob fixture files match independent OpenSSL vectors across buffer boundaries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'syncular-blob-fixture-'));
  try {
    // OpenSSL AES-256-CTR over zero bytes, SHA-256 checked with Python hashlib.
    for (const [seed, byteLength, sha256] of [
      [
        0,
        1,
        '7c5bd2d144fdde498406edcb9fe60ce65b0dfa5f2dd7a7617f505e3d46d68bdb',
      ],
      [
        0,
        65535,
        '88771a4af5f0c536f21b85e44c1df42020eae0990c0694f7b2b8a3fead4a0ad0',
      ],
      [
        0,
        65536,
        '90913cfcc96c4850ed0ab49d4afa1f98a4fa0a96465b2d069e0234a638cb28ae',
      ],
      [
        0,
        65537,
        'fd38c4d8477e4584f719145445f1c2497a64636450eb3c82b98fdab04c42fdd5',
      ],
      [
        1,
        131075,
        'e821af81e1dd279a787c05594f9314660f2f8168b77ff2dc991632ddc64e04ab',
      ],
    ] as const) {
      const path = join(directory, `${seed}-${byteLength}.bin`);
      expect(await writeBlobFixture(path, byteLength, seed)).toEqual({
        algorithm: 'aes-256-ctr-zero-v1',
        seed,
        byteLength,
        sha256,
      });
      const bytes = await readFile(path);
      expect(bytes.length).toBe(byteLength);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(sha256);
      if (byteLength > 1)
        expect(deflateSync(bytes).length).toBeGreaterThan(byteLength * 0.99);
      await expect(writeBlobFixture(path, byteLength, seed)).rejects.toThrow();
      expect(await readFile(path)).toEqual(bytes);
    }
    for (const [byteLength, seed] of [
      [0, 0],
      [-1, 0],
      [1.5, 0],
      [500_000_001, 0],
      [Number.NaN, 0],
      [1, -1],
      [1, 0x1_0000_0000],
      [1, 0.5],
      [1, Infinity],
    ] as const) {
      const path = join(directory, 'invalid.bin');
      await expect(writeBlobFixture(path, byteLength, seed)).rejects.toThrow(
        'uint32 seed',
      );
      expect(await Bun.file(path).exists()).toBe(false);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const core of ['ts', 'rust'] as const)
  test.skipIf(core === 'rust' && !process.env.SYNCULAR_NATIVE_BENCH)(
    `${core} blob file receipts validate isolated download and staged restart without body IPC`,
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'syncular-blob-receipt-'));
      const server = await startSocketServer(1, 'sqlite', { blobs: true });
      const clients: Array<Awaited<ReturnType<typeof createProcessDriver>>> =
        [];
      try {
        const binary =
          core === 'ts'
            ? [process.execPath, join(import.meta.dir, 'ts-process.ts')]
            : process.env.SYNCULAR_NATIVE_BENCH;
        if (!binary) throw new Error('Native benchmark executable required');
        const path = join(directory, 'fixture.bin');
        const fixture = await writeBlobFixture(path, 1_048_579);
        const body = await readFile(path);
        const sha256 = createHash('sha256').update(body).digest('hex');
        expect(fixture.sha256).toBe(sha256);
        const writerPath = join(directory, 'writer.sqlite');
        const writer = await createProcessDriver(
          binary,
          server.endpoints,
          writerPath,
          undefined,
          BLOB_SCHEMA,
        );
        clients.push(writer);
        assertProcessSync(await writer.invoke('syncUntilIdle'));
        await expect(
          writer.invoke('benchBlobFile', {
            mode: 'command',
            operation: 'uploadBlob',
            path,
          }),
        ).rejects.toThrow('direct boundary');
        await expect(
          writer.invoke('benchBlobFile', {
            mode: 'direct',
            operation: 'uploadBlob',
            path: join(directory, 'absent'),
          }),
        ).rejects.toThrow();
        const stage = processObject(
          await writer.invoke('benchBlobFile', {
            mode: 'direct',
            operation: 'uploadBlob',
            path,
          }),
        );
        expect(stage.validation).toEqual({ byteLength: body.length, sha256 });
        expect(stage.elapsedNs).toBeGreaterThanOrEqual(0);
        expect(stage.sourceReadNs).toBeGreaterThanOrEqual(0);
        expect(stage.validationNs).toBeGreaterThanOrEqual(0);
        const ref = processObject(stage.ref);
        const row = {
          id: 'file-1',
          project_id: PROJECT_ID,
          body: JSON.stringify(ref),
        };
        const mutation = processObject(
          await writer.invoke('benchMutate', {
            mode: 'direct',
            commits: [
              {
                mutations: [
                  { table: 'attachments', op: 'upsert', values: row },
                ],
              },
            ],
          }),
        );
        expect(await writer.terminate()).toEqual({
          pid: writer.pid,
          signal: 'SIGKILL',
        });
        clients.pop();
        await rm(path);
        const reopened = await createProcessDriver(
          binary,
          server.endpoints,
          writerPath,
          writer.clientId,
          BLOB_SCHEMA,
        );
        clients.push(reopened);
        expect(reopened.pid).not.toBe(writer.pid);
        expect(
          processObject(await reopened.invoke('statusSnapshot')).outbox,
        ).toBe(1);
        expect(
          processObject(
            await reopened.invoke('query', {
              sql: 'SELECT blob_id FROM _syncular_blob_uploads',
            }),
          ).rows,
        ).toEqual([{ blob_id: ref.blobId }]);
        await reopened.invoke('stats', { reset: true });
        const offline = processObject(
          await reopened.invoke('benchBlobFile', {
            mode: 'direct',
            operation: 'fetchBlob',
            blob: ref.blobId,
          }),
        );
        expect(offline.validation).toEqual(stage.validation);
        if (core === 'ts') {
          expect(
            processObject(processObject(offline.stats).measurements)[
              'blobTransport.download'
            ],
          ).toBeUndefined();
        } else {
          expect(processObject(offline.stats).blobRequests).toEqual([]);
        }
        assertProcessSync(await reopened.invoke('syncUntilIdle'), 1);
        if (!Array.isArray(mutation.ids))
          throw new Error('Missing original commit ids');
        expect(
          processObject(
            processObject(
              await reopened.invoke('commitOutcome', {
                clientCommitId: mutation.ids[0],
              }),
            ).outcome,
          ).status,
        ).toBe('applied');

        const reader = await createProcessDriver(
          binary,
          server.endpoints,
          join(directory, 'reader.sqlite'),
          undefined,
          BLOB_SCHEMA,
        );
        clients.push(reader);
        expect(reader.pid).not.toBe(reopened.pid);
        await reader.invoke('subscribe', {
          id: 'attachments',
          table: 'attachments',
          scopes: { project_id: [PROJECT_ID] },
        });
        assertProcessSync(await reader.invoke('syncUntilIdle'));
        expect(
          processObject(
            await reader.invoke('query', {
              sql: 'SELECT id, project_id, body FROM attachments WHERE id = ?',
              params: [row.id],
            }),
          ).rows,
        ).toEqual([row]);
        expect(
          processObject(
            await reader.invoke('query', {
              sql: 'SELECT count(*) AS n FROM _syncular_blobs',
            }),
          ).rows,
        ).toEqual([{ n: 0 }]);
        await reader.invoke('stats', { reset: true });
        const before = reader.deliveryStats();
        const fetched = processObject(
          await reader.invoke('benchBlobFile', {
            mode: 'direct',
            operation: 'fetchBlob',
            blob: row.body,
          }),
        );
        expect(fetched.validation).toEqual(stage.validation);
        expect(fetched.sourceReadNs).toBeUndefined();
        if (core === 'ts')
          expect(
            processObject(
              processObject(processObject(fetched.stats).measurements)[
                'blobTransport.download'
              ],
            ).calls,
          ).toBe(1);
        else
          expect(processObject(fetched.stats).blobRequests).toEqual([
            expect.objectContaining({
              method: 'download',
              failed: false,
              bytes: body.length,
            }),
          ]);
        expect(
          reader.deliveryStats().responseBytes - before.responseBytes,
        ).toBeLessThan(16_384);
        expect(
          reader.deliveryStats().requestBytes - before.requestBytes,
        ).toBeLessThan(1024);
        await reader.invoke('stats', { reset: true });
        const cached = processObject(
          await reader.invoke('benchBlobFile', {
            mode: 'direct',
            operation: 'fetchBlob',
            blob: ref.blobId,
          }),
        );
        expect(cached.validation).toEqual(stage.validation);
        if (core === 'ts')
          expect(
            processObject(processObject(cached.stats).measurements)[
              'blobTransport.download'
            ],
          ).toBeUndefined();
        else expect(processObject(cached.stats).blobRequests).toEqual([]);
      } finally {
        try {
          await Promise.all(clients.map((client) => client.close()));
        } finally {
          await server.close();
          await rm(directory, { recursive: true, force: true });
        }
      }
    },
    30_000,
  );

test('blob diagnostics declare body sizes and reject unsupported boundaries', () => {
  const base = ['--workload', 'blobs', '--lane', 'socket'];
  expect(
    performanceOptions([...base, '--core', 'rust', '--boundary', 'command'])
      .core,
  ).toBe('rust');
  expect(
    performanceOptions([...base, '--core', 'rust', '--boundary', 'ffi'])
      .boundary,
  ).toBe('ffi');
  expect(() =>
    performanceOptions([
      '--workload',
      'replay',
      '--core',
      'rust',
      '--lane',
      'socket',
      '--boundary',
      'ffi',
    ]),
  ).toThrow('blob or read workload');
  expect(performanceOptions(base).sizes).toEqual([65536, 2097152, 16777216]);
  for (const extra of [
    ['--core', 'rust', '--lane', 'engine'],
    ['--lane', 'native'],
    ['--sizes', '1'],
  ])
    expect(() => performanceOptions([...base, ...extra])).toThrow();
});

for (const persistent of [false, true])
  test.each(['engine', 'socket'] as const)(
    `blob lifecycle verifies bytes, cache hits, and metadata (%s, persistent=${persistent})`,
    async (lane) => {
      const result = await runBlobLane({
        rows: 1,
        byteLength: 4096,
        objects: 2,
        persistent,
        lane,
        backend: 'sqlite',
      });
      expect(result.validatedObjects).toBe(2);
      expect(result.clientSqlite.map((entry) => entry.role)).toEqual([
        'writer',
        'reader',
        'recovery',
      ]);
      expect(
        new Set(result.clientSqlite.map((entry) => entry.clientId)).size,
      ).toBe(3);
      for (const entry of result.clientSqlite) {
        expect(entry.pid).toBe(process.pid);
        expect(entry.version).toMatch(/^\d+\.\d+\.\d+$/);
        expect(entry.journalMode).toBe(persistent ? 'wal' : 'memory');
        expect(entry.synchronous).toBe(2);
      }
      expect(result.serverMetrics.database).toMatchObject({
        backend: 'sqlite',
        journalMode: 'memory',
        synchronous: 2,
      });

      expect(result.validatedBytes).toBe(8192);
      expect(result.interruptedBytes).toBeGreaterThan(0);
      expect(result.interruptedBytes).toBeLessThan(8192);
      expect(result.samples).toHaveLength(2);
      expect(result.serverMetrics.maxCommitSeq).toBe(2);
      for (const { phases } of result.samples) {
        expect(
          phases.download.measurements['blobTransport.download']?.calls,
        ).toBe(1);
        expect(
          phases.cacheHit.measurements['blobTransport.download'],
        ).toBeUndefined();
        expect(
          phases.interrupted.measurements['blobTransport.download']?.failures,
        ).toBe(1);
        expect(
          phases.recovery.measurements['blobTransport.download']?.calls,
        ).toBe(1);
        expect(
          phases.recovery.measurements['blobTransport.download']?.failures,
        ).toBe(0);
        for (const phase of Object.values(phases)) {
          expect(phase.elapsedMs).toBeGreaterThanOrEqual(0);
          expect(JSON.stringify(phase.measurements)).not.toContain(
            'sqlite_version()',
          );
          for (const measurement of Object.values(phase.measurements)) {
            expect(measurement.calls).toBeGreaterThan(0);
            expect(measurement.elapsedMs).toBeGreaterThanOrEqual(0);
          }
        }
        // Statement timings partition exec time without duplicating bound bodies.
        const execShapes = Object.entries(phases.download.measurements).filter(
          ([name]) => name.startsWith('database.exec: '),
        );
        expect(
          execShapes.reduce((sum, [, value]) => sum + value.calls, 0),
        ).toBe(phases.download.measurements['database.exec']!.calls);
      }
    },
    30_000,
  );

const nativeBinary = process.env.SYNCULAR_NATIVE_BENCH;
for (const persistent of [false, true])
  test.skipIf(!nativeBinary).each(['direct', 'command', 'ffi'] as const)(
    `native blob lifecycle validates bytes and metadata (%s, persistent=${persistent})`,
    async (boundary) => {
      if (!nativeBinary)
        throw new Error('Native benchmark executable required');
      const result = await runProcessBlobs({
        binary: nativeBinary,
        nativePhases: boundary !== 'ffi',
        rows: 1,
        byteLength: 4096,
        objects: 2,
        persistent,
        backend: 'sqlite',
        boundary,
      });
      expect(result.validatedObjects).toBe(2);
      expect(result.interruptedBytes).toBe(4096);
      expect(result.cacheState).toHaveLength(3);
      expect(result.clientSqlite).toHaveLength(3);
      for (const entry of result.clientSqlite) {
        const resource = result.clientResources.find(
          (resource) => resource.role === entry.role,
        );
        if (!resource)
          throw new Error('Client metadata has no resource record');
        expect(entry.pid).toBe(resource.pid);
        expect(entry.clientId).toBe(resource.clientId);
        expect(entry.version).toMatch(/^\d+\.\d+\.\d+$/);
        expect(entry.journalMode).toBe(persistent ? 'wal' : 'memory');
        expect(entry.synchronous).toBe(2);
      }

      expect(result.clientResources.map((entry) => entry.role)).toEqual([
        'writer',
        'reader',
        'recovery',
      ]);
      expect(
        new Set(result.clientResources.map((entry) => entry.pid)).size,
      ).toBe(3);
      for (const usage of result.clientResources) {
        expect(usage.scope).toBe('process-lifetime');
        expect(usage.cpuMs).toBeGreaterThan(0);
        expect(usage.peakRssBytes).toBeGreaterThan(0);
        expect(() => JSON.stringify(usage)).not.toThrow();
      }
      expect(result.serverMetrics.maxCommitSeq).toBe(2);
      for (const sample of result.samples) {
        if (boundary !== 'ffi') {
          expect(
            sample.nativePhases?.download?.measurements.blobDownload?.calls,
          ).toBe(1);
          expect(
            sample.nativePhases?.download?.measurements.blobCacheInsert?.calls,
          ).toBe(1);
          expect(
            sample.nativePhases?.cacheHit?.measurements.blobDownload,
          ).toBeUndefined();
          expect(
            sample.nativePhases?.cacheHit?.measurements.blobEncode?.calls,
          ).toBe(1);
          expect(
            sample.nativePhases?.interrupted?.measurements.blobDownload?.calls,
          ).toBe(1);
          expect(
            sample.nativePhases?.interrupted?.measurements.blobCacheInsert,
          ).toBeUndefined();
        }
        expect(sample.interruptionError.code).toBe('transport.failed');
        if (boundary === 'ffi') {
          if (!('ffi' in sample))
            throw new Error('FFI sample has no C ABI measurements');
          expect('nativeOperationMs' in sample).toBe(false);
          expect(sample.ffi?.download?.callNs).toBeGreaterThan(0);
          expect(sample.ffi?.download?.responseBytes).toBeGreaterThan(
            sample.byteLength * 2,
          );
          expect(sample.ffi?.download?.responseCopyNs).toBeGreaterThanOrEqual(
            0,
          );
          expect(sample.ffi?.download?.responseFreeNs).toBeGreaterThanOrEqual(
            0,
          );
        }
        expect(sample.transport.recovery.at(-2)?.failed).toBe(true);
        expect(sample.transport.recovery.at(-1)?.failed).toBe(false);
        expect(sample.delivery.stage.requestBytes).toBeGreaterThan(
          sample.byteLength * 2,
        );
        expect(sample.delivery.download.responseBytes).toBeGreaterThan(
          sample.byteLength * 2,
        );
        expect(sample.delivery.download.responseParseMs).toBeGreaterThanOrEqual(
          0,
        );
        expect(sample.decodeMs.download).toBeGreaterThanOrEqual(0);
      }
    },
    30_000,
  );
