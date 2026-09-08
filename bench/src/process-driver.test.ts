import { expect, test } from 'bun:test';
import {
  assertProcessSync,
  processObject,
  processMessages,
  processResources,
  processPhases,
  processSampling,
  createProcessDriver,
} from './process-driver';
import { canonicalTaskRows } from './fixture';
import { performanceOptions } from './performance';
import { startSocketServer } from './socket-server';
import { join } from 'node:path';

test('native phase artifacts reject malformed names, metadata and counters', () => {
  const measurements = {
    pendingReplay: { calls: 1, units: 3, elapsedNs: 100, threadCpuNs: 50 },
  };
  expect(
    processPhases({ version: 1, scope: 'inclusive', measurements })
      .measurements,
  ).toEqual(measurements);
  for (const bad of [
    null,
    {},
    { version: 2, scope: 'inclusive', measurements },
    { version: 1, scope: '', measurements },
    {
      version: 1,
      scope: 'inclusive',
      measurements: { secretRowId: measurements.pendingReplay },
    },
    ...[Number.NaN, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, '100'].map(
      (elapsedNs) => ({
        version: 1,
        scope: 'inclusive',
        measurements: {
          pendingReplay: { ...measurements.pendingReplay, elapsedNs },
        },
      }),
    ),
  ])
    expect(() => processPhases(bad)).toThrow();
});

test('process resource counters preserve units and reject missing or unsafe data', () => {
  for (const cpuTime of [
    { user: 1234, system: 2000, total: 3234 },
    { user: 1234n, system: 2000n, total: 3234n },
  ]) {
    expect(processResources({ cpuTime, maxRSS: 16_777_216 })).toEqual({
      userCpuMs: 1.234,
      systemCpuMs: 2,
      cpuMs: 3.234,
      peakRssBytes: 16_777_216,
    });
  }
  for (const value of [
    undefined,
    {},
    { cpuTime: { user: 1, system: 1, total: 1 }, maxRSS: 1024 },
    { cpuTime: { user: 0, system: 0, total: 0 }, maxRSS: 0 },
    { cpuTime: { user: -1, system: 1, total: 0 }, maxRSS: 1024 },
    { cpuTime: { user: 0.1, system: 0, total: 0.1 }, maxRSS: 1024 },
    { cpuTime: { user: '1', system: 0, total: 1 }, maxRSS: 1024 },
    {
      cpuTime: { user: 1n << 54n, system: 0n, total: 1n << 54n },
      maxRSS: 1024,
    },
  ])
    expect(() => processResources(value)).toThrow();
});

test('exited child resource counters agree with its own CPU and peak RSS units', async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      `
    const bytes = new Uint8Array(8 * 1024 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
    console.log(JSON.stringify({ cpu: process.cpuUsage(), peakKiB: process.resourceUsage().maxRSS, last: bytes.at(-1) }));
  `,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const own = processObject(
    JSON.parse(await new Response(child.stdout).text()),
  );
  expect(await child.exited).toBe(0);
  const usage = processResources(child.resourceUsage());
  const ownCpu = processObject(own.cpu);
  if (
    typeof ownCpu.user !== 'number' ||
    typeof ownCpu.system !== 'number' ||
    typeof own.peakKiB !== 'number'
  )
    throw new Error('Child did not report its own counters');
  expect(usage.userCpuMs).toBeGreaterThanOrEqual(ownCpu.user / 1000);
  expect(usage.systemCpuMs).toBeGreaterThanOrEqual(ownCpu.system / 1000);
  expect(usage.peakRssBytes).toBeGreaterThanOrEqual(own.peakKiB * 1024);
  // Exit bookkeeping can raise the high-water mark after the child reports it.
  // A byte/KiB unit mistake would differ by 1024x.
  expect(usage.peakRssBytes).toBeLessThan(own.peakKiB * 1024 * 2);
  expect(own.last).toBe((8 * 1024 * 1024 - 1) % 251);
});

test('native workload selection rejects unavailable boundaries and ephemeral restart', () => {
  const base = ['--workload', 'restart', '--core', 'rust', '--lane', 'socket'];
  expect(() => performanceOptions(base)).toThrow('file storage');
  expect(performanceOptions([...base, '--storage', 'file']).workload).toBe(
    'restart',
  );
  expect(() =>
    performanceOptions([
      '--workload',
      'fanout',
      '--core',
      'rust',
      '--lane',
      'engine',
    ]),
  ).toThrow('socket lane');
  expect(() =>
    performanceOptions([
      '--workload',
      'replay',
      '--lane',
      'socket',
      '--boundary',
      'command',
    ]),
  ).toThrow('requires Rust');
});

test('native convergence validation rejects partial outcomes and unresolved work', () => {
  const report = {
    applied: ['a', 'b'],
    rejected: [],
    retryable: [],
    failed: [],
    bootstrapping: [],
    conflicts: 0,
    deferredCommits: 0,
  };
  expect(assertProcessSync({ ok: true, report }, 2)).toEqual(report);
  const rejected = { ...report, rejected: ['middle'] };
  expect(
    assertProcessSync({ ok: true, report: rejected }, 2, ['middle']),
  ).toEqual(rejected);
  expect(() =>
    assertProcessSync({ ok: true, report: rejected }, 2, ['other']),
  ).toThrow();
  expect(() =>
    assertProcessSync({ ok: true, report }, 2, ['middle']),
  ).toThrow();
  for (const key of ['rejected', 'retryable', 'failed', 'bootstrapping']) {
    expect(() =>
      assertProcessSync(
        { ok: true, report: { ...report, [key]: ['pending'] } },
        2,
      ),
    ).toThrow();
  }
  for (const key of ['conflicts', 'deferredCommits']) {
    expect(() =>
      assertProcessSync({ ok: true, report: { ...report, [key]: 1 } }, 2),
    ).toThrow();
  }
  expect(() => assertProcessSync({ ok: true, report }, 3)).toThrow();
  expect(() => assertProcessSync({ ok: false, report }, 2)).toThrow();
  for (const value of [null, [], 'result'])
    expect(() => processObject(value)).toThrow();
});

test('cross-core final rows normalize SQLite booleans without hiding data differences', () => {
  const row = {
    id: 'a',
    project_id: 'p',
    title: 'task',
    done: false,
    priority: 2,
    updated_at_ms: 123,
  };
  expect(canonicalTaskRows([row])).toEqual(
    canonicalTaskRows([{ ...row, done: 0 }]),
  );
  expect(canonicalTaskRows([row])).not.toEqual(
    canonicalTaskRows([{ ...row, done: true }]),
  );
  expect(() => canonicalTaskRows([{ ...row, done: 2 }])).toThrow();
  expect(() => canonicalTaskRows([{ ...row, id: null }])).toThrow();
});

test.each([1, 3, 17, 4096])(
  'stdio messages preserve fragmented UTF-8 and multiple responses (chunk=%s)',
  async (chunkSize) => {
    const expected = [
      { id: 1, result: 'A😀雪\nnext' },
      { id: 2, error: { code: 'test.failed', message: 'é' } },
    ];
    const document = expected
      .map((value) => JSON.stringify(value) + '\n')
      .join('');
    const bytes = new TextEncoder().encode(document);
    const stats = {
      responseBytes: 0,
      responseParseMs: 0,
      responseFramingMs: 0,
      responseChunks: 0,
      responseScanChars: 0,
    };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < bytes.length; offset += chunkSize)
          controller.enqueue(bytes.subarray(offset, offset + chunkSize));
        controller.close();
      },
    });
    const messages = [];
    for await (const message of processMessages(stream, stats))
      messages.push(message);
    expect(messages).toEqual(expected);
    expect(stats.responseBytes).toBe(bytes.length);
    expect(stats.responseChunks).toBe(Math.ceil(bytes.length / chunkSize));
  },
);

test('large stdio responses search each decoded character at most once', async () => {
  const document =
    JSON.stringify({ id: 1, result: 'a'.repeat(1024 * 1024) }) + '\n';
  const bytes = new TextEncoder().encode(document);
  const stats = {
    responseBytes: 0,
    responseParseMs: 0,
    responseFramingMs: 0,
    responseChunks: 0,
    responseScanChars: 0,
  };
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.subarray(offset, offset + 1024));
      offset = Math.min(offset + 1024, bytes.length);
    },
  });
  const messages = [];
  for await (const message of processMessages(stream, stats))
    messages.push(message);
  expect(messages).toEqual([{ id: 1, result: 'a'.repeat(1024 * 1024) }]);
  expect(stats.responseScanChars).toBeLessThanOrEqual(document.length);
});

test.each([
  new TextEncoder().encode('{"id":1'),
  Uint8Array.from([0xf0, 0x9f]),
  Uint8Array.from([0xff, 0x0a]),
  new TextEncoder().encode('[]\n'),
])('stdio framing rejects incomplete or malformed responses', async (bytes) => {
  const stats = {
    responseBytes: 0,
    responseParseMs: 0,
    responseFramingMs: 0,
    responseChunks: 0,
    responseScanChars: 0,
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  await expect(
    (async () => {
      for await (const _message of processMessages(stream, stats)) {
        // Consume through the expected parse or incomplete-stream failure.
      }
    })(),
  ).rejects.toThrow();
  expect(stream.locked).toBe(false);
});

test('TS sampling preserves compressed raw stacks and rejects malformed envelopes', () => {
  const raw = {
    functions: 'sampled functions',
    bytecodes: 'sampled bytecodes',
    stackTraces: {
      interval: 0.001,
      sources: [],
      traces: [
        {
          timestamp: 1,
          frames: [
            {
              name: 'applyCommitFrame',
              category: 'Baseline',
              sourceURL: 'apply.ts',
            },
          ],
        },
      ],
    },
  };
  const envelope = {
    version: 1,
    format: 'bun-jsc-sampling',
    encoding: 'gzip-base64',
    bunVersion: Bun.version,
    intervalUs: 1000,
    samples: 1,
    elapsedMs: 2,
    data: Buffer.from(Bun.gzipSync(JSON.stringify(raw))).toString('base64'),
  };
  expect(processSampling(envelope)).toEqual(envelope);
  expect(
    JSON.parse(
      new TextDecoder().decode(
        Bun.gunzipSync(Buffer.from(processSampling(envelope).data, 'base64')),
      ),
    ),
  ).toEqual(raw);
  for (const value of [
    null,
    {},
    { ...envelope, version: 2 },
    { ...envelope, samples: 2 },
    { ...envelope, samples: -1 },
    { ...envelope, elapsedMs: Number.NaN },
    { ...envelope, intervalUs: 0 },
    { ...envelope, data: 'invalid' },
    { ...envelope, data: Buffer.from(Bun.gzipSync('{}')).toString('base64') },
  ])
    expect(() => processSampling(value)).toThrow();
});

test('TS sampling has explicit intervals and closes an active profiler with its client', async () => {
  const server = await startSocketServer(1, 'sqlite');
  const clients: Array<Awaited<ReturnType<typeof createProcessDriver>>> = [];
  try {
    const client = await createProcessDriver(
      [process.execPath, join(import.meta.dir, 'ts-process.ts')],
      server.endpoints,
    );
    clients.push(client);
    assertProcessSync(await client.invoke('syncUntilIdle'));
    expect(
      processObject(await client.invoke('stats')).sampling,
    ).toBeUndefined();
    await expect(client.invoke('stats', { sampling: false })).rejects.toThrow(
      'not active',
    );
    await expect(client.invoke('stats', { sampling: 'yes' })).rejects.toThrow(
      'boolean',
    );
    for (let iteration = 0; iteration < 2; iteration++) {
      await client.invoke('stats', { reset: true, sampling: true });
      await expect(client.invoke('stats', { sampling: true })).rejects.toThrow(
        'already active',
      );
      await expect(client.invoke('stats', { reset: true })).rejects.toThrow(
        'already active',
      );
      await expect(client.invoke('notACommand')).rejects.toThrow(
        'Unknown TS benchmark command',
      );
      assertProcessSync(await client.invoke('syncUntilIdle'));
      const snapshot = processObject(
        await client.invoke('stats', { sampling: false }),
      );
      const sampling = processSampling(snapshot.sampling);
      expect(sampling.bunVersion).toBe(Bun.version);
      expect(sampling.samples).toBeGreaterThanOrEqual(0);
      expect(
        processObject(await client.invoke('stats')).sampling,
      ).toBeUndefined();
    }
    await client.invoke('stats', { sampling: true });
  } finally {
    try {
      for (const client of clients) await client.close();
    } finally {
      await server.close();
    }
  }
}, 30_000);
