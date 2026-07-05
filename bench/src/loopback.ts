/**
 * The bench loopback lane: client core + real server library exchanging
 * in-process bytes on bun:sqlite — the same lane philosophy as the
 * conformance loopback (no sockets, no serialization beyond the wire
 * bytes themselves).
 */

import {
  type ClientSchema,
  SyncClient,
  type SyncClientLimits,
} from '@syncular/client';
import { openBunDatabase } from '@syncular/client/bun';
import { encodeRow } from '@syncular/core';
import {
  compileSchema,
  createRealtimeHub,
  handleSegmentDownload,
  handleSyncRequest,
  MemorySegmentStore,
  type RealtimeHub,
  type ServerStorage,
  SqliteServerStorage,
  type SyncRequestContext,
} from '@syncular/server';
import {
  ACTOR_ID,
  COLUMNS,
  PARTITION,
  PROJECT_ID,
  rowId,
  rowValues,
  SCHEMA,
  seededRandom,
  TABLE,
} from './fixture';

export interface BenchServer {
  readonly storage: ServerStorage;
  readonly hub: RealtimeHub;
  readonly ctx: SyncRequestContext;
  close(): void | Promise<void>;
}

export interface BenchServerOptions {
  /**
   * Inject an alternative storage backend (the PG lane wires
   * `PostgresServerStorage`). Defaults to a fresh in-memory bun:sqlite.
   */
  readonly storage?: ServerStorage;
  /** Cleanup for an injected storage; the sqlite default closes its db. */
  readonly close?: () => void | Promise<void>;
}

export function createBenchServer(options?: BenchServerOptions): BenchServer {
  const sqlite =
    options?.storage === undefined ? new SqliteServerStorage() : undefined;
  const storage: ServerStorage = options?.storage ?? (sqlite as ServerStorage);
  const segments = new MemorySegmentStore();
  const resolveScopes = () => ({ project_id: ['*'] });
  const hub = createRealtimeHub({
    schema: SCHEMA,
    storage,
    resolveScopes,
    // §8.7: realtime-connected clients run their sync rounds over the
    // socket seam, through the same segment store.
    segments,
  });
  const ctx: SyncRequestContext = {
    partition: PARTITION,
    actorId: ACTOR_ID,
    schema: SCHEMA,
    storage,
    segments,
    resolveScopes,
    realtime: hub,
  };
  const close = options?.close ?? (() => sqlite?.db.close());
  return { storage, hub, ctx, close };
}

/** Seed N deterministic rows straight into server storage (not timed). */
export async function seedServerRows(
  server: BenchServer,
  count: number,
): Promise<void> {
  const rand = seededRandom(0xb6b6b6);
  // Direct storage seeding (not through the handler): the relational row
  // tables must exist first.
  await server.storage.ensureSchema(compileSchema(SCHEMA));
  const tx = await server.storage.begin(PARTITION);
  for (let i = 0; i < count; i++) {
    const values = rowValues(i, rand);
    await tx.upsertRow(TABLE, {
      rowId: rowId(i),
      serverVersion: 1,
      scopes: { project_id: PROJECT_ID },
      payload: encodeRow(COLUMNS, values),
    });
  }
  await tx.commit();
}

const CLIENT_SCHEMA: ClientSchema = {
  version: SCHEMA.version,
  tables: SCHEMA.tables.map((table) => ({
    name: table.name,
    columns: table.columns,
    primaryKey: table.primaryKey,
    scopes: table.scopes,
  })),
};

export interface BenchClient {
  readonly client: SyncClient;
  /** Resolves once the client acked a realtime cursor ≥ `cursor`. */
  waitForAck(cursor: number): Promise<void>;
  close(): Promise<void>;
}

export async function createBenchClient(
  server: BenchServer,
  options?: { limits?: SyncClientLimits; realtime?: boolean },
): Promise<BenchClient> {
  const ackWaiters: Array<{ threshold: number; resolve: () => void }> = [];
  let maxAck = -1;
  const observeAck = (text: string) => {
    try {
      const parsed = JSON.parse(text) as { type?: string; cursor?: number };
      if (parsed.type === 'ack' && typeof parsed.cursor === 'number') {
        maxAck = Math.max(maxAck, parsed.cursor);
        for (let i = ackWaiters.length - 1; i >= 0; i--) {
          const waiter = ackWaiters[i];
          if (waiter !== undefined && maxAck >= waiter.threshold) {
            ackWaiters.splice(i, 1);
            waiter.resolve();
          }
        }
      }
    } catch {
      // ignore unparseable control messages
    }
  };

  const client = new SyncClient({
    database: openBunDatabase(),
    schema: CLIENT_SCHEMA,
    clientId: crypto.randomUUID(),
    transport: (bytes) => handleSyncRequest(bytes, server.ctx),
    segments: async (request) => {
      const result = await handleSegmentDownload(server.ctx, {
        segmentId: request.segmentId,
        scopesHeader: request.requestedScopesJson,
      });
      return result.bytes;
    },
    ...(options?.limits !== undefined ? { limits: options.limits } : {}),
    ...(options?.realtime === true
      ? {
          realtime: async (handlers) => {
            const session = await server.hub.connect({
              partition: PARTITION,
              actorId: ACTOR_ID,
              clientId: client.clientId,
              send: (data) => {
                if (typeof data === 'string') handlers.onText(data);
                else handlers.onBinary(data);
              },
            });
            return {
              send: (text: string) => {
                observeAck(text);
                session.handleMessage(text);
              },
              sendBytes: (bytes: Uint8Array) => session.handleBinary(bytes),
              close: () => session.close(),
            };
          },
        }
      : {}),
  });
  await client.start();
  client.subscribe({
    id: 'bench',
    table: TABLE,
    scopes: { project_id: [PROJECT_ID] },
  });
  return {
    client,
    waitForAck(cursor: number): Promise<void> {
      if (maxAck >= cursor) return Promise.resolve();
      return new Promise((resolve) => {
        ackWaiters.push({ threshold: cursor, resolve });
      });
    },
    close: () => client.close(),
  };
}
