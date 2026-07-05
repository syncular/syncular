/**
 * Operation-serialization (the core owns one loop): every transaction-entering
 * ASYNC operation — a pull round and `setWindow` — runs serialized on one
 * chain so no two interleave their SQLite transactions (or share the `#batch`
 * accumulator) at an `await` point.
 *
 * This is a DETERMINISTIC interleaving test: it forces the collision through
 * promise-ordering on the injectable segment-download seam, never sleeps. A
 * bootstrap `sync()` suspends inside `#processResponse` at
 * `await this.#downloadSegment` (a real await BETWEEN the segment-apply
 * transactions); while it is suspended a `setWindow` is driven, whose widen
 * transaction — absent the `#opChain` serialization — would interleave with
 * the pull's apply transactions and corrupt the shared apply state. The probe
 * is a `ClientDatabase` wrapper that COUNTS any moment two top-level
 * transactions are open at once on the connection (the single-threaded,
 * deterministic analogue of "cannot start a transaction within a
 * transaction"). Before the fix the interleave wedges both operations (and,
 * when it does not wedge, records a violation); after it, they serialize and
 * both settle promptly with zero violations.
 */

import { afterEach, expect, test } from 'bun:test';
import type {
  SegmentFetchRequest,
  SqlRow,
  SqlValue,
  SyncClientConfig,
} from '@syncular/client';
import { type ClientDatabase, SyncClient } from '@syncular/client';
import { BunClientDatabase } from '@syncular/client/bun';
import { handleSegmentDownload, handleSyncRequest } from '@syncular/server';
import {
  CLIENT_SCHEMA,
  makeServer,
  PARTITION,
  type TestServer,
  taskValues,
} from './helpers';

/**
 * Forwards to a real bun:sqlite backend but records every moment two top-level
 * transactions are open at once — the single-threaded, deterministic analogue
 * of the cross-thread corruption. Savepoint nesting is honored (a nested call
 * does not reopen a top-level transaction), so only genuinely INTERLEAVED
 * transactions from two operations increment `violations`. It counts rather
 * than throws so both operations still finish and the assertion is on the
 * count, not a wedged connection.
 */
class OverlapProbeDatabase implements ClientDatabase {
  readonly inner = new BunClientDatabase();
  #open = 0;
  violations = 0;

  exec(sql: string, params?: readonly SqlValue[]): void {
    this.inner.exec(sql, params);
  }

  query(sql: string, params?: readonly SqlValue[]): SqlRow[] {
    return this.inner.query(sql, params);
  }

  transaction<T>(fn: () => T): T {
    const isTop = !this.inner.db.inTransaction;
    if (isTop) {
      if (this.#open > 0) this.violations += 1;
      this.#open += 1;
    }
    try {
      return this.inner.transaction(fn);
    } finally {
      if (isTop) this.#open -= 1;
    }
  }

  close(): void {
    this.inner.close();
  }
}

/** A segment downloader whose first response is gated to a manual release. */
interface GatedSegments {
  downloader: NonNullable<SyncClientConfig['segments']>;
  /** Resolves once a download has started and is suspended at the gate. */
  started: Promise<void>;
  /** Stop gating; the suspended download (and future ones) resolve. */
  passthrough(): void;
}

function gatedSegments(server: TestServer, actorId: string): GatedSegments {
  let gating = true;
  let release: (() => void) | undefined;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  return {
    downloader: async (request: SegmentFetchRequest) => {
      const result = await handleSegmentDownload(server.ctxFor(actorId), {
        segmentId: request.segmentId,
        scopesHeader: request.requestedScopesJson,
      });
      if (gating) {
        await new Promise<void>((resolve) => {
          release = resolve;
          markStarted();
        });
      }
      return result.bytes;
    },
    started,
    passthrough: () => {
      gating = false;
      release?.();
      release = undefined;
    },
  };
}

const clients: SyncClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) {
    try {
      await c.close();
    } catch {
      /* best effort */
    }
  }
});

function plainSegments(
  server: TestServer,
  actorId: string,
): NonNullable<SyncClientConfig['segments']> {
  return async (request: SegmentFetchRequest) => {
    const result = await handleSegmentDownload(server.ctxFor(actorId), {
      segmentId: request.segmentId,
      scopesHeader: request.requestedScopesJson,
    });
    return result.bytes;
  };
}

function makeProbeClient(
  server: TestServer,
  clientId: string,
  segments: NonNullable<SyncClientConfig['segments']>,
): { client: SyncClient; db: OverlapProbeDatabase } {
  const db = new OverlapProbeDatabase();
  const actorId = 'actor-1';
  const config: SyncClientConfig = {
    database: db,
    schema: CLIENT_SCHEMA,
    clientId,
    now: () => server.now.ms,
    transport: (bytes) => handleSyncRequest(bytes, server.ctxFor(actorId)),
    segments,
  };
  const client = new SyncClient(config);
  clients.push(client);
  return { client, db };
}

test('setWindow does not interleave with a bootstrap pull (§4.8, §8.2, one loop)', async () => {
  // Without SyncClient's #opChain the interleave corrupts the shared apply
  // state and WEDGES both operations — a regression surfaces as this bounded
  // timeout (and, when it does not wedge, as a nonzero `violations` count).
  const server = makeServer();
  server.limits.inlineSegmentMaxBytes = 0; // force SEGMENT_REF → download await

  // Seed two projects worth of rows so the bootstrap pull yields real segments.
  const writer = makeProbeClient(
    server,
    'writer',
    plainSegments(server, 'actor-1'),
  );
  await writer.client.start();
  for (const [id, project] of [
    ['a1', 'winA'],
    ['b1', 'winB'],
  ] as const) {
    writer.client.mutate([
      { table: 'tasks', op: 'upsert', values: taskValues(id, project, id) },
    ]);
    await writer.client.syncUntilIdle();
  }

  const gate = gatedSegments(server, 'actor-1');
  const reader = makeProbeClient(server, 'reader', gate.downloader);
  await reader.client.start();
  // Window in winA — the bootstrap pull for it will download a gated segment.
  await reader.client.setWindow({ table: 'tasks', variable: 'project_id' }, [
    'winA',
  ]);
  const firstPull = reader.client.sync();
  // The pull is now suspended at the gated segment download, mid-apply.
  await gate.started;

  // Drive a window widen while the pull is suspended. Its widen transaction
  // must NOT interleave with the pull's segment-apply transactions. Without
  // #opChain it would, tripping the overlap probe.
  const widen = reader.client.setWindow(
    { table: 'tasks', variable: 'project_id' },
    ['winA', 'winB'],
  );
  await new Promise((r) => setTimeout(r, 5));
  gate.passthrough();

  // Bound the settle: without serialization the interleave corrupts the
  // shared apply state and wedges the operations, so surface that as an
  // explicit assertion (a `false` completion) rather than the harness
  // timeout. With serialization both settle promptly.
  const settled = await Promise.race([
    Promise.allSettled([firstPull, widen]).then(() => true),
    new Promise<boolean>((r) => setTimeout(() => r(false), 1500)),
  ]);
  expect(settled).toBe(true); // both operations completed — no wedge
  await new Promise((r) => setTimeout(r, 5));

  // And the transactions never interleaved.
  expect(reader.db.violations).toBe(0);
  await reader.client.syncUntilIdle();
  const rows = reader.client.query('SELECT id FROM tasks ORDER BY id', []);
  expect(rows.map((row) => row.id)).toEqual(['a1', 'b1']);
}, 3000);
