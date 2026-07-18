/**
 * The embedded sync server: the WHOLE Syncular server running in a Web
 * Worker, so the published demo is static files with zero backend. The
 * engine is runtime-neutral by design (TODO §4.2); the one Bun-specific
 * piece — storage — is covered by `D1ServerStorage`, which takes any
 * object with the D1 statement shape. sqlite-wasm wears that shape here
 * (the same trick as the test suite's d1-double, over the browser's
 * SQLite instead of bun:sqlite).
 *
 * The page talks to this worker over a small RPC:
 *   page → worker: {kind:'sync'|'blob-upload'|'blob-download', id, …}
 *                  {kind:'rt-open'|'rt-text'|'rt-bytes'|'rt-close', channel, …}
 *   worker → page: {kind:'result', id, ok, …} · {kind:'rt-…', channel, …}
 *                  {kind:'ready'} once seeded.
 *
 * Realtime is the real `RealtimeHub` — each pane opens a channel that
 * stands in for a WebSocket, so deltas and wake-ups flow exactly like
 * production (§8), just over `postMessage`.
 *
 * State is in-memory (like the ephemeral client cores): a reload is a
 * fresh, re-seeded demo — nothing ever leaves the page.
 */
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import {
  encodeMessage,
  encodeRow,
  PROTOCOL_WIRE_VERSION,
  type RequestFrame,
} from '@syncular/core';
import {
  createRealtimeHub,
  type D1Database,
  type D1PreparedStatement,
  D1ServerStorage,
  handleBlobDownload,
  handleBlobUpload,
  handleSyncRequest,
  MemoryBlobStore,
  MemorySegmentStore,
  type RealtimeSession,
  RingBufferEvents,
  type SyncServerConfig,
} from '@syncular/server';
import { schema, type TodosRow } from '../syncular.generated';

const PARTITION = 'demo';
const ACTOR_ID = 'demo-user';

// -- sqlite-wasm wearing the D1 statement shape -------------------------------

/** The `oo1.DB` subset the adapter uses (structural, like `D1Database`). */
interface WasmDb {
  selectObjects(
    sql: string,
    bind?: readonly unknown[],
  ): Record<string, unknown>[];
  exec(opts: { sql: string; bind?: readonly unknown[] }): unknown;
}

function d1OverWasm(db: WasmDb): D1Database {
  const statement = (
    sql: string,
    params: readonly unknown[],
  ): D1PreparedStatement => ({
    bind: (...values: unknown[]) => statement(sql, values),
    first: async <T>() =>
      (db.selectObjects(sql, params.length > 0 ? params : undefined)[0] ??
        null) as T | null,
    all: async <T>() => ({
      results: db.selectObjects(
        sql,
        params.length > 0 ? params : undefined,
      ) as T[],
    }),
    run: async () => {
      db.exec({ sql, ...(params.length > 0 ? { bind: params } : {}) });
      return {};
    },
  });
  return {
    prepare: (sql) => statement(sql, []),
    // Real D1 wraps a batch in one implicit transaction (all-or-nothing);
    // `D1ServerStorage.commit()` relies on exactly that.
    batch: async (statements) => {
      db.exec({ sql: 'BEGIN' });
      try {
        const results: unknown[] = [];
        for (const stmt of statements) results.push(await stmt.run());
        db.exec({ sql: 'COMMIT' });
        return results;
      } catch (error) {
        db.exec({ sql: 'ROLLBACK' });
        throw error;
      }
    },
    exec: async (sql) => db.exec({ sql }),
  };
}

// -- the server ---------------------------------------------------------------

const ring = new RingBufferEvents({ capacity: 500 });

interface EmbeddedServerParts {
  readonly config: SyncServerConfig;
  readonly hub: ReturnType<typeof createRealtimeHub>;
}

async function bootServer(): Promise<EmbeddedServerParts> {
  const sqlite3 = await sqlite3InitModule();
  const db = new sqlite3.oo1.DB(':memory:', 'c') as unknown as WasmDb;
  // Every sync round using this adapter enters `serializeSyncRound` below.
  // That explicit worker-local FIFO is the embedded-demo equivalent of the
  // per-partition Durable Object required by production D1 deployments.
  const storage = new D1ServerStorage(d1OverWasm(db), {
    pushApplySerialized: true,
  });
  const segments = new MemorySegmentStore();
  const blobs = new MemoryBlobStore();
  const resolveScopes = () => ({ list_id: ['*'] });
  const hub = createRealtimeHub({
    schema,
    storage,
    resolveScopes,
    segments,
    events: ring,
  });
  const config: SyncServerConfig = {
    schema,
    storage,
    segments,
    blobs,
    resolveScopes,
    realtime: hub,
    events: ring,
    // Everything inlines: no segment-download path in the embedded demo.
    limits: { inlineSegmentMaxBytes: 64 * 1024 * 1024 },
  };
  return { config, hub };
}

/** Seed a few rows through the real push path (same seed as the dev server). */
async function seed(config: SyncServerConfig): Promise<void> {
  const table = schema.tables[0];
  if (table === undefined) throw new Error('schema has no tables');
  const now = Date.now();
  const rows: TodosRow[] = [
    'Open this page in two panes',
    'Toggle a pane offline and keep editing',
    'Attach a file to a todo — it uploads then syncs',
  ].map((title, index) => ({
    id: `seed-${index + 1}`,
    listId: 'demo',
    title,
    done: false,
    position: index + 1,
    updatedAtMs: now,
    attachment: null,
  }));
  const frames: RequestFrame[] = [
    { type: 'REQ_HEADER', clientId: 'seed', schemaVersion: schema.version },
    {
      type: 'PUSH_COMMIT',
      clientCommitId: 'seed-commit-1',
      operations: rows.map((row) => ({
        table: 'todos',
        rowId: row.id,
        op: 'upsert' as const,
        payload: encodeRow(table.columns, [
          row.id,
          row.listId,
          row.title,
          row.done,
          row.position,
          row.updatedAtMs,
          row.attachment,
        ]),
      })),
    },
    {
      type: 'PULL_HEADER',
      limitCommits: 0,
      limitSnapshotRows: 0,
      maxSnapshotPages: 0,
      accept: 0b0011,
    },
  ];
  await handleSyncRequest(
    encodeMessage({
      wireVersion: PROTOCOL_WIRE_VERSION,
      msgKind: 'request',
      frames,
    }),
    { ...config, partition: PARTITION, actorId: ACTOR_ID },
  );
}

// -- RPC ----------------------------------------------------------------------

interface RpcError {
  readonly code: string;
  readonly message: string;
}

function toRpcError(error: unknown): RpcError {
  const withCode = error as { code?: string; message?: string };
  return {
    code: typeof withCode.code === 'string' ? withCode.code : 'sync.internal',
    message: withCode.message ?? String(error),
  };
}

const scope = self as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent) => void) | null;
};

const sessions = new Map<number, RealtimeSession>();

let syncRoundTail: Promise<void> = Promise.resolve();

function serializeSyncRound<T>(operation: () => Promise<T>): Promise<T> {
  const result = syncRoundTail.then(operation, operation);
  syncRoundTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

const booted = bootServer().then(async (parts) => {
  await seed(parts.config);
  scope.postMessage({ kind: 'ready' });
  return parts;
});

scope.onmessage = (event: MessageEvent) => {
  void (async () => {
    const { config, hub } = await booted;
    const ctx = { ...config, partition: PARTITION, actorId: ACTOR_ID };
    const msg = event.data as {
      kind: string;
      id?: number;
      bytes?: Uint8Array;
      blobId?: string;
      mediaType?: string;
      channel?: number;
      clientId?: string;
      text?: string;
    };
    const reply = (body: Record<string, unknown>, transfer?: Transferable[]) =>
      scope.postMessage({ id: msg.id, ...body }, transfer);
    try {
      switch (msg.kind) {
        case 'sync': {
          if (msg.bytes === undefined) throw new Error('sync without bytes');
          const out = await serializeSyncRound(() =>
            handleSyncRequest(msg.bytes as Uint8Array, ctx),
          );
          reply({ kind: 'result', ok: true, bytes: out }, [out.buffer]);
          break;
        }
        case 'blob-upload': {
          if (msg.blobId === undefined || msg.bytes === undefined) {
            throw new Error('blob-upload without blobId/bytes');
          }
          await handleBlobUpload(ctx, {
            blobId: msg.blobId,
            bytes: msg.bytes,
            ...(msg.mediaType !== undefined
              ? { mediaType: msg.mediaType }
              : {}),
          });
          reply({ kind: 'result', ok: true });
          break;
        }
        case 'blob-download': {
          if (msg.blobId === undefined) {
            throw new Error('blob-download without blobId');
          }
          const result = await handleBlobDownload(ctx, msg.blobId);
          if (result.bytes === undefined) {
            throw new Error('memory blob store always serves inline bytes');
          }
          reply({ kind: 'result', ok: true, bytes: result.bytes });
          break;
        }
        case 'rt-open': {
          const channel = msg.channel;
          if (channel === undefined || msg.clientId === undefined) {
            throw new Error('rt-open without channel/clientId');
          }
          const session = await hub.connect({
            partition: PARTITION,
            actorId: ACTOR_ID,
            clientId: msg.clientId,
            send: (data: string | Uint8Array) => {
              if (typeof data === 'string') {
                scope.postMessage({ kind: 'rt-text', channel, text: data });
              } else {
                scope.postMessage({ kind: 'rt-bytes', channel, bytes: data });
              }
            },
            closeSocket: () => {
              scope.postMessage({ kind: 'rt-closed', channel });
              sessions.delete(channel);
            },
          });
          sessions.set(channel, session);
          reply({ kind: 'result', ok: true });
          break;
        }
        case 'rt-text': {
          if (msg.channel === undefined || msg.text === undefined) break;
          sessions.get(msg.channel)?.handleMessage(msg.text);
          break;
        }
        case 'rt-bytes': {
          if (msg.channel === undefined || msg.bytes === undefined) break;
          const session = sessions.get(msg.channel);
          if (session !== undefined) {
            await serializeSyncRound(async () => {
              await session.handleBinary(msg.bytes as Uint8Array);
            });
          }
          break;
        }
        case 'rt-close': {
          if (msg.channel === undefined) break;
          sessions.get(msg.channel)?.close();
          sessions.delete(msg.channel);
          break;
        }
        default:
          throw new Error(`unknown rpc kind ${JSON.stringify(msg.kind)}`);
      }
    } catch (error) {
      if (msg.id !== undefined) {
        reply({ kind: 'result', ok: false, error: toRpcError(error) });
      }
    }
  })();
};
