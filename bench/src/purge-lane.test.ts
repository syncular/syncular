import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { runProcessPurge } from './purge-lane';
import { performanceOptions } from './performance';
import { startSocketServer } from './socket-server';

test('purge selection declares revoked row counts and requires persistent socket clients', () => {
  const args = ['--workload', 'purge', '--lane', 'socket', '--storage', 'file'];
  expect(performanceOptions(args).sizes).toEqual([2000, 10000, 100000]);
  expect(
    performanceOptions([...args, '--core', 'rust', '--boundary', 'command'])
      .boundary,
  ).toBe('command');
  for (const extra of [
    ['--lane', 'engine'],
    ['--storage', 'memory'],
    ['--core', 'rust', '--boundary', 'ffi'],
    ['--sizes', '100001'],
    ['--pattern', 'repeated'],
  ])
    expect(() => performanceOptions([...args, ...extra])).toThrow();
});

test('ordinary socket fixtures cannot revoke grants through the private control endpoint', async () => {
  const server = await startSocketServer(1, 'sqlite');
  try {
    const response = await fetch(
      new URL('/__bench/revoke-project', server.endpoints.syncUrl),
      { method: 'POST' },
    );
    expect(response.status).toBe(404);
    await expect(server.revokeProject()).rejects.toThrow(
      'Revocation fixture required',
    );
  } finally {
    await server.close();
  }
});

const nativeBinary = process.env.SYNCULAR_NATIVE_BENCH;
for (const profile of [
  {
    core: 'ts' as const,
    boundary: 'direct' as const,
    binary: [process.execPath, join(import.meta.dir, 'ts-process.ts')],
  },
  { core: 'rust' as const, boundary: 'direct' as const, binary: nativeBinary },
  { core: 'rust' as const, boundary: 'command' as const, binary: nativeBinary },
]) {
  test.skipIf(!profile.binary)(
    `permission purge retains the other grant and survives process reopen (${profile.core}/${profile.boundary})`,
    async () => {
      if (!profile.binary) throw new Error('Native benchmark binary required');
      const result = await runProcessPurge({
        ...profile,
        binary: profile.binary,
        rows: 501,
        backend: 'sqlite',
      });
      expect(result.validatedPurgedRows).toBe(501);
      expect(result.validatedRetainedRows).toBe(1);
      expect(result.validatedReopen).toBe(true);
      expect(result.clientSqlite).toHaveLength(2);
      for (const entry of result.clientSqlite) {
        const resource = result.clientResources.find(
          (resource) => resource.role === entry.role,
        );
        if (!resource)
          throw new Error('Client metadata has no resource record');
        expect(entry.pid).toBe(resource.pid);
        expect(entry.clientId).toBe(resource.clientId);
        expect(entry.version).toMatch(/^\d+\.\d+\.\d+$/);
        expect(entry.journalMode).toBe('wal');
        expect(entry.synchronous).toBe(2);
      }

      expect(result.sqlite.journalMode).toBe('wal');
      expect(result.sqlite.synchronous).toBe(2);
      expect(result.revokedState.status).toBe('revoked');
      expect(result.revokedState.reasonCode).toBe('sync.scope_revoked');
      expect(result.retainedState.status).toBe('active');
      expect(result.serverMetrics.maxCommitSeq).toBe(1);
      expect(result.operationPurgeMs).toBeGreaterThan(0);
      expect(result.purgeMs).toBeGreaterThan(0);
      expect(result.clientResources).toHaveLength(2);
      expect(result.clientResources[0]?.pid).not.toBe(
        result.clientResources[1]?.pid,
      );
      expect(result.clientResources[0]?.clientId).toBe(
        result.clientResources[1]?.clientId,
      );
      for (const resource of result.clientResources)
        expect(resource.peakRssBytes).toBeGreaterThan(0);
    },
    30_000,
  );
}
