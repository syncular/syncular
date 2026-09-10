/**
 * The bench loopback lane: client core + real server library exchanging
 * in-process bytes on bun:sqlite — the same lane philosophy as the
 * conformance loopback (no sockets, no serialization beyond the wire
 * bytes themselves).
 */

import {
  type ClientSchema,
  type ClientDatabase,
  SyncClient,
  type SyncClientLimits,
  type SyncTransport,
  type RealtimeConnector,
  type SegmentDownloader,
  type BlobTransport,
  httpSyncTransport,
  httpSegmentDownloader,
  webSocketRealtimeConnector,
} from '@syncular/client';
import { openBunDatabase } from '@syncular/client/bun';
import { encodeRow } from '@syncular/core';
import {
  compileSchema,
  CommitValidationRejection,
  createRealtimeHub,
  handleSegmentDownload,
  handleSyncRequest,
  MemorySegmentStore,
  type RealtimeHub,
  type ServerStorage,
  SqliteServerStorage,
  type SyncRequestContext,
  type BlobStore,
} from '@syncular/server';
import {
  ACTOR_ID,
  BLOB_SCHEMA,
  COLUMNS,
  PARTITION,
  PROJECT_ID,
  rowId,
  rowValues,
  SCHEMA,
  seededRandom,
  TABLE,
} from './fixture';
import { measureMethods, type MethodMeasurement } from './instrumentation';

export interface BenchServer {
  readonly storage: ServerStorage;
  readonly hub: RealtimeHub;
  readonly ctx: SyncRequestContext;
  close(): void | Promise<void>;
}

export interface BenchServerOptions {
  readonly measurements?: Record<string, MethodMeasurement>;
  readonly resolveScopes?: SyncRequestContext['resolveScopes'];
  readonly blobs?: BlobStore;
  readonly blobSignedUrls?: SyncRequestContext['blobSignedUrls'];
  readonly blobUploadUrls?: SyncRequestContext['blobUploadUrls'];
  readonly maxBlobBytes?: number;
  /** Mixed-commit workload: reject the marked middle commit after staging it. */
  readonly rejectMiddle?: boolean;
  readonly partition?: string;
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
  const resolveScopes =
    options?.resolveScopes ?? (() => ({ project_id: ['*'] }));
  const schema = options?.blobs ? BLOB_SCHEMA : SCHEMA;
  const blobOptions = options?.blobs
    ? {
        blobs: options.blobs,
        ...(options.blobSignedUrls
          ? { blobSignedUrls: options.blobSignedUrls }
          : {}),
        ...(options.blobUploadUrls
          ? { blobUploadUrls: options.blobUploadUrls }
          : {}),
        ...(options.maxBlobBytes !== undefined
          ? { maxBlobBytes: options.maxBlobBytes }
          : {}),
      }
    : {};
  const validation = options?.rejectMiddle
    ? {
        commitValidator: (({ operations }) => {
          const index = operations.findIndex(
            (operation) => operation.row?.title === 'bench-reject-middle',
          );
          if (index >= 0)
            throw new CommitValidationRejection(index, 'bench.middle_rejected');
        }) satisfies NonNullable<SyncRequestContext['commitValidator']>,
      }
    : {};
  const hub = createRealtimeHub({
    ...validation,
    schema,
    ...blobOptions,
    storage,
    resolveScopes,
    // §8.7: realtime-connected clients run their sync rounds over the
    // socket seam, through the same segment store.
    segments,
  });
  if (options?.measurements) {
    // Replace the method on the owned hub so HTTP pushes and its own socket
    // request contexts both measure the same awaited notification path.
    hub.notifyCommit = measureMethods(
      { notifyCommit: hub.notifyCommit.bind(hub) },
      options.measurements,
      'realtime',
    ).notifyCommit;
  }
  const ctx: SyncRequestContext = {
    ...validation,
    partition: options?.partition ?? PARTITION,
    actorId: ACTOR_ID,
    schema,
    ...blobOptions,
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
  await server.storage.ensureSchema(compileSchema(server.ctx.schema));
  const tx = await server.storage.begin(server.ctx.partition);
  try {
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
  } catch (error) {
    await tx.rollback();
    throw error;
  }
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

export interface BenchEndpoints {
  readonly syncUrl: string;
  readonly segmentsUrl: string;
  readonly realtimeUrl: string;
}

export async function closeBenchClients(
  handles: readonly Pick<BenchClient, 'close'>[],
): Promise<void> {
  const closed = await Promise.allSettled(
    handles.map((handle) => handle.close()),
  );
  const failures = closed.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  );
  if (failures.length)
    throw new AggregateError(failures, 'Benchmark client cleanup failed');
}

export async function createBenchClient(
  server: BenchServer | BenchEndpoints,
  options?: {
    schema?: ClientSchema;
    blobs?: BlobTransport;
    limits?: SyncClientLimits;
    realtime?: boolean;
    database?: ClientDatabase;
    transport?: SyncTransport;
    clientId?: string;
    realtimeConnector?: RealtimeConnector;
    segments?: SegmentDownloader;
  },
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

  const database = options?.database ?? openBunDatabase();
  const clientId = options?.clientId ?? crypto.randomUUID();
  const transport =
    options?.transport ??
    ('syncUrl' in server
      ? httpSyncTransport(server.syncUrl)
      : (bytes: Uint8Array) => handleSyncRequest(bytes, server.ctx));
  const segments =
    options?.segments ??
    ('syncUrl' in server
      ? httpSegmentDownloader(server.segmentsUrl)
      : async (request: Parameters<SegmentDownloader>[0]) => {
          const result = await handleSegmentDownload(server.ctx, {
            segmentId: request.segmentId,
            scopesHeader: request.requestedScopesJson,
          });
          return result.bytes;
        });
  const realtime =
    options?.realtimeConnector ??
    ('syncUrl' in server
      ? webSocketRealtimeConnector(
          `${server.realtimeUrl}?clientId=${encodeURIComponent(clientId)}`,
        )
      : async (handlers: Parameters<RealtimeConnector>[0]) => {
          const session = await server.hub.connect({
            partition: server.ctx.partition,
            actorId: ACTOR_ID,
            clientId,
            send: (data) => {
              if (typeof data === 'string') handlers.onText(data);
              else handlers.onBinary(data);
            },
          });
          return {
            send: (text: string) => session.handleMessage(text),
            sendBytes: (bytes: Uint8Array) => session.handleBinary(bytes),
            close: () => session.close(),
          };
        });
  const client = new SyncClient({
    database,
    schema: options?.schema ?? CLIENT_SCHEMA,
    ...(options?.blobs ? { blobs: options.blobs } : {}),
    clientId,
    transport,
    segments,
    ...(options?.limits !== undefined ? { limits: options.limits } : {}),
    ...(options?.realtime === true
      ? {
          realtime: async (handlers) => {
            const socket = await realtime(handlers);
            return {
              ...socket,
              send: (text: string) => {
                observeAck(text);
                socket.send(text);
              },
            };
          },
        }
      : {}),
  });
  try {
    await client.start();
    client.subscribe({
      id: 'bench',
      table: TABLE,
      scopes: { project_id: [PROJECT_ID] },
    });
  } catch (error) {
    try {
      await client.close();
    } finally {
      database.close();
    }
    throw error;
  }
  return {
    client,
    waitForAck(cursor: number): Promise<void> {
      if (maxAck >= cursor) return Promise.resolve();
      return new Promise((resolve) => {
        ackWaiters.push({ threshold: cursor, resolve });
      });
    },
    close: async () => {
      try {
        await client.close();
      } finally {
        database.close();
      }
    },
  };
}
