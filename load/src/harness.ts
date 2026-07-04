/**
 * The load harness: spawn ONE real server process, wait for it to bind,
 * expose its base URL + a server-metrics reader, and drive N virtual users
 * on a ramp profile bounded by a wall-clock duration (load brief §1). The
 * scenario body is a per-VU async function; the harness owns concurrency
 * ramp, duration cap, RSS/metrics collection, and clean teardown.
 */
import { join } from 'node:path';

const SERVER_ENTRY = join(import.meta.dir, 'server.ts');

export interface ServerMetrics {
  readonly rssBytes: number;
  readonly peakRssBytes: number;
  readonly requests: number;
  readonly requestErrors: number;
  readonly requestDurationMs: { p50: number; p95: number; p99: number };
  readonly segmentsBuilt: number;
  readonly segmentsReused: number;
  readonly pushApplied: number;
  readonly pushConflicted: number;
  readonly pushRejected: number;
  readonly realtimeDeltas: number;
  readonly realtimeWakes: number;
  readonly realtimeOpened: number;
  readonly realtimeClosed: number;
  readonly pruneRuns: number;
  readonly pruneRemovedCommits: number;
}

export interface LoadServer {
  readonly baseUrl: string;
  metrics(): Promise<ServerMetrics>;
  prune(): Promise<number>;
  stop(): Promise<void>;
}

export interface SpawnOptions {
  /** Rows to seed into the storm project before the server binds. */
  readonly seedRows?: number;
  /** Forward SYNCULAR_LOAD_LOG_EVENTS=1 (server logs JSON events to stderr). */
  readonly logEvents?: boolean;
}

/** Spawn the load server as its own process and wait for the ready line. */
export async function spawnServer(
  options: SpawnOptions = {},
): Promise<LoadServer> {
  const proc = Bun.spawn(['bun', 'run', SERVER_ENTRY], {
    env: {
      ...process.env,
      SYNCULAR_LOAD_PORT: '0',
      SYNCULAR_LOAD_SEED_ROWS: String(options.seedRows ?? 0),
      ...(options.logEvents ? { SYNCULAR_LOAD_LOG_EVENTS: '1' } : {}),
    },
    stdout: 'pipe',
    stderr: 'inherit',
  });

  const port = await readReadyPort(proc);
  const baseUrl = `http://127.0.0.1:${port}`;

  const server: LoadServer = {
    baseUrl,
    async metrics() {
      const response = await fetch(`${baseUrl}/__load/metrics`);
      if (!response.ok) throw new Error(`metrics ${response.status}`);
      return (await response.json()) as ServerMetrics;
    },
    async prune() {
      const response = await fetch(`${baseUrl}/__load/prune`, {
        method: 'POST',
      });
      if (!response.ok) throw new Error(`prune ${response.status}`);
      const body = (await response.json()) as { removedCommits: number };
      return body.removedCommits;
    },
    async stop() {
      try {
        await fetch(`${baseUrl}/__load/shutdown`, { method: 'POST' });
      } catch {
        // shutting down races the response — ignore
      }
      // Give it a beat to exit cleanly, then hard-kill.
      const exited = await Promise.race([
        proc.exited.then(() => true),
        new Promise<boolean>((r) => setTimeout(() => r(false), 2000)),
      ]);
      if (!exited) proc.kill();
    },
  };
  return server;
}

async function readReadyPort(proc: Bun.Subprocess): Promise<number> {
  const stdout = proc.stdout as ReadableStream<Uint8Array>;
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (Date.now() > deadline) {
      proc.kill();
      throw new Error('server did not report ready within 30s');
    }
    const { value, done } = await reader.read();
    if (done) throw new Error('server exited before reporting ready');
    buffer += decoder.decode(value, { stream: true });
    const line = buffer
      .split('\n')
      .find((l) => l.startsWith('LOAD_SERVER_READY'));
    if (line !== undefined) {
      reader.releaseLock();
      // Drain remaining server stdout so its pipe never blocks.
      void drain(stdout);
      const port = Number(line.slice('LOAD_SERVER_READY'.length).trim());
      if (!Number.isFinite(port) || port <= 0) {
        throw new Error(`bad ready line: ${line}`);
      }
      return port;
    }
  }
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done } = await reader.read();
      if (done) return;
    }
  } catch {
    // stream closed on shutdown
  }
}

// ---------------------------------------------------------------------------
// VU ramp
// ---------------------------------------------------------------------------

export interface RampStage {
  /** Target concurrent VUs at the end of this stage. */
  readonly target: number;
  /** Ramp duration to reach `target`, in ms. */
  readonly durationMs: number;
}

export interface RampProfile {
  readonly stages: readonly RampStage[];
  /** Hard wall-clock cap for the whole run (excludes ramp-down). */
  readonly maxDurationMs: number;
}

/**
 * A VU body: runs one virtual user's loop. It should honor `signal` (stop
 * looping when aborted) and MUST throw on a protocol error so the harness
 * can count it against the error budget. `vu` is the 0-based VU index.
 */
export type VuBody = (ctx: {
  readonly vu: number;
  readonly baseUrl: string;
  readonly signal: AbortSignal;
}) => Promise<void>;

export interface RampResult {
  readonly completedVus: number;
  readonly failedVus: number;
  readonly errors: readonly string[];
  readonly wallMs: number;
}

/**
 * Target concurrent VUs at `elapsedMs` into a ramp: linear interpolation
 * within the active stage, holding the last stage's target afterward.
 * Exported so the ramp shaping is unit-tested without spawning a server.
 */
export function rampTargetAt(
  stages: readonly RampStage[],
  elapsedMs: number,
): number {
  let acc = 0;
  let prev = 0;
  for (const stage of stages) {
    if (elapsedMs <= acc + stage.durationMs) {
      const frac =
        stage.durationMs === 0 ? 1 : (elapsedMs - acc) / stage.durationMs;
      return Math.round(prev + (stage.target - prev) * frac);
    }
    acc += stage.durationMs;
    prev = stage.target;
  }
  return prev;
}

/**
 * Run a ramping-VU workload. Each active VU runs `body` to completion, then
 * (if the run window is still open) is replaced by a fresh VU — matching
 * k6's iterating-VU model. Peak concurrency follows the ramp stages.
 */
export async function runRamp(
  server: LoadServer,
  profile: RampProfile,
  body: VuBody,
): Promise<RampResult> {
  const controller = new AbortController();
  const started = performance.now();
  const rampTotal = profile.stages.reduce((a, s) => a + s.durationMs, 0);
  const deadline =
    started +
    Math.min(profile.maxDurationMs, rampTotal || profile.maxDurationMs) +
    1;

  let completedVus = 0;
  let failedVus = 0;
  const errors: string[] = [];
  let nextVuId = 0;
  const active = new Set<Promise<void>>();

  const spawnVu = (): void => {
    const vu = nextVuId++;
    const p = (async () => {
      try {
        await body({ vu, baseUrl: server.baseUrl, signal: controller.signal });
        completedVus += 1;
      } catch (error) {
        failedVus += 1;
        if (errors.length < 20) {
          errors.push(error instanceof Error ? error.message : String(error));
        }
      }
    })().finally(() => {
      active.delete(p);
    });
    active.add(p);
  };

  // Control loop: every 100ms, top up active VUs toward the ramp target.
  for (;;) {
    const now = performance.now();
    const elapsed = now - started;
    if (now >= deadline) break;
    const target = Math.max(0, rampTargetAt(profile.stages, elapsed));
    while (active.size < target) spawnVu();
    await new Promise((r) => setTimeout(r, 100));
  }

  // Window closed: signal VUs to stop looping, drain in-flight iterations.
  controller.abort();
  await Promise.allSettled([...active]);

  return {
    completedVus,
    failedVus,
    errors,
    wallMs: performance.now() - started,
  };
}
