import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngineDriver } from './engine-driver';
import {
  createBenchServer,
  seedServerRows,
  closeBenchClients,
} from './loopback';
import { assertProcessSync, processObject } from './process-driver';
import { canonicalTaskRows, queuedValues } from './fixture';
import { performanceOptions, runPerformanceBench } from './performance';

const library = process.env.SYNCULAR_ENGINE_BENCH;

test('Rust engine CLI selects replay explicitly and rejects unsupported workloads', () => {
  const args = ['--core', 'rust', '--lane', 'engine', '--workload', 'replay'];
  expect(performanceOptions(args).lane).toBe('engine');
  expect(performanceOptions([...args, '--boundary', 'command']).boundary).toBe(
    'command',
  );
  expect(() => performanceOptions([...args, '--workload', 'read'])).toThrow(
    'socket',
  );
  expect(() =>
    performanceOptions([...args, '--workload', 'restart', '--storage', 'file']),
  ).toThrow('socket');
});

test.skipIf(!library).each(['direct', 'command'])(
  'Rust engine CLI records private library, shared process, FIFO, and %s operation timings',
  async (boundary) => {
    const directory = await mkdtemp(join(tmpdir(), 'syncular-engine-cli-'));
    const output = join(directory, 'result.json');
    try {
      await runPerformanceBench([
        '--workload',
        'replay',
        '--core',
        'rust',
        '--lane',
        'engine',
        '--boundary',
        boundary,
        '--storage',
        'file',
        '--sizes',
        '501',
        '--rows',
        '32',
        '--trials',
        '1',
        '--output',
        output,
      ]);
      const artifact = await Bun.file(output).json();
      expect(artifact.native.engineLibrarySha256).toMatch(/^[a-f0-9]{64}$/);
      expect(artifact.attempts).toHaveLength(1);
      const result = artifact.attempts[0];
      expect(result.status).toBe('completed');
      expect(result.validatedCommits).toBe(501);
      expect(result.appliedCommits).toBe(501);
      expect(result.rejectedCommits).toBe(0);
      expect(result.serverMetrics.maxCommitSeq).toBe(501);
      expect(result.clientResources).toEqual([]);
      expect(
        result.engineClients.map(
          (client: { processId: number }) => client.processId,
        ),
      ).toEqual([process.pid, process.pid]);
      expect(result.engineClients[0].threadId).not.toBe(
        result.engineClients[1].threadId,
      );
      expect(result.engineClients[0].delivery.hostCalls).toBeGreaterThan(0);
      expect(result.boundaries).toContain('shared process');
      expect(result.operationDrainMs).toBeGreaterThan(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);

test.skipIf(!library)(
  'Rust engine shares the host process and delivers 501 durable commits to an independent reader',
  async () => {
    if (!library) throw new Error('Engine benchmark library missing');
    const directory = await mkdtemp(join(tmpdir(), 'syncular-engine-test-'));
    const server = createBenchServer();
    const clients: Awaited<ReturnType<typeof createEngineDriver>>[] = [];
    try {
      await seedServerRows(server, 32);
      const writer = await createEngineDriver(
        library,
        server,
        join(directory, 'writer.sqlite'),
      );
      clients.push(writer);
      const reader = await createEngineDriver(
        library,
        server,
        join(directory, 'reader.sqlite'),
      );
      clients.push(reader);
      expect(writer.info.processId).toBe(process.pid);
      expect(reader.info.processId).toBe(process.pid);
      expect(reader.info.threadId).not.toBe(writer.info.threadId);
      for (const client of clients) {
        assertProcessSync(await client.invoke('syncUntilIdle'));
        await client.invoke('connectRealtime');
        assertProcessSync(await client.invoke('syncUntilIdle'));
      }
      const commits = Array.from({ length: 501 }, (_, index) => ({
        mutations: [
          { op: 'upsert', table: 'tasks', values: queuedValues(index, false) },
        ],
      }));
      const constructed = processObject(
        await writer.invoke('benchMutate', { commits, mode: 'direct' }),
      );
      expect(constructed.ids).toHaveLength(501);
      const observed = reader.invoke('waitForAck', { cursor: 501 });
      // Attach immediately so a failed writer cannot produce an unhandled reader rejection.
      void observed.catch(() => {});
      const synced = processObject(
        await writer.invoke('benchSync', { mode: 'direct' }),
      );
      assertProcessSync(synced.outcome, 501);
      const stats = processObject(synced.stats);
      expect(stats.pushes).toBeArray();
      const pushes = stats.pushes as unknown[];
      expect(
        pushes
          .map((batch) => {
            if (!Array.isArray(batch)) throw new Error('Invalid push batch');
            return batch.length;
          })
          .filter(Boolean),
      ).toEqual([500, 1]);
      expect(processObject(await observed).cursor).toBe(501);
      const sql =
        'SELECT id, project_id, title, done, priority, updated_at_ms FROM tasks ORDER BY id';
      const expected = Array.from({ length: 501 }, (_, index) => ({
        ...queuedValues(index, false),
        done: 0,
      })).sort((a, b) => a.id.localeCompare(b.id));
      for (const client of clients) {
        expect(
          canonicalTaskRows(
            processObject(await client.invoke('query', { sql })).rows,
          ),
        ).toEqual(expected);
        const config = processObject(
          await client.invoke('query', {
            sql: 'SELECT (SELECT journal_mode FROM pragma_journal_mode) AS journalMode, (SELECT synchronous FROM pragma_synchronous) AS synchronous',
          }),
        ).rows;
        expect(config).toEqual([{ journalMode: 'wal', synchronous: 2 }]);
      }
      expect(writer.deliveryStats().hostCalls).toBeGreaterThan(0);
      await writer.close();
      const reopened = await createEngineDriver(
        library,
        server,
        join(directory, 'writer.sqlite'),
        writer.clientId,
      );
      clients.push(reopened);
      expect(
        canonicalTaskRows(
          processObject(await reopened.invoke('query', { sql })).rows,
        ),
      ).toEqual(expected);
    } finally {
      await closeBenchClients(clients);
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);

test.skipIf(!library)(
  'Rust engine closes an active readiness wait without unloading an active native call',
  async () => {
    if (!library) throw new Error('Engine benchmark library missing');
    const server = createBenchServer();
    const client = await createEngineDriver(library, server);
    try {
      assertProcessSync(await client.invoke('syncUntilIdle'));
      await client.invoke('connectRealtime');
      assertProcessSync(await client.invoke('syncUntilIdle'));
      const pending = client.invoke('waitForAck', { cursor: 1 });
      const rejected = pending.then(
        () => {
          throw new Error('Readiness unexpectedly completed');
        },
        (error: unknown) => error,
      );
      await client.hostReadiness;
      await client.close();
      expect(await rejected).toBeInstanceOf(Error);
      await client.close();
      expect(
        await client
          .invoke('query', { sql: 'SELECT 1' })
          .catch((error: unknown) => error),
      ).toBeInstanceOf(Error);
    } finally {
      await client.close();
      await server.close();
    }
  },
);

test.skipIf(!library)(
  'Rust engine rejects transport replacement and propagates server errors',
  async () => {
    if (!library) throw new Error('Engine benchmark library missing');
    const server = createBenchServer();
    server.storage.ensureSchema = async () => {
      throw new Error('engine test storage failure');
    };
    const client = await createEngineDriver(library, server);
    try {
      expect(
        await client
          .invoke('create', { transport: {} })
          .catch((error: unknown) => error),
      ).toMatchObject({
        message: expect.stringContaining('Engine transport cannot change'),
      });
      const result = processObject(await client.invoke('syncUntilIdle'));
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).toContain('engine test storage failure');
    } finally {
      await client.close();
      await server.close();
    }
  },
);
