/**
 * Operation serialization (the core owns one loop): a pull round and the
 * shrink half of `setWindow` run on one chain, so no two interleave their
 * SQLite transactions (or share the `#batch` accumulator) at an `await`
 * point. A widen commits in one synchronous transaction, so it runs between a
 * round's transactions without waiting for the round (§7.8).
 *
 * A bootstrap `sync()` suspends inside `#processResponse` at
 * `await this.#downloadSegment` (a real await BETWEEN the segment-apply
 * transactions); while it is suspended a widen is driven. The probe is a
 * `ClientDatabase` wrapper that COUNTS any moment two top-level transactions
 * are open at once on the connection (the single-threaded, deterministic
 * analogue of "cannot start a transaction within a transaction").
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
  TEST_LOG_EPOCH,
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

  queryReadOnly(sql: string, params?: readonly SqlValue[]): SqlRow[] {
    return this.inner.queryReadOnly(sql, params);
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

test('a widen settles while a bootstrap pull is suspended and never interleaves with it (§4.8, §7.8)', async () => {
  const server = makeServer();
  server.limits.inlineSegmentMaxBytes = 0; // force SEGMENT_REF → download await

  // Seed two projects worth of rows so the bootstrap pull yields real segments.
  const writer = makeProbeClient(
    server,
    'writer',
    plainSegments(server, 'actor-1'),
  );
  await writer.client.start();
  writer.db.exec(
    'INSERT OR REPLACE INTO _syncular_meta(key, value) VALUES (?, ?)',
    ['logEpoch', TEST_LOG_EPOCH],
  );
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
  reader.db.exec(
    'INSERT OR REPLACE INTO _syncular_meta(key, value) VALUES (?, ?)',
    ['logEpoch', TEST_LOG_EPOCH],
  );
  // Window in winA — the bootstrap pull for it will download a gated segment.
  await reader.client.setWindow({ variable: 'project_id' }, ['winA']);
  const firstPull = reader.client.sync();
  // The pull is now suspended at the gated segment download, mid-apply.
  await gate.started;

  // The widen settles while the pull is still suspended at the gate.
  await reader.client.setWindow({ variable: 'project_id' }, ['winA', 'winB']);
  gate.passthrough();
  await firstPull;
  expect(reader.db.violations).toBe(0);
  await reader.client.syncUntilIdle();
  const rows = reader.client.query('SELECT id FROM tasks ORDER BY id', []);
  expect(rows.map((row) => row.id)).toEqual(['a1', 'b1']);
});
