import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { runProcessReplay } from './process-lane';
import { performanceOptions, runPerformanceBench } from './performance';
import {
  processObject,
  processPhases,
  processSampling,
} from './process-driver';

test.skipIf(!process.env.SYNCULAR_NATIVE_BENCH)(
  'native replay CLI records bounded pending replay and SQL counts',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'syncular-replay-phases-'));
    const output = join(directory, 'result.json');
    try {
      await runPerformanceBench([
        '--workload',
        'replay',
        '--core',
        'rust',
        '--lane',
        'socket',
        '--storage',
        'file',
        '--sizes',
        '501',
        '--rows',
        '32',
        '--trials',
        '1',
        '--native-phases',
        '--native-sql',
        '--output',
        output,
      ]);
      const artifact = processObject(await Bun.file(output).json());
      expect(processObject(artifact.options).nativePhases).toBe(true);
      if (!Array.isArray(artifact.attempts))
        throw new Error('Missing phase attempt');
      const attempt = processObject(artifact.attempts[0]);
      expect(attempt.status).toBe('completed');
      expect(attempt.validatedCommits).toBe(501);
      const stats = processObject(attempt.writerStats);
      const phases = processPhases(stats.phases).measurements;
      expect(phases.commitApply?.calls).toBe(501);
      expect(phases.pendingReplay?.units).toBe(1);
      expect(phases.outboxEncode?.calls).toBeGreaterThanOrEqual(2);
      expect(processObject(stats.sqliteCounts).rollbackHookCalls).toBe(0);
      expect(
        processPhases(
          processObject(processObject(attempt.readerObservation).stats).phases,
        ).measurements.commitApply?.calls,
      ).toBe(501);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);

test.each(['independent', 'repeated'])(
  'TS socket replay CLI isolates clients and validates FIFO acknowledgements (%s)',
  async (pattern) => {
    const directory = await mkdtemp(join(tmpdir(), 'syncular-replay-cli-'));
    const output = join(directory, 'result.json');
    try {
      await runPerformanceBench([
        '--workload',
        'replay',
        '--core',
        'ts',
        '--lane',
        'socket',
        '--storage',
        'file',
        '--sizes',
        '501',
        '--rows',
        '32',
        '--pattern',
        pattern,
        '--trials',
        '1',
        '--output',
        output,
      ]);
      const artifact = await Bun.file(output).json();
      expect(artifact.attempts).toHaveLength(1);
      const result = artifact.attempts[0];
      expect(result.status).toBe('completed');
      expect(result.validatedCommits).toBe(501);
      expect(result.validatedOperations).toBe(501);
      expect(result.appliedCommits).toBe(501);
      expect(result.rejectedCommits).toBe(0);
      expect(result.validatedRows).toBe(pattern === 'repeated' ? 32 : 501);
      expect(result.serverMetrics.maxCommitSeq).toBe(501);
      const serverMeasurements = result.serverMetrics.measurements;
      expect(serverMeasurements['storage.advanceClientCursor'].calls).toBe(501);
      expect(serverMeasurements['storage.advanceClientCursor'].failures).toBe(
        0,
      );
      expect(
        serverMeasurements['storage.getClientRecord'].calls,
      ).toBeLessThanOrEqual(10);
      expect(
        serverMeasurements['storage.putClientRecord'].calls,
      ).toBeLessThanOrEqual(5);
      expect(result.sqlite.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(result.sqlite.journalMode).toBe('wal');
      expect(result.sqlite.synchronous).toBe(2);
      expect(result.clientSqlite).toHaveLength(2);
      for (const entry of result.clientSqlite) {
        const resource = result.clientResources.find(
          (resource: { role: string }) => resource.role === entry.role,
        );
        if (!resource)
          throw new Error('Client metadata has no resource record');
        expect(entry.pid).toBe(resource.pid);
        expect(entry.clientId).toBe(resource.clientId);
        expect(entry.journalMode).toBe('wal');
        expect(entry.synchronous).toBe(2);
      }
      expect(JSON.stringify(result.writerStats.measurements)).not.toContain(
        'sqlite_version()',
      );

      expect(
        result.writerStats.pushes.map((batch: unknown[]) => batch.length),
      ).toEqual([500, 1]);
      expect(result.nsPerCommit).toHaveLength(501);
      const measurements = result.writerStats.measurements;
      expect(
        measurements[
          'database.query: SELECT seq, client_commit_id, created_at_ms, operations FROM _syncular_outbox ORDER BY seq ASC'
        ].rowsReturned,
      ).toBe(1);
      expect(measurements['clientSqlite.run: COMMIT'].calls).toBe(
        measurements['clientSqlite.run: BEGIN'].calls,
      );
      expect(measurements['clientSqlite.run: COMMIT'].calls).toBeGreaterThan(0);
      expect(
        measurements['clientSqlite.run: COMMIT'].calls,
      ).toBeLessThanOrEqual(520);
      expect(
        measurements['clientSqlite.run: COMMIT'].elapsedMs,
      ).toBeGreaterThanOrEqual(0);
      expect(measurements['clientSqlite.run: ROLLBACK']).toBeUndefined();
      expect(result.operationConstructionMs).toBeGreaterThan(0);
      expect(result.operationDrainMs).toBeGreaterThan(0);
      expect(
        result.clientResources.map((entry: { role: string }) => entry.role),
      ).toEqual(['writer', 'reader']);
      expect(result.clientResources[0].pid).not.toBe(
        result.clientResources[1].pid,
      );
      expect(
        result.clientResources.every(
          (entry: { pid: number }) => entry.pid !== process.pid,
        ),
      ).toBe(true);
      expect(result.restartProcess).toBeUndefined();
      expect(result.boundaries).toContain(
        'Each client and server owns a separate process',
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);

test('TS restart requires a real socket and persistent database', () => {
  const base = ['--workload', 'restart', '--core', 'ts', '--lane', 'socket'];
  expect(() => performanceOptions(base)).toThrow('file storage');
  expect(performanceOptions([...base, '--storage', 'file']).workload).toBe(
    'restart',
  );
  expect(() =>
    performanceOptions([...base, '--lane', 'engine', '--storage', 'file']),
  ).toThrow('socket lane');
});

test('mixed workload declares first-commit sizes and rejection explicitly', () => {
  const base = ['--workload', 'commit-boundaries', '--lane', 'socket'];
  expect(performanceOptions(base).sizes).toEqual([499, 500]);
  expect(performanceOptions([...base, '--reject-middle']).rejectMiddle).toBe(
    true,
  );
  for (const extra of [
    ['--sizes', '501'],
    ['--lane', 'engine'],
    ['--pattern', 'repeated'],
  ])
    expect(() => performanceOptions([...base, ...extra])).toThrow();
  expect(() =>
    performanceOptions([
      '--workload',
      'replay',
      '--lane',
      'socket',
      '--reject-middle',
    ]),
  ).toThrow();
});

for (const firstOperations of [499, 500] as const) {
  test.each([false, true])(
    `mixed ${firstOperations}/2/1 commits retain atomic rejection and FIFO prefixes (reject=%s)`,
    async (rejectMiddle) => {
      const result = await runProcessReplay({
        binary: [process.execPath, join(import.meta.dir, 'ts-process.ts')],
        core: 'ts',
        rows: 32,
        commits: 3,
        repeated: false,
        persistent: true,
        backend: 'sqlite',
        boundary: 'direct',
        mixed: { firstOperations, rejectMiddle },
      });
      expect(result.writerStats.pushes).toEqual([
        [[expect.any(String), firstOperations]],
        [
          [expect.any(String), 2],
          [expect.any(String), 1],
        ],
      ]);
      expect(result.operationCounts).toEqual([firstOperations, 2, 1]);
      expect(result.validatedOperations).toBe(firstOperations + 3);
      expect(result.validatedCommits).toBe(3);
      expect(result.appliedCommits).toBe(rejectMiddle ? 2 : 3);
      expect(result.rejectedCommits).toBe(rejectMiddle ? 1 : 0);
      expect(result.validatedRows).toBe(
        firstOperations + (rejectMiddle ? 0 : 1),
      );
      expect(result.serverMetrics.maxCommitSeq).toBe(result.appliedCommits);
      expect(result.rejectedOutcome?.status).toBe(
        rejectMiddle ? 'rejected' : undefined,
      );
    },
    30_000,
  );
}

test.each([false, true])(
  'TS process restart preserves FIFO identities and optimistic rows (repeated=%s)',
  async (repeated) => {
    const result = await runProcessReplay({
      binary: [process.execPath, join(import.meta.dir, 'ts-process.ts')],
      core: 'ts',
      rows: 32,
      commits: 501,
      repeated,
      persistent: true,
      backend: 'sqlite',
      boundary: 'direct',
      restart: true,
    });
    expect(result.restart).toContain('SIGKILL');
    expect(result.clientSqlite).toHaveLength(3);
    for (const entry of result.clientSqlite) {
      const resource = result.clientResources.find(
        (resource) => resource.role === entry.role,
      );
      if (!resource) throw new Error('Client metadata has no resource record');
      expect(entry.pid).toBe(resource.pid);
      expect(entry.clientId).toBe(resource.clientId);
      expect(entry.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(entry.journalMode).toBe('wal');
      expect(entry.synchronous).toBe(2);
    }

    expect(result.validatedCommits).toBe(501);
    expect(result.validatedRows).toBe(repeated ? 32 : 501);
    expect(result.serverMetrics.maxCommitSeq).toBe(501);
    expect(result.restartProcess?.signal).toBe('SIGKILL');
    expect(result.restartProcess?.reopenedPid).not.toBe(
      result.restartProcess?.killedPid,
    );
    expect(result.clientResources.map((entry) => entry.role)).toEqual([
      'writer-before-restart',
      'writer',
      'reader',
    ]);
    expect(result.clientResources[0]?.pid).toBe(
      result.restartProcess?.killedPid,
    );
    expect(result.clientResources[1]?.pid).toBe(
      result.restartProcess?.reopenedPid,
    );
    expect(result.clientResources[0]?.clientId).toBe(
      result.clientResources[1]?.clientId,
    );
    for (const usage of result.clientResources) {
      expect(usage.cpuMs).toBeGreaterThan(0);
      expect(usage.peakRssBytes).toBeGreaterThan(0);
    }
    expect(JSON.parse(JSON.stringify(result)).digest).toBe(result.digest);
  },
  30_000,
);

test.each(['replay', 'reconnect'])(
  'TS %s CLI retains isolated sampling intervals and ordinary SQL attribution',
  async (workload) => {
    const directory = await mkdtemp(join(tmpdir(), 'syncular-ts-sampling-'));
    const output = join(directory, 'profile.json');
    try {
      await runPerformanceBench([
        '--workload',
        workload,
        '--core',
        'ts',
        '--lane',
        'socket',
        '--storage',
        'file',
        '--sizes',
        workload === 'replay' ? '501' : '2',
        '--rows',
        '32',
        '--trials',
        '1',
        '--ts-profile',
        '--output',
        output,
      ]);
      const artifact = await Bun.file(output).json();
      expect(artifact.options.tsProfile).toBe(true);
      const attempt = artifact.attempts[0];
      expect(attempt.status).toBe('completed');
      expect(attempt.validatedCommits).toBe(workload === 'replay' ? 501 : 100);
      const snapshots = [
        attempt.writerStats,
        ...(workload === 'replay'
          ? [attempt.readerObservation.stats]
          : attempt.observations.map(
              (value: { stats: unknown }) => value.stats,
            )),
      ];
      for (const [index, value] of snapshots.entries()) {
        const stats = processObject(value);
        const sampling = processSampling(stats.sampling);
        expect(sampling.bunVersion).toBe(Bun.version);
        expect(sampling.intervalUs).toBe(1000);
        if (workload === 'replay' || index > 0)
          expect(
            processObject(stats.measurements)['clientSqlite.run: COMMIT'],
          ).toBeDefined();
      }
      expect(
        new Set(
          attempt.clientResources.map((value: { pid: number }) => value.pid),
        ).size,
      ).toBe(workload === 'replay' ? 2 : 3);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);
