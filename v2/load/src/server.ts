/**
 * The load-test server process — ONE real server, spawned as its own Bun
 * process by the harness (load brief §1). It is the exact production wiring
 * the demo uses: the server-hono adapter for POST /sync + GET /segments/:id,
 * and a Bun.serve WebSocket bound to the RealtimeHub for the §8.7 socket
 * loop. Storage is bun:sqlite by default; set SYNCULAR_PG_URL to target a
 * real Postgres (the production database path, TODO §4.1).
 *
 * A metrics tap rides the events seam (§3): a MetricsEvents sink folds the
 * structured server events into counters (request durations, segment
 * reuse/build, prune counts) and an internal GET /__load/metrics endpoint
 * exposes them plus process RSS — that is how the harness, a separate
 * process, reads SERVER-SIDE metrics without an external metrics stack.
 *
 * This module is NOT imported by the harness; it is `Bun.spawn`ed. It reads
 * its whole config from env (SYNCULAR_LOAD_*), prints one `LOAD_SERVER_READY
 * <port>` line to stdout when listening, and prunes on demand via a control
 * endpoint so the maintenance-churn scenario can race prune against pushes.
 */
import { encodeRow } from '@syncular-v2/core';
import {
  composeEvents,
  consoleJsonEvents,
  createRealtimeHub,
  MemorySegmentStore,
  type PgExecutor,
  type PgQueryable,
  PostgresServerStorage,
  pruneCommitLog,
  type RealtimeSession,
  type ServerStorage,
  SqliteServerStorage,
  type SyncServerConfig,
  type SyncularServerEvent,
  type SyncularServerEvents,
} from '@syncular-v2/server';
import { createSyncularHono } from '@syncular-v2/server-hono';
import {
  ACTOR_ID,
  COLUMNS,
  PARTITION,
  rowId,
  rowValues,
  SCHEMA,
  STORM_PROJECT,
  seededRandom,
  TABLE,
} from './fixture';

const PORT = Number(process.env.SYNCULAR_LOAD_PORT ?? 0);
const PG_URL = process.env.SYNCULAR_PG_URL;
const LOG_EVENTS = process.env.SYNCULAR_LOAD_LOG_EVENTS === '1';
const SEED_ROWS = Number(process.env.SYNCULAR_LOAD_SEED_ROWS ?? 0);

// ---------------------------------------------------------------------------
// Metrics tap over the events seam (§3)
// ---------------------------------------------------------------------------

interface ServerMetricsSnapshot {
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

class MetricsEvents implements SyncularServerEvents {
  #requests = 0;
  #requestErrors = 0;
  readonly #requestDurations: number[] = [];
  #segmentsBuilt = 0;
  #segmentsReused = 0;
  #pushApplied = 0;
  #pushConflicted = 0;
  #pushRejected = 0;
  #realtimeDeltas = 0;
  #realtimeWakes = 0;
  #realtimeOpened = 0;
  #realtimeClosed = 0;
  #pruneRuns = 0;
  #pruneRemoved = 0;
  #peakRss = 0;

  emit(event: SyncularServerEvent): void {
    switch (event.type) {
      case 'request.handled': {
        this.#requests += 1;
        this.#requestDurations.push(event.durationMs);
        if (event.outcome === 'error' || event.outcome === 'rejected') {
          this.#requestErrors += 1;
        }
        break;
      }
      case 'pull.served': {
        for (const sub of event.subscriptions) {
          for (const segment of sub.segments) {
            if (segment.origin === 'reused') this.#segmentsReused += 1;
            else this.#segmentsBuilt += 1;
          }
        }
        break;
      }
      case 'push.applied': {
        if (!event.replay) this.#pushApplied += 1;
        break;
      }
      case 'push.conflicted':
        this.#pushConflicted += 1;
        break;
      case 'push.rejected':
        this.#pushRejected += 1;
        break;
      case 'realtime.delta':
        this.#realtimeDeltas += 1;
        break;
      case 'realtime.wake':
        this.#realtimeWakes += 1;
        break;
      case 'realtime.opened':
        this.#realtimeOpened += 1;
        break;
      case 'realtime.closed':
        this.#realtimeClosed += 1;
        break;
      case 'prune.completed':
        this.#pruneRuns += 1;
        this.#pruneRemoved += event.removedCommits;
        break;
      default:
        break;
    }
  }

  sampleRss(): void {
    this.#peakRss = Math.max(this.#peakRss, process.memoryUsage().rss);
  }

  snapshot(): ServerMetricsSnapshot {
    const rss = process.memoryUsage().rss;
    this.#peakRss = Math.max(this.#peakRss, rss);
    const sorted = [...this.#requestDurations].sort((a, b) => a - b);
    const pct = (p: number): number => {
      if (sorted.length === 0) return Number.NaN;
      const i = Math.min(
        sorted.length - 1,
        Math.ceil((p / 100) * sorted.length) - 1,
      );
      return sorted[Math.max(0, i)] ?? Number.NaN;
    };
    return {
      rssBytes: rss,
      peakRssBytes: this.#peakRss,
      requests: this.#requests,
      requestErrors: this.#requestErrors,
      requestDurationMs: { p50: pct(50), p95: pct(95), p99: pct(99) },
      segmentsBuilt: this.#segmentsBuilt,
      segmentsReused: this.#segmentsReused,
      pushApplied: this.#pushApplied,
      pushConflicted: this.#pushConflicted,
      pushRejected: this.#pushRejected,
      realtimeDeltas: this.#realtimeDeltas,
      realtimeWakes: this.#realtimeWakes,
      realtimeOpened: this.#realtimeOpened,
      realtimeClosed: this.#realtimeClosed,
      pruneRuns: this.#pruneRuns,
      pruneRemovedCommits: this.#pruneRemoved,
    };
  }
}

// ---------------------------------------------------------------------------
// Storage: sqlite by default, Postgres when SYNCULAR_PG_URL is set
// ---------------------------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: Bun.sql is version-fluid.
const BunSQL = (Bun as any).SQL as undefined | (new (url: string) => any);

// biome-ignore lint/suspicious/noExplicitAny: driver handle is dynamic.
function queryableOver(handle: any): PgQueryable {
  return {
    async query<Row = Record<string, unknown>>(
      text: string,
      params?: readonly unknown[],
    ) {
      const rows = (await handle.unsafe(
        text,
        params ? [...params] : [],
      )) as Row[];
      return { rows, rowCount: rows.length };
    },
  };
}

async function buildStorage(): Promise<{
  storage: ServerStorage;
  close: () => Promise<void>;
}> {
  if (PG_URL !== undefined && PG_URL.length > 0) {
    if (BunSQL === undefined) {
      throw new Error('SYNCULAR_PG_URL set but Bun.SQL is unavailable');
    }
    const sql = new BunSQL(PG_URL);
    const executor: PgExecutor = {
      query: queryableOver(sql).query,
      async transaction<T>(fn: (client: PgQueryable) => Promise<T>) {
        // biome-ignore lint/suspicious/noExplicitAny: dynamic tx handle.
        return sql.begin(async (tx: any) => fn(queryableOver(tx)));
      },
      async close() {
        await sql.end();
      },
    };
    const storage = new PostgresServerStorage(executor);
    await storage.migrate();
    // Start each PG run from a clean partition.
    for (const table of [
      'sync_rows',
      'sync_row_scopes',
      'sync_commits',
      'sync_changes',
      'sync_change_scopes',
      'sync_push_results',
      'sync_clients',
      'sync_partitions',
    ]) {
      // biome-ignore lint/suspicious/noExplicitAny: dynamic handle.
      await (sql as any).unsafe(`DELETE FROM ${table} WHERE partition=$1`, [
        PARTITION,
      ]);
    }
    return { storage, close: async () => void (await executor.close?.()) };
  }
  const sqlite = new SqliteServerStorage(':memory:');
  return { storage: sqlite, close: async () => sqlite.db.close() };
}

// ---------------------------------------------------------------------------
// Wire the server (mirrors apps/demo/src/server.ts)
// ---------------------------------------------------------------------------

/**
 * Seed N deterministic rows into the STORM_PROJECT scope, straight into
 * storage (not over the wire) — the seeded 100k dataset the bootstrap-storm
 * clients read. Committed in batches so a large seed stays memory-flat.
 */
async function seedStormRows(
  storage: ServerStorage,
  count: number,
): Promise<void> {
  if (count <= 0) return;
  const rand = seededRandom(0x10adb6);
  const BATCH = 5_000;
  for (let start = 0; start < count; start += BATCH) {
    const end = Math.min(start + BATCH, count);
    const tx = await storage.begin(PARTITION);
    for (let i = start; i < end; i++) {
      const values = rowValues(i, STORM_PROJECT, rand);
      await tx.upsertRow(TABLE, {
        rowId: rowId(i),
        serverVersion: 1,
        scopes: { project_id: STORM_PROJECT },
        payload: encodeRow(COLUMNS, values),
      });
    }
    await tx.commit();
  }
}

const { storage, close: closeStorage } = await buildStorage();
await seedStormRows(storage, SEED_ROWS);
const segments = new MemorySegmentStore();
const metrics = new MetricsEvents();
const events: SyncularServerEvents = LOG_EVENTS
  ? composeEvents(
      metrics,
      consoleJsonEvents((line) => process.stderr.write(`${line}\n`)),
    )
  : metrics;
const resolveScopes = () => ({ project_id: ['*'] });

const hub = createRealtimeHub({
  schema: SCHEMA,
  storage,
  resolveScopes,
  segments,
  events,
});
const config: SyncServerConfig = {
  schema: SCHEMA,
  storage,
  segments,
  resolveScopes,
  realtime: hub,
  events,
};
const hono = createSyncularHono({
  config,
  authenticate: async () => ({ actorId: ACTOR_ID, partition: PARTITION }),
});

// Sample RSS on a steady tick so peak is captured between snapshot reads.
const rssTimer = setInterval(() => metrics.sampleRss(), 100);

interface SocketData {
  clientId: string;
  session?: RealtimeSession;
}

const server = Bun.serve<SocketData, never>({
  port: PORT,
  idleTimeout: 120,
  async fetch(request, bunServer) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/realtime') {
      const clientId = url.searchParams.get('clientId') ?? crypto.randomUUID();
      if (bunServer.upgrade(request, { data: { clientId } })) {
        return undefined as unknown as Response;
      }
      return new Response('expected a websocket upgrade', { status: 400 });
    }
    // Internal control + metrics surface (load harness only).
    if (path === '/__load/metrics') {
      return Response.json(metrics.snapshot());
    }
    if (path === '/__load/prune' && request.method === 'POST') {
      const removed = await pruneCommitLog({
        storage,
        partition: PARTITION,
        nowMs: Date.now(),
        // Aggressive retention so the churn scenario actually removes
        // commits: keep only the newest 50, force past 1s-old commits.
        retention: {
          activeWindowMs: 0,
          ageForceMs: 1000,
          minRetainedCommits: 50,
        },
        events,
      });
      return Response.json({ removedCommits: removed });
    }
    if (path === '/__load/shutdown' && request.method === 'POST') {
      queueMicrotask(async () => {
        clearInterval(rssTimer);
        await closeStorage();
        process.exit(0);
      });
      return Response.json({ ok: true });
    }
    if (
      path === '/sync' ||
      path.startsWith('/segments/') ||
      path.startsWith('/blobs/')
    ) {
      return hono.fetch(request);
    }
    return new Response('not found', { status: 404 });
  },
  websocket: {
    open(ws) {
      hub
        .connect({
          partition: PARTITION,
          actorId: ACTOR_ID,
          clientId: ws.data.clientId,
          send: (data) => {
            ws.send(data);
          },
          closeSocket: () => ws.close(1008, 'protocol violation (§8.7)'),
        })
        .then((session) => {
          ws.data.session = session;
        })
        .catch(() => ws.close(1011, 'realtime connect failed'));
    },
    message(ws, message) {
      if (typeof message === 'string') {
        ws.data.session?.handleMessage(message);
      } else {
        ws.data.session?.handleBinary(new Uint8Array(message));
      }
    },
    close(ws) {
      ws.data.session?.close();
    },
  },
});

// The harness reads this line to learn the port (0 ⇒ OS-assigned).
process.stdout.write(`LOAD_SERVER_READY ${server.port}\n`);
