import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  observationFixture,
  assertObservationRows,
  assertObservationOutcomes,
  sqliteConfiguration,
} from './fixture';
import { runObservationLane } from './observation-lane';
import { runProcessObservation } from './process-observation';
import { runPerformanceBench } from './performance';
import { processObject } from './process-driver';

test('observation validation rejects identically wrong writer and reader rows', () => {
  const fixture = observationFixture(150, 100);
  expect(fixture.initial).toHaveLength(150);
  expect(fixture.expected).toHaveLength(150);
  expect(fixture.expected.slice(100)).toEqual(fixture.initial.slice(100));
  expect(fixture.expected[0]).toMatchObject({
    id: 'row-0000000',
    title: 'observation-0',
    done: 0,
  });
  expect(fixture.expected[99]).toMatchObject({
    id: 'row-0000099',
    title: 'observation-99',
    priority: 4,
  });
  for (const wrong of [
    fixture.initial,
    fixture.expected.slice(1),
    [...fixture.expected, fixture.expected[0]],
    fixture.expected.map((row, index) =>
      index === 0 ? { ...row, title: 'wrong' } : row,
    ),
    fixture.expected.map((row, index) =>
      index === 149 ? { ...row, priority: row.priority + 1 } : row,
    ),
  ]) {
    const writer = structuredClone(wrong);
    const reader = structuredClone(wrong);
    expect(writer).toEqual(reader);
    expect(() => assertObservationRows(writer, fixture.expected)).toThrow(
      'deterministic fixture',
    );
    expect(() => assertObservationRows(reader, fixture.expected)).toThrow(
      'deterministic fixture',
    );
  }
  const inserts = observationFixture(3, 100);
  expect(inserts.initial).toHaveLength(3);
  expect(inserts.expected).toHaveLength(100);
  assertObservationRows([...fixture.expected].reverse(), fixture.expected);
});

test('observation validation requires every original durable outcome in journal order', () => {
  const ids = ['first', 'second'];
  const valid = [...ids].reverse().map((clientCommitId) => ({
    clientCommitId,
    status: 'applied',
    results: [{ status: 'applied', opIndex: 0 }],
  }));
  assertObservationOutcomes(valid, ids);
  for (const invalid of [
    valid.slice(1),
    [...valid].reverse(),
    [valid[0], valid[0]],
    valid.map((entry) => ({ ...entry, status: 'rejected' })),
    valid.map((entry) => ({
      ...entry,
      results: [{ status: 'applied', opIndex: 1 }],
    })),
    valid.map((entry) => ({ ...entry, results: [] })),
  ])
    expect(() => assertObservationOutcomes(invalid, ids)).toThrow('fixture');
});

for (const reconnect of [false, true]) {
  const count = reconnect ? 100 : 1;
  const rows = reconnect ? 32 : 150;
  const expected = observationFixture(rows, count);
  const digest = createHash('sha256')
    .update(JSON.stringify(expected.expected))
    .digest('hex');
  for (const lane of ['engine', 'socket'] as const) {
    test(`TS ${lane} ${reconnect ? 'reconnect' : 'fanout'} verifies seeded rows, edits, and original outcomes`, async () => {
      const options = {
        rows,
        readers: 2,
        reconnect,
        persistent: true,
        backend: 'sqlite' as const,
      };
      const result =
        lane === 'engine'
          ? await runObservationLane({ ...options, lane })
          : await runProcessObservation({
              ...options,
              core: 'ts',
              boundary: 'direct',
              binary: [process.execPath, `${import.meta.dir}/ts-process.ts`],
            });
      expect(result.validation).toBe(
        'independent-fixture-and-original-outcomes',
      );
      expect(result.digest).toBe(digest);
      expect(result.validatedRows).toBe(Math.max(rows, count));
      expect(result.validatedCommitIds).toHaveLength(count);
      expect(new Set(result.validatedCommitIds).size).toBe(count);
      expect(result.serverMetrics.maxCommitSeq).toBe(count);
      expect(result.perReaderMs).toHaveLength(2);
      expect(result.clientSqlite).toHaveLength(3);
      expect(
        new Set(result.clientSqlite.map((client) => client.pid)).size,
      ).toBe(lane === 'engine' ? 1 : 3);
      for (const client of result.clientSqlite) {
        expect(client.version).toMatch(/^\d+\.\d+\.\d+$/);
        expect(client.journalMode).toBe('wal');
        expect(client.synchronous).toBe(2);
        if (lane === 'socket') expect(client.pid).not.toBe(process.pid);
      }
      expect(result.executionModel).toBe(
        lane === 'engine' ? 'shared-process' : 'isolated-client-processes',
      );
    });
  }
  for (const boundary of ['direct', 'command'] as const) {
    const binary = process.env.SYNCULAR_NATIVE_BENCH;
    test.skipIf(!binary)(
      `Rust ${boundary} ${reconnect ? 'reconnect' : 'fanout'} verifies the same independent fixture`,
      async () => {
        if (!binary) throw new Error('Native benchmark binary missing');
        const result = await runProcessObservation({
          binary,
          core: 'rust',
          nativeSql: reconnect,
          nativePhases: true,
          rows,
          readers: 2,
          reconnect,
          persistent: true,
          boundary,
          backend: 'sqlite',
        });
        expect(result.validation).toBe(
          'independent-fixture-and-original-outcomes',
        );
        expect(result.digest).toBe(digest);
        expect(result.validatedRows).toBe(Math.max(rows, count));
        expect(result.validatedCommitIds).toHaveLength(count);
        expect(new Set(result.validatedCommitIds).size).toBe(count);
        expect(result.serverMetrics.maxCommitSeq).toBe(count);
        expect(result.perReaderMs).toHaveLength(2);
        expect(result.clientSqlite).toHaveLength(3);
        expect(
          new Set(result.clientSqlite.map((client) => client.pid)).size,
        ).toBe(3);
        expect(
          result.clientSqlite.every(
            (client) =>
              client.pid !== process.pid &&
              client.journalMode === 'wal' &&
              client.synchronous === 2,
          ),
        ).toBe(true);
        expect(result.executionModel).toBe('isolated-client-processes');
        expect(result.nativeSql).toBe(reconnect);
        for (const observation of result.observations) {
          const record = processObject(observation);
          const stats = processObject(record.stats);
          const phases = processObject(
            processObject(stats.phases).measurements,
          );
          expect(processObject(phases.commitApply).calls).toBe(count);
          expect(
            processObject(phases.observationCommit).threadCpuNs,
          ).toBeGreaterThanOrEqual(0);
          if (reconnect) {
            const sync = processObject(record.reconnectSync);
            expect(sync.elapsedNs).toBeGreaterThan(0);
            const counts = processObject(stats.sqliteCounts);
            expect(counts.commitHookCalls).toBeGreaterThan(0);
            expect(counts.rollbackHookCalls).toBe(0);
            expect(processObject(counts.statements).RELEASE).toBeGreaterThan(0);
            expect(processObject(sync.stats).sqliteCounts).toBeDefined();
          } else {
            expect(record.reconnectSync).toBeUndefined();
            expect(stats.sqliteCounts).toBeUndefined();
          }
        }
      },
    );
  }
}

test('observation SQLite metadata rejects weakened durability and invalid settings', () => {
  expect(
    sqliteConfiguration(
      [{ version: '3.46.0', journalMode: 'wal', synchronous: 2 }],
      true,
    ),
  ).toEqual({ version: '3.46.0', journalMode: 'wal', synchronous: 2 });
  expect(
    sqliteConfiguration(
      [{ version: '3.46.0', journalMode: 'memory', synchronous: 2 }],
      false,
    ).journalMode,
  ).toBe('memory');
  for (const value of [
    [],
    [{}],
    [{ version: 'unknown', journalMode: 'wal', synchronous: 2 }],
    [{ version: '3.46.0', journalMode: 'delete', synchronous: 2 }],
    [{ version: '3.46.0', journalMode: 'wal', synchronous: 1 }],
  ])
    expect(() => sqliteConfiguration(value, true)).toThrow(
      'SQLite configuration',
    );
});

for (const storage of ['memory', 'file']) {
  for (const workload of ['fanout', 'reconnect']) {
    test(`TS ${workload} CLI selects isolated clients with ${storage} SQLite`, async () => {
      const directory = await mkdtemp(
        join(tmpdir(), 'syncular-observation-cli-'),
      );
      const output = join(directory, 'result.json');
      try {
        await runPerformanceBench([
          '--workload',
          workload,
          '--core',
          'ts',
          '--lane',
          'socket',
          '--storage',
          storage,
          '--rows',
          '32',
          '--sizes',
          '2',
          '--trials',
          '1',
          '--output',
          output,
        ]);
        const artifact = await Bun.file(output).json();
        expect(artifact.attempts).toHaveLength(1);
        const attempt = artifact.attempts[0];
        expect(attempt.status).toBe('completed');
        expect(attempt.executionModel).toBe('isolated-client-processes');
        expect(attempt.clientResources).toHaveLength(3);
        expect(
          attempt.clientSqlite.map((client: { pid: number }) => client.pid),
        ).toEqual(
          attempt.clientResources.map((client: { pid: number }) => client.pid),
        );
        expect(
          new Set(
            attempt.clientSqlite.map((client: { pid: number }) => client.pid),
          ).size,
        ).toBe(3);
        expect(attempt.nativeSql).toBe(false);
        for (const observation of attempt.observations) {
          if (workload === 'reconnect') {
            expect(observation.reconnectSync.elapsedNs).toBeGreaterThan(0);
            expect(observation.reconnectSync.stats).toBeDefined();
          } else expect(observation.reconnectSync).toBeUndefined();
        }
        for (const client of attempt.clientSqlite) {
          expect(client.pid).not.toBe(process.pid);
          expect(client.version).toMatch(/^\d+\.\d+\.\d+$/);
          expect(client.journalMode).toBe(
            storage === 'file' ? 'wal' : 'memory',
          );
          expect(client.synchronous).toBe(2);
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
}

const nativeBinary = process.env.SYNCULAR_NATIVE_BENCH;
test.skipIf(!nativeBinary)(
  'native SQL CLI records counters and interval boundaries',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'syncular-native-sql-cli-'));
    const output = join(directory, 'result.json');
    try {
      await runPerformanceBench([
        '--workload',
        'reconnect',
        '--core',
        'rust',
        '--lane',
        'socket',
        '--storage',
        'file',
        '--rows',
        '32',
        '--sizes',
        '1',
        '--trials',
        '1',
        '--native-sql',
        '--output',
        output,
      ]);
      const artifact = await Bun.file(output).json();
      expect(artifact.options.nativeSql).toBe(true);
      expect(artifact.attempts).toHaveLength(1);
      const attempt = artifact.attempts[0];
      expect(attempt.status).toBe('completed');
      expect(attempt.nativeSql).toBe(true);
      expect(
        attempt.observations[0].stats.sqliteCounts.commitHookCalls,
      ).toBeGreaterThan(0);
      expect(attempt.boundaries).toContain('pre-commit/rollback hook counts');
      expect(attempt.validatedCommits).toBe(100);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
