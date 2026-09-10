import { SCHEMA, PROJECT_ID } from './fixture';
import { withinDeadline } from './instrumentation';
import type { BenchEndpoints } from './loopback';

export function processObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Expected native result object');
  return value as Record<string, unknown>;
}

/** Validate private native phase counters before retaining them in artifacts. */
export function processPhases(value: unknown) {
  const phases = processObject(value);
  if (phases.version !== 1 || typeof phases.scope !== 'string' || !phases.scope)
    throw new Error('Native phase metadata is invalid');
  const measurements = Object.fromEntries(
    Object.entries(processObject(phases.measurements)).map(([name, value]) => {
      if (
        ![
          'requestPrepare',
          'requestEncode',
          'outboxEncode',
          'responseDecode',
          'responseApply',
          'commitApply',
          'rowDecode',
          'rowWrite',
          'observationPrepare',
          'observationCommit',
          'cursorPersist',
          'overlayRebuild',
          'pendingReplay',
          'blobReconcile',
          'blobDownload',
          'blobValidate',
          'blobEncode',
          'blobCacheRead',
          'blobCacheInsert',
        ].includes(name)
      )
        throw new Error('Native phase name is invalid');
      const row = processObject(value);
      for (const key of ['calls', 'elapsedNs', 'threadCpuNs', 'units'])
        if (
          typeof row[key] !== 'number' ||
          !Number.isSafeInteger(row[key]) ||
          row[key] < 0
        )
          throw new Error('Native phase counter is invalid');
      return [
        name,
        {
          calls: Number(row.calls),
          elapsedNs: Number(row.elapsedNs),
          threadCpuNs: Number(row.threadCpuNs),
          units: Number(row.units),
        },
      ];
    }),
  );
  return { version: 1, scope: phases.scope, measurements };
}

/** Validate the versioned envelope and preserve raw Bun sampling data. */
export function processSampling(value: unknown) {
  const envelope = processObject(value);
  if (
    envelope.version !== 1 ||
    envelope.encoding !== 'gzip-base64' ||
    envelope.format !== 'bun-jsc-sampling' ||
    typeof envelope.bunVersion !== 'string' ||
    !envelope.bunVersion ||
    envelope.intervalUs !== 1000 ||
    typeof envelope.samples !== 'number' ||
    !Number.isSafeInteger(envelope.samples) ||
    envelope.samples < 0 ||
    typeof envelope.elapsedMs !== 'number' ||
    !Number.isFinite(envelope.elapsedMs) ||
    envelope.elapsedMs < 0 ||
    typeof envelope.data !== 'string' ||
    !envelope.data
  )
    throw new Error('TS sampling metadata is invalid');
  const compressed = Buffer.from(envelope.data, 'base64');
  if (compressed.toString('base64') !== envelope.data)
    throw new Error('TS sampling encoding is invalid');
  const raw = processObject(
    JSON.parse(new TextDecoder().decode(Bun.gunzipSync(compressed))),
  );
  const stacks = processObject(raw.stackTraces);
  if (
    typeof raw.functions !== 'string' ||
    typeof raw.bytecodes !== 'string' ||
    stacks.interval !== 0.001 ||
    !Array.isArray(stacks.traces) ||
    stacks.traces.length !== envelope.samples ||
    !Array.isArray(stacks.sources)
  )
    throw new Error('TS sampling profile format is invalid');
  for (const traceValue of stacks.traces) {
    const trace = processObject(traceValue);
    if (
      typeof trace.timestamp !== 'number' ||
      !Number.isFinite(trace.timestamp) ||
      !Array.isArray(trace.frames)
    )
      throw new Error('TS sampling trace is invalid');
    for (const frameValue of trace.frames) {
      const frame = processObject(frameValue);
      if (
        typeof frame.name !== 'string' ||
        typeof frame.category !== 'string' ||
        (frame.sourceURL !== undefined && typeof frame.sourceURL !== 'string')
      )
        throw new Error('TS sampling frame is invalid');
    }
  }
  return {
    version: 1,
    encoding: 'gzip-base64',
    format: 'bun-jsc-sampling',
    bunVersion: envelope.bunVersion,
    intervalUs: 1000,
    samples: envelope.samples,
    elapsedMs: envelope.elapsedMs,
    data: envelope.data,
  };
}

/** Normalize Bun's OS counters; some runtimes return bigint CPU microseconds. */
export function processResources(value: unknown) {
  const usage = processObject(value);
  const cpu = processObject(usage.cpuTime);
  const [user, system, total, peakRssBytes] = [
    cpu.user,
    cpu.system,
    cpu.total,
    usage.maxRSS,
  ].map((counter) => {
    if (typeof counter !== 'number' && typeof counter !== 'bigint')
      throw new Error('Process resource counter is missing or invalid');
    const number = Number(counter);
    if (!Number.isSafeInteger(number) || number < 0)
      throw new Error('Process resource counter is outside the safe range');
    return number;
  });
  if (
    user === undefined ||
    system === undefined ||
    total === undefined ||
    peakRssBytes === undefined ||
    total !== user + system ||
    peakRssBytes === 0
  )
    throw new Error('Process resource totals are inconsistent');
  return {
    userCpuMs: user / 1000,
    systemCpuMs: system / 1000,
    cpuMs: total / 1000,
    peakRssBytes,
  };
}

export function assertProcessSync(
  value: unknown,
  expectedApplied?: number,
  expectedRejected: readonly string[] = [],
) {
  const result = processObject(value);
  if (result.ok !== true)
    throw new Error(`Client sync failed: ${JSON.stringify(result)}`);
  const report = processObject(result.report);
  if (JSON.stringify(report.rejected) !== JSON.stringify(expectedRejected))
    throw new Error('Client rejected outcomes differ from fixture');
  for (const key of ['retryable', 'failed', 'bootstrapping']) {
    if (!Array.isArray(report[key]) || report[key].length !== 0)
      throw new Error(`Client sync incomplete: ${key}`);
  }
  if (report.conflicts !== 0 || report.deferredCommits !== 0)
    throw new Error('Client sync has unresolved commits');
  if (
    expectedApplied !== undefined &&
    (!Array.isArray(report.applied) ||
      report.applied.length !== expectedApplied)
  )
    throw new Error('Client applied count differs from fixture');
  return report;
}

/** Read JSON lines while accounting for framing separately from JSON parsing. */
export async function* processMessages(
  stream: ReadableStream<Uint8Array>,
  delivery: {
    responseBytes: number;
    responseParseMs: number;
    responseFramingMs: number;
    responseChunks: number;
    responseScanChars: number;
  },
) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const parts: string[] = [];
  const output = stream.getReader();
  try {
    while (true) {
      const { done, value: bytes } = await output.read();
      if (done) break;
      delivery.responseChunks++;
      let framingStarted = performance.now();
      const chunk = decoder.decode(bytes, { stream: true });
      let offset = 0;
      while (true) {
        const newline = chunk.indexOf('\n', offset);
        delivery.responseScanChars +=
          (newline < 0 ? chunk.length : newline + 1) - offset;
        if (newline < 0) {
          if (offset < chunk.length) parts.push(chunk.slice(offset));
          delivery.responseFramingMs += performance.now() - framingStarted;
          break;
        }
        let text = chunk.slice(offset, newline);
        if (parts.length) {
          parts.push(text);
          text = parts.join('');
          parts.length = 0;
        }
        offset = newline + 1;
        delivery.responseFramingMs += performance.now() - framingStarted;
        const parseStarted = performance.now();
        const message = processObject(JSON.parse(text));
        delivery.responseParseMs += performance.now() - parseStarted;
        delivery.responseBytes += Buffer.byteLength(text) + 1;
        yield message;
        framingStarted = performance.now();
      }
    }
    decoder.decode();
    if (parts.length)
      throw new Error('Client response stream ended mid-message');
  } finally {
    output.releaseLock();
  }
}

/** One isolated process per client, with result IDs checked on every call. */
export async function createProcessDriver(
  binary: string | readonly string[],
  endpoints: BenchEndpoints,
  dbPath?: string,
  clientId = crypto.randomUUID(),
  schema = SCHEMA,
  ffi = false,
  limits?: { limitSnapshotRows: number; maxSnapshotPages: number },
  blobDiagnostics?: boolean,
) {
  const child = Bun.spawn(typeof binary === 'string' ? [binary] : [...binary], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stderr = new Response(child.stderr).text();
  const waiting = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  let sequence = 0;
  let stopped = false;
  const delivery = {
    requestBytes: 0,
    responseBytes: 0,
    requestSerializeMs: 0,
    responseParseMs: 0,
    responseFramingMs: 0,
    responseChunks: 0,
    responseScanChars: 0,
  };
  const incoming = (async () => {
    try {
      for await (const message of processMessages(child.stdout, delivery)) {
        if (typeof message.id !== 'number')
          throw new Error('Client response has no ID');
        const callback = waiting.get(message.id);
        if (!callback) throw new Error('Unexpected native response ID');
        waiting.delete(message.id);
        if ('error' in message)
          callback.reject(
            new Error(
              `Client command failed: ${JSON.stringify(message.error)}`,
            ),
          );
        else if ('result' in message) callback.resolve(message.result);
        else callback.reject(new Error('Client response has no result'));
      }
    } catch (error) {
      for (const callback of waiting.values())
        callback.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      waiting.clear();
      child.kill('SIGTERM');
    } finally {
      stopped = true;
      for (const callback of waiting.values())
        callback.reject(new Error('Client process ended before response'));
      waiting.clear();
    }
  })();
  const invoke = async (
    method: string,
    params: Record<string, unknown> = {},
  ) => {
    if (stopped) throw new Error('Client process is closed');
    const id = ++sequence;
    const response = new Promise<unknown>((resolve, reject) => {
      waiting.set(id, { resolve, reject });
    });
    const serializeStarted = performance.now();
    const request = `${JSON.stringify({ id, method, params })}\n`;
    delivery.requestSerializeMs += performance.now() - serializeStarted;
    delivery.requestBytes += Buffer.byteLength(request);
    child.stdin.write(request);
    try {
      return await withinDeadline(response, `client ${method}`);
    } finally {
      waiting.delete(id);
    }
  };
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      child.stdin.end();
      try {
        const code = await withinDeadline(
          child.exited,
          'client shutdown',
          10_000,
        );
        if (code !== 0)
          throw new Error(`Client process exited ${code}: ${await stderr}`);
      } finally {
        if (child.exitCode === null) child.kill('SIGKILL');
        await child.exited;
        await incoming;
      }
    })());
  try {
    await invoke('create', {
      ...(blobDiagnostics !== undefined ? { blobDiagnostics } : {}),
      ...(limits ? { limits } : {}),
      ...(ffi ? { benchBoundary: 'ffi' } : {}),
      schema: {
        ...schema,
        tables: schema.tables.map((table) => ({
          ...table,
          scopes: table.scopes.map((scope) =>
            typeof scope === 'string' ? { pattern: scope } : scope,
          ),
        })),
      },
      clientId,
      ...(dbPath ? { dbPath } : {}),
      transport: {
        baseUrl: new URL(endpoints.syncUrl).origin,
        wsUrl: `${endpoints.realtimeUrl}?clientId=${encodeURIComponent(clientId)}`,
        headers: { 'x-bench-client-id': clientId },
      },
    });
    await invoke('subscribe', {
      id: 'bench',
      table: 'tasks',
      scopes: { project_id: [PROJECT_ID] },
    });
    return {
      invoke,
      close,
      clientId,
      pid: child.pid,
      deliveryStats: () => ({ ...delivery }),
      resourceUsage: () => ({
        pid: child.pid,
        clientId,
        scope: 'process-lifetime' as const,
        ...processResources(child.resourceUsage()),
      }),
      async terminate() {
        child.kill('SIGKILL');
        await child.exited;
        await incoming;
        if (child.signalCode !== 'SIGKILL')
          throw new Error('Client did not terminate through SIGKILL');
        return { pid: child.pid, signal: child.signalCode };
      },
    };
  } catch (error) {
    try {
      await close();
    } catch {
      /* Preserve setup failure. */
    }
    throw error;
  }
}
