import { expect, test } from 'bun:test';
import {
  createPgServer,
  openPgIoObserver,
  validatePgIoSnapshots,
} from './pg-lane';
import { seedServerRows } from './loopback';
import { processObject } from './process-driver';
import { createPerformanceServer } from './socket-server';

test('I/O intervals reject counter resets and missing views', () => {
  const before = Object.fromEntries(
    ['io', 'wal', 'checkpointer'].map((view) => [
      view,
      [{ stats_reset: '2026-09-08T00:00:00Z' }],
    ]),
  );
  validatePgIoSnapshots(before, structuredClone(before));
  for (const view of ['io', 'wal', 'checkpointer']) {
    for (const invalid of [
      undefined,
      [],
      [{}],
      [{ stats_reset: '2026-09-08T01:00:00Z' }],
    ])
      expect(() =>
        validatePgIoSnapshots(before, { ...before, [view]: invalid }),
      ).toThrow('statistics');
  }
});

const url = process.env.SYNCULAR_PG_IO_TEST_URL;
test.skipIf(!url)(
  'Postgres I/O records durable writes after owned server connections close',
  async () => {
    if (!url) throw new Error('Isolated Postgres I/O test URL required');
    const observer = await openPgIoObserver(url);
    try {
      const server = await createPgServer(url);
      try {
        expect(server.database.backend).toBe('postgres');
        expect(server.database.settings.version).toMatch(/^\d+/);
        expect(server.database.settings.versionNumber).toMatch(/^\d+$/);
        expect(server.database.settings.fsync).toBe('on');
        expect(server.database.settings.synchronousCommit).toBe('on');
        expect(Object.keys(server.database.settings).sort()).toEqual([
          'fsync',
          'fullPageWrites',
          'synchronousCommit',
          'version',
          'versionNumber',
          'walSyncMethod',
        ]);

        await seedServerRows(server, 100);
      } finally {
        await server.close();
      }
      const result = await observer.collect();
      expect(result.settings.fsync).toBe('on');
      expect(result.settings.synchronous_commit).toBe('on');
      expect(result.settings.track_wal_io_timing).toBe('on');
      const samples = [result.before, result.after].map((snapshot) => {
        if (!Array.isArray(snapshot.io)) throw new Error('Missing I/O rows');
        const row = snapshot.io
          .map(processObject)
          .find(
            (row) =>
              row.backend_type === 'client backend' && row.context === 'normal',
          );
        return Number(row?.fsyncs);
      });
      expect(samples[1]).toBeGreaterThan(samples[0]!);
      expect(result.boundaries).toContain('complete attempt');
    } finally {
      await observer.close();
    }
  },
  30_000,
);

test.skipIf(!url).each(['engine', 'socket'] as const)(
  'Postgres server metadata survives metric resets (%s)',
  async (lane) => {
    const server = await createPerformanceServer(1, lane, 'postgres');
    try {
      const before = await server.metrics(true);
      const after = await server.metrics();
      expect(after.database).toEqual(before.database);
      expect(after.database.backend).toBe('postgres');
      if (after.database.backend !== 'postgres')
        throw new Error('Postgres metadata missing');
      expect(after.database.settings.version).toMatch(/^\d+/);
      expect(after.database.settings.fsync).toBe('on');
      expect(after.database.settings.synchronousCommit).toBe('on');
      expect(JSON.stringify(after.database)).not.toContain('postgres://');
      expect(JSON.stringify(after.measurements)).not.toContain(
        'current_setting',
      );
    } finally {
      await server.close();
    }
  },
  30_000,
);
