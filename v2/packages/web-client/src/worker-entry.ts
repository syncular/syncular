/**
 * Worker-side bootstrap (Direction decision 2): constructs the WHOLE
 * client core — SyncClient + transports + realtime + SQLite — inside the
 * worker and serves the `worker-protocol` RPC over postMessage.
 *
 * Browsers get the defaults: opfs-sahpool persistence and the fetch/WS
 * transports from `./http`, wired from `WorkerInitConfig.endpoints`.
 * Tests inject a database factory (bun:sqlite) through `overrides` — the
 * same bootstrap, the same RPC, a different SQLite.
 *
 * The §8.4 host loop lives HERE: wake-ups (hello/`sync` events, delta
 * drops) coalesce into one jittered `syncUntilIdle` round in the worker;
 * RPC-driven and auto-driven sync rounds serialize on one queue because
 * the core owns exactly one loop.
 */
import { SyncClient } from './client';
import type { ClientDatabase } from './database';
import { ClientSyncError } from './errors';
import {
  httpBlobTransport,
  httpSegmentDownloader,
  httpSyncTransport,
  webSocketRealtimeConnector,
} from './http';
import type {
  RealtimeConnector,
  SegmentDownloader,
  SyncTransport,
} from './transport';
import { openPersistentWasmDatabase } from './wasm-database';
import {
  type MainToWorkerMessage,
  WORKER_FAILED_CODE,
  type WorkerApi,
  type WorkerCallMessage,
  type WorkerErrorShape,
  type WorkerInitConfig,
  type WorkerInitResult,
  type WorkerToMainMessage,
} from './worker-protocol';

export interface SyncWorkerOverrides {
  /** Database factory indirection: tests inject bun:sqlite here. */
  readonly openDatabase?: (
    config: WorkerInitConfig,
  ) => Promise<ClientDatabase> | ClientDatabase;
  readonly createTransport?: (config: WorkerInitConfig) => SyncTransport;
  readonly createSegments?: (
    config: WorkerInitConfig,
  ) => SegmentDownloader | undefined;
  readonly createRealtime?: (
    config: WorkerInitConfig,
    clientId: string,
  ) => RealtimeConnector | undefined;
}

/** Minimal structural view of the dedicated-worker global scope. */
interface WorkerScope {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent) => void,
  ): void;
}

function toErrorShape(error: unknown): WorkerErrorShape {
  if (error instanceof ClientSyncError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  }
  return {
    code: WORKER_FAILED_CODE,
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  };
}

/**
 * ArrayBuffers safe to transfer out of a query result: whole-buffer
 * views only (a view into a larger/pooled buffer is cloned instead —
 * transferring would detach unrelated data), deduplicated because a
 * buffer may only appear once in a transfer list.
 */
function queryTransferables(rows: readonly unknown[]): Transferable[] {
  const buffers = new Set<ArrayBuffer>();
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue;
    for (const value of Object.values(row)) {
      if (
        value instanceof Uint8Array &&
        value.buffer instanceof ArrayBuffer &&
        value.byteOffset === 0 &&
        value.byteLength === value.buffer.byteLength
      ) {
        buffers.add(value.buffer);
      }
    }
  }
  return [...buffers];
}

/**
 * Register the RPC server on the current worker scope. Call this once
 * from a worker entry script; the main-thread handle drives everything
 * else through `init`/`call` messages.
 */
export function startSyncWorker(overrides: SyncWorkerOverrides = {}): void {
  const scope = globalThis as unknown as WorkerScope;
  const post = (message: WorkerToMainMessage, transfer?: Transferable[]) => {
    if (transfer !== undefined && transfer.length > 0) {
      scope.postMessage(message, transfer);
    } else {
      scope.postMessage(message);
    }
  };

  let client: SyncClient | undefined;
  let database: ClientDatabase | undefined;
  let offline = false;
  let closed = false;

  // -- one sync loop: RPC-driven and auto-driven rounds serialize ----------
  let syncChain: Promise<unknown> = Promise.resolve();
  function serializedSync<T>(fn: () => Promise<T>): Promise<T> {
    const next = syncChain.then(fn, fn);
    syncChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  // -- §8.4 host loop: coalesced, jittered, inside the worker --------------
  let autoSync = true;
  let wakeJitterMs = 200;
  let autoSyncScheduled = false;
  function scheduleAutoSync(): void {
    if (!autoSync || autoSyncScheduled || closed || client === undefined) {
      return;
    }
    autoSyncScheduled = true;
    setTimeout(
      () => {
        autoSyncScheduled = false;
        if (closed || client === undefined) return;
        const running = client;
        void serializedSync(() => running.syncUntilIdle())
          .then((summary) => {
            if (!closed)
              post({ t: 'event', event: { kind: 'synced', summary } });
          })
          .catch((error: unknown) => {
            if (!closed) {
              post({
                t: 'event',
                event: { kind: 'synced', error: toErrorShape(error) },
              });
            }
          });
      },
      Math.floor(Math.random() * wakeJitterMs),
    );
  }

  function requireClient(): SyncClient {
    if (client === undefined) {
      throw new ClientSyncError(
        WORKER_FAILED_CODE,
        'the worker received a call before init completed',
      );
    }
    return client;
  }

  function assertOnline(): void {
    if (offline) {
      throw new ClientSyncError(
        'sync.transport_failed',
        'the worker transport is offline (setOffline(true))',
        true,
      );
    }
  }

  function gateOffline<T>(inner: (request: T) => Promise<Uint8Array>) {
    return (request: T): Promise<Uint8Array> => {
      assertOnline();
      return inner(request);
    };
  }

  /** Offline gate that preserves the §5.4 `fetchUrl` capability marker. */
  function gateSegmentsOffline(inner: SegmentDownloader): SegmentDownloader {
    const fetchUrl = inner.fetchUrl;
    return Object.assign(gateOffline(inner), {
      ...(fetchUrl !== undefined
        ? {
            fetchUrl: (url: string) => {
              assertOnline();
              return fetchUrl(url);
            },
          }
        : {}),
    });
  }

  async function init(config: WorkerInitConfig): Promise<WorkerInitResult> {
    if (client !== undefined) {
      throw new ClientSyncError(
        WORKER_FAILED_CODE,
        'the worker is already initialized',
      );
    }
    autoSync = config.autoSync ?? true;
    wakeJitterMs = config.wakeJitterMs ?? 200;

    database =
      overrides.openDatabase !== undefined
        ? await overrides.openDatabase(config)
        : await defaultOpenDatabase(config);
    const transport = gateOffline(
      overrides.createTransport !== undefined
        ? overrides.createTransport(config)
        : httpSyncTransport(config.endpoints.syncUrl),
    );
    const segments =
      overrides.createSegments !== undefined
        ? overrides.createSegments(config)
        : config.endpoints.segmentsUrl !== undefined
          ? httpSegmentDownloader(config.endpoints.segmentsUrl)
          : undefined;
    // §5.9 blob transport: only when a blobs URL is configured.
    const blobs =
      config.endpoints.blobsUrl !== undefined
        ? httpBlobTransport(config.endpoints.blobsUrl)
        : undefined;

    // Realtime needs the (possibly persisted) clientId for the
    // `{clientId}` URL placeholder — start the client first, then attach
    // the connector through a mutable slot read at connect time.
    let realtimeConnector: RealtimeConnector | undefined;
    const started = new SyncClient({
      database,
      schema: config.schema,
      transport,
      ...(segments !== undefined
        ? { segments: gateSegmentsOffline(segments) }
        : {}),
      ...(blobs !== undefined ? { blobs } : {}),
      realtime: (handlers) => {
        if (offline) {
          throw new ClientSyncError(
            'sync.transport_failed',
            'the worker realtime channel is offline (setOffline(true))',
            true,
          );
        }
        if (realtimeConnector === undefined) {
          throw new ClientSyncError(
            'sync.invalid_request',
            'no realtime connector configured',
          );
        }
        return realtimeConnector(handlers);
      },
      ...(config.clientId !== undefined ? { clientId: config.clientId } : {}),
      ...(config.limits !== undefined ? { limits: config.limits } : {}),
      onSyncNeeded: (reason) => {
        post({ t: 'event', event: { kind: 'sync-needed', reason } });
        scheduleAutoSync();
      },
      onConflict: (conflict) => {
        post({ t: 'event', event: { kind: 'conflict', conflict } });
      },
      onUpgrading: (upgrading) => {
        // §7.4.5: surface the schema-bump reset + completion to the UI thread.
        post({ t: 'event', event: { kind: 'upgrading', upgrading } });
      },
      onPresence: (scopeKey) => {
        // §8.6: surface a presence change to the UI thread.
        post({ t: 'event', event: { kind: 'presence', scopeKey } });
      },
    });
    await started.start();
    realtimeConnector =
      overrides.createRealtime !== undefined
        ? overrides.createRealtime(config, started.clientId)
        : config.endpoints.realtimeUrl !== undefined
          ? webSocketRealtimeConnector(
              config.endpoints.realtimeUrl.replace(
                '{clientId}',
                encodeURIComponent(started.clientId),
              ),
            )
          : undefined;
    client = started;
    return { clientId: started.clientId };
  }

  const api: WorkerApi = {
    subscribe: (input) => requireClient().subscribe(input),
    unsubscribe: (id) => requireClient().unsubscribe(id),
    mutate: (mutations) => requireClient().mutate(mutations),
    sync: () => {
      const running = requireClient();
      return serializedSync(() => running.sync());
    },
    syncUntilIdle: (maxRounds) => {
      const running = requireClient();
      return serializedSync(() => running.syncUntilIdle(maxRounds));
    },
    query: (sql, params) => requireClient().query(sql, params),
    conflicts: () => requireClient().conflicts,
    rejections: () => requireClient().rejections,
    schemaFloor: () => requireClient().schemaFloor,
    leaseState: () => requireClient().leaseState,
    upgrading: () => requireClient().upgrading,
    syncNeeded: () => requireClient().syncNeeded,
    pendingCommits: () => requireClient().pendingCommits(),
    subscriptions: () => requireClient().subscriptions(),
    subscription: (id) => requireClient().subscription(id),
    connectRealtime: () => requireClient().connectRealtime(),
    disconnectRealtime: () => requireClient().disconnectRealtime(),
    setPresence: (scopeKey, doc) => requireClient().setPresence(scopeKey, doc),
    presence: (scopeKey) => requireClient().presence(scopeKey),
    uploadBlob: (bytes, options) => requireClient().uploadBlob(bytes, options),
    fetchBlob: (blobIdOrRef) => requireClient().fetchBlob(blobIdOrRef),
    setOffline: (value) => {
      offline = value;
      if (offline) client?.disconnectRealtime();
    },
    close: async () => {
      closed = true;
      await client?.close();
      database?.close();
      client = undefined;
      database = undefined;
    },
  };

  async function dispatch(message: WorkerCallMessage): Promise<unknown> {
    const method = api[message.method] as (...args: unknown[]) => unknown;
    return await method.apply(api, message.args as unknown[]);
  }

  function run(
    id: number,
    fn: () => Promise<unknown>,
    transfer?: (value: unknown) => Transferable[],
  ): void {
    void (async () => {
      try {
        const value = await fn();
        post(
          { t: 'result', id, value },
          transfer !== undefined ? transfer(value) : undefined,
        );
      } catch (error) {
        post({ t: 'error', id, error: toErrorShape(error) });
      }
    })();
  }

  scope.addEventListener('message', (event) => {
    const message = event.data as MainToWorkerMessage;
    if (message.t === 'init') {
      run(message.id, () => init(message.config));
      return;
    }
    if (message.t === 'call') {
      run(
        message.id,
        () => dispatch(message),
        message.method === 'query'
          ? (value) => queryTransferables(value as readonly unknown[])
          : undefined,
      );
    }
  });

  post({ t: 'ready' });
}

async function defaultOpenDatabase(
  config: WorkerInitConfig,
): Promise<ClientDatabase> {
  if (config.database.mode !== 'persistent') {
    throw new ClientSyncError(
      WORKER_FAILED_CODE,
      "database mode 'custom' requires an openDatabase override in the " +
        'worker bootstrap (startSyncWorker({ openDatabase }))',
    );
  }
  return openPersistentWasmDatabase(config.database.name, {
    ...(config.database.directory !== undefined
      ? { directory: config.database.directory }
      : {}),
  });
}
