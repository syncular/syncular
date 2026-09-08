import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { expect, test } from 'bun:test';
import { runReadLane, runProcessReads } from './read-lane';
import { processObject } from './process-driver';

for (const persistent of [false, true]) {
  test(`fixed read surfaces preserve rows and revision (${persistent ? 'file' : 'memory'})`, async () => {
    const result = await runReadLane({ rows: 1000, iterations: 4, persistent });
    expect(result.validatedRows).toBe(1000);
    expect(result.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.revision).toMatch(/^[0-9]+$/);
    expect(JSON.parse(JSON.stringify(result)).revision).toBe(result.revision);
    expect(result.queries.map((query) => query.name)).toEqual([
      'primary-key',
      'bounded-result',
    ]);
    for (const query of result.queries) {
      expect(new Set(query.ids).size).toBe(4);
      expect(query.ids.every((id) => id.startsWith('row-'))).toBe(true);
      for (const samples of Object.values(query.samplesMs)) {
        expect(samples).toHaveLength(4);
        expect(
          samples.every((sample) => Number.isFinite(sample) && sample >= 0),
        ).toBe(true);
      }
      expect(query.work.database).toEqual({
        queries: [query.sql],
        transactions: 0,
      });
      expect(query.work.query).toEqual({
        queries: [query.sql],
        transactions: 0,
      });
      expect(query.work.snapshot?.transactions).toBe(1);
      expect(query.work.snapshot?.queries).toContain(query.sql);
      expect(query.work.snapshot?.queries.length).toBeGreaterThan(1);
      expect(query.plan.length).toBeGreaterThan(0);
    }
  });
}

const nativeBinary = process.env.SYNCULAR_NATIVE_BENCH;
for (const persistent of [false, true]) {
  test.skipIf(!nativeBinary).each(['direct', 'command', 'ffi'] as const)(
    `native read surfaces match the TS fixture (${persistent ? 'file' : 'memory'}, %s)`,
    async (boundary) => {
      if (!nativeBinary) throw new Error('Native benchmark binary required');
      const expected = await runReadLane({
        rows: 1000,
        iterations: 4,
        persistent,
      });
      const result = await runProcessReads({
        binary: nativeBinary,
        rows: 1000,
        iterations: 4,
        persistent,
        boundary,
      });
      expect(result.digest).toBe(expected.digest);
      expect(result.validatedRows).toBe(1000);
      expect(result.queries.map((query) => query.ids)).toEqual(
        expected.queries.map((query) => query.ids),
      );
      expect(result.clientResources[0]?.cpuMs).toBeGreaterThan(0);
      expect(result.clientSqlite).toHaveLength(1);
      expect(result.clientSqlite[0]).toMatchObject({
        pid: result.clientResources[0]?.pid,
        clientId: result.clientResources[0]?.clientId,
        journalMode: persistent ? 'wal' : 'memory',
        synchronous: 2,
      });
      expect(result.serverMetrics.database).toMatchObject({
        backend: 'sqlite',
        journalMode: 'memory',
        synchronous: 2,
      });

      for (const [index, query] of result.queries.entries()) {
        expect(query.sql).toBe(expected.queries[index]?.sql);
        for (const samples of Object.values(query.samplesMs)) {
          expect(samples).toHaveLength(4);
          expect(
            samples.every((value) => Number.isFinite(value) && value >= 0),
          ).toBe(true);
        }
        const work = processObject(query.work);
        for (const name of ['database', 'query']) {
          expect(processObject(work[name]).statements).toHaveLength(
            boundary === 'ffi' && name === 'query' ? 6 : 1,
          );
        }
        const statements = processObject(work.snapshot).statements;
        expect(statements).toHaveLength(boundary === 'ffi' ? 9 : 4);
        expect(JSON.stringify(statements)).toContain('SAVEPOINT');
        expect(JSON.stringify(statements)).toContain('localRevision');
        if (boundary === 'ffi') {
          expect(JSON.stringify(statements)).toContain('PRAGMA page_count');
          expect(JSON.stringify(statements)).toContain(
            '_syncular_commit_outcomes',
          );
          const ffi = processObject(query.ffi);
          for (const surface of ['query', 'snapshot']) {
            const timings = ffi[surface];
            expect(Array.isArray(timings)).toBe(true);
            if (!Array.isArray(timings)) throw new Error('Missing FFI timings');
            expect(timings).toHaveLength(4);
            for (const [index, raw] of timings.entries()) {
              const timing = processObject(raw);
              expect(Number(timing.callNs) / 1e6).toBe(
                Number(query.samplesMs[surface]?.[index]),
              );
              expect(timing.responseBytes).toBeGreaterThan(1);
              expect(timing.requestBytes).toBeGreaterThan(1);
            }
          }
        } else expect(query.ffi).toBeUndefined();
      }
    },
    30_000,
  );
}

const swiftBinary = process.env.SYNCULAR_SWIFT_BENCH;
for (const persistent of [false, true]) {
  test.skipIf(!swiftBinary)(
    `Swift SDK reads validate the shared fixture (${persistent ? 'file' : 'memory'})`,
    async () => {
      if (!swiftBinary) throw new Error('Swift benchmark binary required');
      const swiftLibraries: Record<string, string> = {};
      for (const path of [
        resolve(
          import.meta.dir,
          '../../rust/target/release/deps/libsyncular.dylib',
        ),
        join(dirname(swiftBinary), 'libSyncularSwiftBench.dylib'),
      ])
        swiftLibraries[path] = createHash('sha256')
          .update(new Uint8Array(await Bun.file(path).arrayBuffer()))
          .digest('hex');
      const expected = await runReadLane({
        rows: 1000,
        iterations: 4,
        persistent,
      });
      const options = {
        binary: swiftBinary,
        rows: 1000,
        iterations: 4,
        persistent,
        boundary: 'ffi' as const,
        swiftLibraries,
      };
      const result = await runProcessReads(options);
      expect(result.binding).toBe('swift');
      expect(result.digest).toBe(expected.digest);
      expect(result.queries.map((query) => query.ids)).toEqual(
        expected.queries.map((query) => query.ids),
      );
      expect(processObject(result.sqlite).journalMode).toBe(
        persistent ? 'wal' : 'memory',
      );
      expect(processObject(result.sqlite).synchronous).toBe(2);
      expect(result.clientResources[0]?.cpuMs).toBeGreaterThan(0);
      for (const [index, query] of result.queries.entries()) {
        expect(query.sql).toBe(expected.queries[index]?.sql);
        expect(query.plan).toBeArray();
        expect(Object.keys(query.samplesMs).sort()).toEqual([
          'query',
          'snapshot',
        ]);
        expect(query.work).toBeUndefined();
        expect(query.ffi).toBeUndefined();
        expect(query.samplesMs.query).toHaveLength(4);
        expect(query.samplesMs.snapshot).toHaveLength(4);
      }
      const wrongHashes = Object.fromEntries(
        Object.keys(swiftLibraries).map((path) => [path, '0'.repeat(64)]),
      );
      await expect(
        runProcessReads({ ...options, swiftLibraries: wrongHashes }),
      ).rejects.toThrow('library changed');
    },
    30_000,
  );
}
