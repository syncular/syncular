import { expect, test } from 'bun:test';
import { runBlobLane, runProcessBlobs } from './blob-lane';
import { performanceOptions } from './performance';

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
