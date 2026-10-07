/**
 * The embedded sync server: the WHOLE Syncular server running in a Web
 * Worker, so the published demo is static files with zero backend. The
 * engine is runtime-neutral by design; the one Bun-specific
 * piece — storage — is covered by `D1ServerStorage`, which takes any
 * object with the D1 statement shape. sqlite-wasm wears that shape here
 * (the same trick as the test suite's d1-double, over the browser's
 * SQLite instead of bun:sqlite).
 *
 * The page talks to this worker over a small RPC:
 *   page → worker: {kind:'sync'|'admin', id, actorId, …}
 *                  {kind:'rt-open'|'rt-text'|'rt-bytes'|'rt-close', channel, …}
 *                  {kind:'events'} once, to tail the server event ring
 *   worker → page: {kind:'result', id, ok, …} · {kind:'rt-…', channel, …}
 *                  {kind:'event', event} for the retained backlog (oldest
 *                  first), then for every new event
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
  compileSchema,
  createRealtimeHub,
  type D1Database,
  type D1PreparedStatement,
  D1ServerStorage,
  handleSyncRequest,
  MemorySegmentStore,
  type RealtimeSession,
  type ResolveScopesArgs,
  RingBufferEvents,
  seedMutations,
  type SyncServerConfig,
  SyncularAdmin,
} from '@syncular/server';
import { createSyncularAdminRoutes } from '@syncular/server-hono';
import {
  DEMO_PARTITION,
  isDemoActor,
  resolveBoardScopes,
  SEED_ACTOR,
} from '../access';
import { releaseBoardSeedMutations } from '../seed';
import { schema } from '../syncular.generated';

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
    run: async () => ({
      results: db.selectObjects(sql, params.length > 0 ? params : undefined),
    }),
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
  readonly adminRequest: (path: string) => Promise<Response>;
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
  // The D1 migration budget exists for Worker invocation limits; this
  // worker has none, so it drives the resumable migration to completion.
  const compiled = compileSchema(schema);
  while (
    !(await storage.migrateSchema(compiled, { maxStatements: 1000 })).complete
  );
  const segments = new MemorySegmentStore();
  const resolveScopes = (args: ResolveScopesArgs) =>
    resolveBoardScopes(storage, args);
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
    resolveScopes,
    realtime: hub,
    events: ring,
    // Everything inlines: no segment-download path in the embedded demo.
    limits: { inlineSegmentMaxBytes: 64 * 1024 * 1024 },
  };
  const adminRoutes = createSyncularAdminRoutes(
    SyncularAdmin.fromConfig(config, { ring }),
    {
      defaultPartition: DEMO_PARTITION,
      // This route surface is reachable only through the worker RPC. The page
      // verifies the same-origin console frame before forwarding a request.
      authorize: () => true,
    },
  );
  return {
    config,
    hub,
    adminRequest: async (path) => adminRoutes.request(path),
  };
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

const booted = bootServer()
  .then(async (parts) => {
    await seedMutations(
      parts.config,
      { partition: DEMO_PARTITION, actorId: SEED_ACTOR },
      releaseBoardSeedMutations(),
    );
    scope.postMessage({ kind: 'ready' });
    return parts;
  })
  .catch((error: unknown) => {
    scope.postMessage({ kind: 'boot-error', error: toRpcError(error) });
    throw error;
  });

scope.onmessage = (event: MessageEvent) => {
  void (async () => {
    const { config, hub, adminRequest } = await booted;
    const msg = event.data as {
      kind: string;
      actorId?: string;
      id?: number;
      bytes?: Uint8Array;
      channel?: number;
      clientId?: string;
      text?: string;
      path?: string;
    };
    // The page names the signed-in actor of each device; the worker
    // accepts only the two demo actors.
    const actorId = msg.actorId ?? '';
    const ctx = { ...config, partition: DEMO_PARTITION, actorId };
    const reply = (body: Record<string, unknown>, transfer?: Transferable[]) =>
      scope.postMessage({ id: msg.id, ...body }, transfer);
    try {
      if (
        (msg.kind === 'sync' || msg.kind === 'rt-open') &&
        !isDemoActor(msg.actorId)
      ) {
        throw new Error(`${msg.kind} requires a demo actor`);
      }
      switch (msg.kind) {
        case 'sync': {
          if (msg.bytes === undefined) throw new Error('sync without bytes');
          const out = await serializeSyncRound(() =>
            handleSyncRequest(msg.bytes as Uint8Array, ctx),
          );
          reply({ kind: 'result', ok: true, bytes: out }, [out.buffer]);
          break;
        }
        case 'admin': {
          if (msg.path === undefined || !msg.path.startsWith('/')) {
            throw new Error('admin request requires a route path');
          }
          const response = await adminRequest(msg.path);
          reply({
            kind: 'result',
            ok: true,
            status: response.status,
            body: await response.json(),
          });
          break;
        }
        case 'events': {
          // The sync lab's commit log: the same ring that feeds the admin
          // event tail, replayed oldest first and then followed live.
          for (const backlog of ring.query().reverse()) {
            scope.postMessage({ kind: 'event', event: backlog });
          }
          ring.subscribe((live) =>
            scope.postMessage({ kind: 'event', event: live }),
          );
          break;
        }
        case 'rt-open': {
          const channel = msg.channel;
          if (channel === undefined || msg.clientId === undefined) {
            throw new Error('rt-open without channel/clientId');
          }
          const session = await hub.connect({
            partition: DEMO_PARTITION,
            actorId,
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
