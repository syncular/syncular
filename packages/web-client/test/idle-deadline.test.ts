/**
 * SPEC §7.8: one `syncUntilIdle` drive is bounded by a total deadline, and
 * §1.8: a refused or unreachable endpoint stops without another backoff.
 */
import { expect, test } from 'bun:test';
import {
  httpSyncTransport,
  installSyncScheduler,
  type RealtimeHandlers,
} from '@syncular/client';
import { BunClientDatabase } from '@syncular/client/bun';
import {
  handleSegmentDownload,
  handleSyncRequest,
  type SqliteValue,
} from '@syncular/server';
import {
  makeClient,
  makeServer,
  responseGate,
  tableRows,
  taskValues,
  waitFor,
} from './helpers';

test('a transport that never answers rejects with sync.idle_timeout', async () => {
  const local = await makeClient(makeServer(), { clientId: 'idle-deadline' });
  const gate = responseGate();
  local.faults.holdResponseOnce = gate.fault;
  let markComplete!: () => void;
  const completed = new Promise<void>((resolve) => {
    markComplete = resolve;
  });
  const off = local.client.onProgress((progress) => {
    if (progress.state === 'complete') markComplete();
  });

  const drive = local.client.syncUntilIdle({ timeoutMs: 20 });
  await gate.held;
  await expect(drive).rejects.toMatchObject({
    code: 'sync.idle_timeout',
    retryable: true,
    details: { timeoutMs: 20, rounds: 0, elapsedMs: expect.any(Number) },
  });

  // The round was parked, not lost: releasing it lets the drive settle.
  gate.release();
  await completed;
  off();
  await local.client.close();
  local.db.close();
});

test('a deadline that elapses across completed rounds ends the drive as an exhausted budget', async () => {
  const server = makeServer();
  const seeder = await makeClient(server, { clientId: 'idle-seeder' });
  seeder.client.mutate(
    Array.from({ length: 12 }, (_, i) => ({
      table: 'tasks',
      op: 'upsert' as const,
      values: taskValues(`t${i}`, 'p1', `task ${i}`),
    })),
  );
  await seeder.client.sync();
  let rounds = 0;
  const local = await makeClient(server, {
    clientId: 'idle-progress',
    // One row per round: a unit that bootstraps page by page.
    limits: { limitSnapshotRows: 1, maxSnapshotPages: 1, accept: 0b0011 },
    // Every round takes 40 % of the deadline on the client clock.
    transport: async (bytes) => {
      rounds += 1;
      server.now.ms += 24_000;
      return handleSyncRequest(bytes, server.ctxFor('actor-1'));
    },
  });
  local.client.subscribe({ project_id: 'p1' });
  const failed: unknown[] = [];
  const off = local.client.onProgress((progress) => {
    if (progress.state === 'failed') failed.push(progress);
  });

  const drive = await local.client.syncUntilIdle({ timeoutMs: 60_000 });
  // Rounds end at 24 s, 48 s and 72 s; the check before a fourth round ends
  // the drive.
  expect(rounds).toBe(3);
  expect(drive.budgetExhausted).toBe(true);
  expect(drive.segmentRowsApplied).toBe(3);
  expect(drive.bootstrapping).toHaveLength(1);
  expect(local.client.diagnosticsSnapshot().lastRound?.status).toBe(
    'succeeded',
  );
  expect(failed).toEqual([]);

  // The scheduler queues the next drive; it resumes the bootstrap.
  const queued: Array<() => void> = [];
  let requeued = Promise.withResolvers<void>();
  const scheduler = installSyncScheduler(local.client, {
    schedule: (callback) => {
      queued.push(callback);
      requeued.resolve();
      return () => {};
    },
  });
  await requeued.promise;
  requeued = Promise.withResolvers<void>();
  queued.shift()?.();
  await requeued.promise;
  expect(rounds).toBe(6);
  expect(tableRows(local.db, 'tasks')).toHaveLength(6);
  expect(failed).toEqual([]);
  scheduler.stop();
  off();
  await local.client.close();
  local.db.close();
});

test('a round that keeps applying rows is not cut: each applied chunk restarts its bound', async () => {
  const server = makeServer();
  server.limits.maxImageSegmentBytes = 200_000;
  const seeder = await makeClient(server, { clientId: 'idle-apply-seeder' });
  for (let at = 0; at < 3000; at += 500) {
    seeder.client.mutate(
      Array.from({ length: 500 }, (_, i) => {
        const id = `t${String(at + i).padStart(4, '0')}`;
        return {
          table: 'tasks',
          op: 'upsert' as const,
          values: taskValues(id, 'p1', id.repeat(10)),
        };
      }),
    );
    await seeder.client.sync();
  }
  // A manual clock: every import statement takes 60 % of the bound.
  let now = 0;
  const timers = new Set<{ readonly due: number; readonly fire: () => void }>();
  const advance = (ms: number) => {
    now += ms;
    for (const timer of [...timers])
      if (timer.due <= now) {
        timers.delete(timer);
        timer.fire();
      }
  };
  class SlowImport extends BunClientDatabase {
    override exec(sql: string, params?: readonly SqliteValue[]): void {
      if (sql.startsWith('INSERT INTO "tasks"')) advance(600);
      super.exec(sql, params);
    }
  }
  const local = await makeClient(server, {
    clientId: 'idle-apply',
    database: new SlowImport(),
    realtimePolicy: 'off',
    limits: { limitSnapshotRows: 100, maxSnapshotPages: 3, accept: 0b0111 },
    schedule: (fire, delayMs) => {
      const timer = { due: now + delayMs, fire };
      timers.add(timer);
      return () => timers.delete(timer);
    },
  });
  local.client.subscribe({ project_id: 'p1' });

  const drive = await local.client.syncUntilIdle({ timeoutMs: 1000 });
  // The import ran for more than 1.8 times the bound.
  expect(now).toBeGreaterThan(1800);
  expect(drive.segmentRowsApplied).toBe(3000);
  expect(tableRows(local.db, 'tasks')).toHaveLength(3000);
  expect(timers.size).toBe(0);
  await local.client.close();
  local.db.close();
});

/**
 * §7.8: a round whose 300-row image arrives in four chunks, each 600 ms
 * after the last on the client clock, under a 1,000 ms bound. With `stall`
 * the download goes silent after its first chunk.
 */
async function streamedSegmentRound(stall: boolean) {
  const server = makeServer();
  const seeder = await makeClient(server, { clientId: 'stream-seeder' });
  seeder.client.mutate(
    Array.from({ length: 300 }, (_, i) => ({
      table: 'tasks',
      op: 'upsert' as const,
      values: taskValues(`t${String(i).padStart(3, '0')}`, 'p1', 'row'),
    })),
  );
  await seeder.client.sync();
  let now = 0;
  const timers = new Set<{ readonly due: number; readonly fire: () => void }>();
  const advance = (ms: number) => {
    now += ms;
    for (const timer of [...timers])
      if (timer.due <= now) {
        timers.delete(timer);
        timer.fire();
      }
  };
  const local = await makeClient(server, {
    clientId: 'stream-download',
    realtimePolicy: 'off',
    limits: { limitSnapshotRows: 100, accept: 0b0111 },
    schedule: (fire, delayMs) => {
      const timer = { due: now + delayMs, fire };
      timers.add(timer);
      return () => timers.delete(timer);
    },
    segments: async (request) => {
      const { bytes } = await handleSegmentDownload(server.ctxFor('actor-1'), {
        segmentId: request.segmentId,
        scopesHeader: request.requestedScopesJson,
      });
      for (let chunk = 1; chunk <= 4; chunk++) {
        advance(600);
        request.onProgress?.(Math.floor((bytes.length * chunk) / 4));
        if (stall) {
          advance(1000);
          return new Promise<Uint8Array>((_, reject) =>
            request.signal?.addEventListener('abort', () =>
              reject(request.signal?.reason),
            ),
          );
        }
      }
      return bytes;
    },
  });
  local.client.subscribe({ project_id: 'p1' });
  return { local, drive: local.client.syncUntilIdle({ timeoutMs: 1000 }) };
}

test('received segment bytes restart the round bound', async () => {
  const { local, drive } = await streamedSegmentRound(false);
  await expect(drive).resolves.toMatchObject({ segmentRowsApplied: 300 });
  expect(tableRows(local.db, 'tasks')).toHaveLength(300);
  await local.client.close();
  local.db.close();
});

test('a segment download silent for the bound fails with sync.idle_timeout', async () => {
  const { local, drive } = await streamedSegmentRound(true);
  await expect(drive).rejects.toMatchObject({
    code: 'sync.idle_timeout',
    details: { timeoutMs: 1000, rounds: 0 },
  });
  await local.client.close();
  local.db.close();
});

test('the deadline aborts a silent fetch, and the client syncs again', async () => {
  const server = makeServer();
  const aborted: unknown[] = [];
  let silent = true;
  const fetchStub = async (
    _url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const signal = init?.signal;
    if (silent) {
      silent = false;
      // A silent transport: no answer, no error, until the signal aborts.
      return new Promise<Response>((_, reject) => {
        signal?.addEventListener('abort', () => {
          aborted.push(signal.reason);
          reject(signal.reason);
        });
      });
    }
    const body = new Uint8Array(init?.body as ArrayBuffer);
    const bytes = await handleSyncRequest(body, server.ctxFor('actor-1'));
    return new Response(bytes.slice().buffer as ArrayBuffer, { status: 200 });
  };
  const local = await makeClient(server, {
    clientId: 'idle-abort',
    realtimePolicy: 'off',
    transport: httpSyncTransport('https://sync.test/sync', {
      fetch: Object.assign(fetchStub, { preconnect: fetch.preconnect }),
    }),
  });
  local.client.mutate([
    { table: 'tasks', op: 'upsert', values: taskValues('t1', 'p1', 'held') },
  ]);

  await expect(
    local.client.syncUntilIdle({ timeoutMs: 20 }),
  ).rejects.toMatchObject({ code: 'sync.idle_timeout', retryable: true });
  expect(aborted).toHaveLength(1);
  expect(aborted[0]).toMatchObject({ code: 'sync.idle_timeout' });
  // The aborted round ends with the deadline's error and releases the loop.
  await waitFor(
    () => {
      const round = local.client.diagnosticsSnapshot().lastRound;
      return (
        round?.status === 'failed' && round.errorCode === 'sync.idle_timeout'
      );
    },
    (notify) => local.client.onDiagnostics(notify),
    'the aborted round settles',
  );
  expect(local.intents.at(-1)).toEqual({ kind: 'background', delayMs: 250 });

  const summary = await local.client.sync();
  expect(summary.pushed).toBe(1);
  expect(local.client.pendingCommits()).toHaveLength(0);
  await local.client.close();
  local.db.close();
});

test('a refused connection stops without scheduling a retry', async () => {
  const local = await makeClient(makeServer(), { clientId: 'idle-refused' });
  const before = local.intents.length;
  local.faults.refuseConnectionOnce = true;

  await expect(
    local.client.syncUntilIdle({ timeoutMs: 5_000 }),
  ).rejects.toMatchObject({ code: 'sync.transport_failed' });
  expect(local.intents.length).toBe(before);
  expect(local.httpRounds.count).toBe(1);

  // Control: a retryable failure the transport does not classify as an
  // unreachable endpoint still schedules the background intent.
  local.faults.dropResponseOnce = true;
  await expect(
    local.client.syncUntilIdle({ timeoutMs: 5_000 }),
  ).rejects.toMatchObject({ code: 'sync.transport_failed' });
  expect(local.intents.at(-1)).toEqual({ kind: 'background', delayMs: 250 });

  await local.client.close();
  local.db.close();
});

test('the deadline must be positive, and the numeric overload still works', async () => {
  const local = await makeClient(makeServer(), { clientId: 'idle-options' });
  for (const timeoutMs of [0, -1, Number.NaN]) {
    await expect(
      local.client.syncUntilIdle({ timeoutMs }),
    ).rejects.toMatchObject({ code: 'sync.invalid_request' });
  }
  const numeric = await local.client.syncUntilIdle(1);
  expect(numeric.budgetExhausted).toBe(false);
  const options = await local.client.syncUntilIdle({ maxRounds: 1 });
  expect(options.budgetExhausted).toBe(false);
  await local.client.close();
  local.db.close();
});

/**
 * §7.8, §1.6: every received chunk of a socket round restarts its bound, a
 * KEEPALIVE frame included. The client's timers and clock are the test's.
 */
async function keepaliveRound() {
  const server = makeServer();
  const clock = { ms: 0 };
  const timers: { run: () => void; atMs: number; cancelled: boolean }[] = [];
  const advance = (ms: number) => {
    clock.ms += ms;
    for (const timer of timers) {
      if (timer.cancelled || timer.atMs > clock.ms) continue;
      timer.cancelled = true;
      timer.run();
    }
  };
  let handlers!: RealtimeHandlers;
  let sent!: (bytes: Uint8Array) => void;
  const request = new Promise<Uint8Array>((resolve) => {
    sent = resolve;
  });
  const local = await makeClient(server, {
    clientId: 'keepalive-round',
    realtimePolicy: 'required',
    now: () => clock.ms,
    schedule: (run, delayMs) => {
      const timer = { run, atMs: clock.ms + delayMs, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    realtime: async (connected) => {
      handlers = connected;
      return {
        send: () => undefined,
        sendBytes: (bytes) => sent(bytes),
        close: () => connected.onClose?.(),
      };
    },
  });
  local.client.subscribe({ project_id: 'p1' });
  await local.client.connectRealtime();
  const drive = local.client.syncUntilIdle({ timeoutMs: 1_000, maxRounds: 1 });
  const response = await handleSyncRequest(
    (await request).subarray(1),
    server.ctxFor('actor-1'),
  );
  // The envelope header and RESP_HEADER, as a building server writes them.
  const headerEnd =
    13 + new DataView(response.buffer, response.byteOffset).getUint32(9, true);
  const chunk = (bytes: Uint8Array) =>
    handlers.onBinary(new Uint8Array([1, ...bytes]));
  chunk(response.subarray(0, headerEnd));
  return { local, drive, advance, chunk, rest: response.subarray(headerEnd) };
}

test('a KEEPALIVE chunk restarts the round bound of a socket round', async () => {
  const { local, drive, advance, chunk, rest } = await keepaliveRound();
  advance(900);
  chunk(new Uint8Array([0x30, 0, 0, 0, 0]));
  advance(900);
  chunk(rest);
  await expect(drive).resolves.toMatchObject({ budgetExhausted: false });
  await local.client.close();
  local.db.close();
});

test('a socket round that receives nothing for the bound fails with its duration', async () => {
  const { local, drive, advance } = await keepaliveRound();
  advance(1_000);
  await expect(drive).rejects.toMatchObject({
    code: 'sync.idle_timeout',
    details: { timeoutMs: 1_000, rounds: 0, elapsedMs: 1_000 },
  });
  await local.client.close();
  local.db.close();
});
