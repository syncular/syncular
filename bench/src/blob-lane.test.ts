import { expect, test } from 'bun:test';
import { runBlobLane, runProcessBlobs } from './blob-lane';
import { performanceOptions } from './performance';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BLOB_SCHEMA, PROJECT_ID } from './fixture';
import {
  assertProcessSync,
  createProcessDriver,
  processObject,
} from './process-driver';
import { startSocketServer } from './socket-server';

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
        const body = Uint8Array.from(
          { length: 1_048_579 },
          (_, i) => (i * 131 + Math.floor(i / 251)) % 256,
        );
        const sha256 = createHash('sha256').update(body).digest('hex');
        await writeFile(path, body);
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
