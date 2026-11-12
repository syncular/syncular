/**
 * Worker-side bootstrap: constructs the WHOLE
 * client core — SyncClient + transports + realtime + SQLite — inside the
 * worker and serves the `worker-protocol` RPC over postMessage.
 *
 * Browsers get the defaults: opfs-sahpool persistence and the fetch/WS
 * transports from `./http`, wired from `WorkerInitConfig.endpoints`.
 * Tests inject a database factory (bun:sqlite) through `overrides` — the
 * same bootstrap, the same RPC, a different SQLite.
 *
 * The §8.4 host loop lives HERE: wake-ups (hello/`sync` events, delta
 * drops) coalesce into one intent-driven `syncUntilIdle` round in the worker;
 * RPC-driven and auto-driven sync rounds serialize on one queue because
 * the core owns exactly one loop.
 */
import type { defineAuthorityReads } from './authority';
import { SyncClient } from './client';
import type { ClientDatabase } from './database';
import {
  type ClientDiagnosticsSnapshot,
  withClientDiagnosticsHost,
} from './diagnostics';
import { encryptionConfigFromKeyring } from './encryption';
import {
  ClientSyncError,
  invalidRequest,
  STORAGE_BUSY_CODE,
  toErrorShape,
} from './errors';
import {
  httpBlobTransport,
  httpSegmentDownloader,
  httpSyncTransport,
  webSocketRealtimeConnector,
} from './http';
import type { SyncIntent } from './invalidation';
import type {
  RealtimeConnector,
  SegmentDownloader,
  SyncTransport,
} from './transport';
import type { ClientSchema } from './schema';
import { openPersistentWasmDatabase } from './wasm-database';
import {
  LOCAL_AUTHORITY_UNCONFIGURED_CODE,
  type LocalAuthorityState,
  type MainToWorkerMessage,
  WORKER_FAILED_CODE,
  WORKER_METHOD_UNAVAILABLE_CODE,
  type WorkerApi,
  type SyncWorkerEvent,
  type WorkerCallMessage,
  type WorkerInitConfig,
  type WorkerInitResult,
  type WorkerMethod,
  type WorkerToMainMessage,
} from './worker-protocol';

export interface SyncWorkerOverrides {
  /** Explicit authority reader factory. Required when init declares authorityReads. */
  readonly createAuthorityReads?: typeof defineAuthorityReads;
  /** Database factory indirection: tests inject bun:sqlite here. */
  readonly openDatabase?: (
    config: WorkerInitConfig,
  ) => Promise<ClientDatabase> | ClientDatabase;
  /** Retry deadline indirection for deterministic worker-host tests. */
  readonly waitForStorageRetry?: (delayMs: number) => Promise<void>;
  /**
   * Timer indirection for deterministic worker-host tests: background-intent
   * deadlines and the client's §8.5 heartbeat watchdog.
   */
  readonly scheduleBackground?: (
    callback: () => void,
    delayMs: number,
  ) => () => void;
  /** `http` reads the current host auth set, as the default transport does. */
  readonly createTransport?: (
    config: WorkerInitConfig,
    http: { readonly headers: () => Readonly<Record<string, string>> },
  ) => SyncTransport;
  readonly createSegments?: (
    config: WorkerInitConfig,
  ) => SegmentDownloader | undefined;
  /**
   * Custom realtime connector, e.g. one that mints a fresh ticket per
   * connection attempt. `headers` reads the current host auth set.
   */
  readonly createRealtime?: (
    config: WorkerInitConfig,
    clientId: string,
    headers: () => Readonly<Record<string, string>>,
  ) => RealtimeConnector | undefined;
  /**
   * SPEC §12 local authority, required by init's `localAuthority: true`:
   * `(database, schema) => openLocalAuthority({ database:
   * clientSqliteDatabase(database), schema })` from `@syncular/server`. Only
   * a worker entry that passes it bundles the server code.
   */
  readonly openLocalAuthority?: (
    database: ClientDatabase,
    schema: ClientSchema,
  ) => Promise<WorkerLocalAuthority>;
}

/** The `LocalAuthority` surface of `@syncular/server` the worker drives (§12). */
export interface WorkerLocalAuthority {
  readonly state: LocalAuthorityState;
  readonly sync: SyncTransport;
  readonly downloadSegment: SegmentDownloader;
  readonly attach: (transport: SyncTransport) => Promise<void>;
  readonly abandonAttach: (transport?: SyncTransport) => Promise<void>;
}

type LocalAuthorityMethod =
  | 'localAuthorityState'
  | 'attachLocalAuthority'
  | 'abandonLocalAuthorityAttach';

/** @internal Optional §12 behavior supplied by the authority-enabled entry. */
interface WorkerLocalAuthorityExtension {
  readonly methods: Pick<WorkerApi, LocalAuthorityMethod>;
  open(
    config: WorkerInitConfig,
    database: ClientDatabase,
    remote: SyncTransport,
    segments: SegmentDownloader | undefined,
  ): Promise<{
    readonly transport: SyncTransport;
    readonly segments: SegmentDownloader | undefined;
  }>;
  active(): boolean;
  close(): void;
}

/** @internal Dependencies shared with the worker's single sync loop. */
export type WorkerLocalAuthorityFactory = (context: {
  readonly overrides: SyncWorkerOverrides;
  readonly requireClient: () => SyncClient;
  readonly serializedSync: <T>(run: () => Promise<T>) => Promise<T>;
  readonly isOffline: () => boolean;
  readonly wake: () => void;
}) => WorkerLocalAuthorityExtension;

/** Minimal structural view of the dedicated-worker global scope. */
interface WorkerScope {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent) => void,
  ): void;
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
export function startSyncWorkerCore(
  overrides: SyncWorkerOverrides,
  createLocalAuthority?: WorkerLocalAuthorityFactory,
): void {
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
  let headers: Readonly<Record<string, string>> = {};
  let closed = false;
  // Every worker event goes through here; a closed worker posts none.
  const emit = (event: SyncWorkerEvent): void => {
    if (!closed) post({ t: 'event', event });
  };
  let pushingDiagnostics = false;

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

  /**
   * One drive to idle, automatic or requested: its end reaches every tab.
   * The event is posted inside the serialized step, so the drive settles
   * before the next queued drive starts, as without it.
   */
  function drive(
    run: () => ReturnType<SyncClient['syncUntilIdle']>,
  ): ReturnType<SyncClient['syncUntilIdle']> {
    return serializedSync(() =>
      run().then(
        (summary) => (emit({ kind: 'synced', summary }), summary),
        (error: unknown) => {
          emit({ kind: 'synced', error: toErrorShape(error) });
          throw error;
        },
      ),
    );
  }

  // -- SPEC §7.5 host loop: event-driven intents, no interactive polling --
  let autoSync = true;
  let autoSyncScheduled = false;
  let cancelBackground: (() => void) | undefined;
  let backgroundDue = Number.POSITIVE_INFINITY;
  // §7.7 backoff for drives that end without a client retry intent.
  let retryDelayMs = 250;
  const scheduleBackground =
    overrides.scheduleBackground ??
    ((callback: () => void, delayMs: number): (() => void) => {
      const timer = setTimeout(callback, delayMs);
      return () => clearTimeout(timer);
    });

  const workerDiagnostics = (snapshot: ClientDiagnosticsSnapshot) =>
    withClientDiagnosticsHost(snapshot, {
      kind: 'worker',
      role: 'leader',
      connectivity: offline ? 'offline' : snapshot.host.connectivity,
      realtime: snapshot.host.realtime,
    });
  const postDiagnostics = (snapshot: ClientDiagnosticsSnapshot): void =>
    emit({ kind: 'diagnostics', snapshot: workerDiagnostics(snapshot) });

  function runAutoSync(): void {
    if (
      closed ||
      client === undefined ||
      offline ||
      client.securityLifecycle() === 'preflight'
    ) {
      autoSyncScheduled = false;
      return;
    }
    const running = client;
    void drive(() => {
      // The queued round owns the flag from here. Clearing it at entry would
      // let every wake-up that arrives while this round waits behind the
      // running one queue its own full drive (§8.4 coalescing).
      autoSyncScheduled = false;
      return running.syncUntilIdle();
    })
      .then((summary) => {
        retryDelayMs = 250;
        if (summary.budgetExhausted) consumeSyncIntent({ kind: 'interactive' });
      })
      .catch((error: unknown) => {
        if (closed) return;
        // §7.8: a retryable drive rejection owes another drive. A retryable
        // round failure already handed this loop its background intent; the
        // drive deadline did not. An unreachable endpoint waits for the
        // host's connectivity resume (§1.8).
        const causeKind =
          error instanceof ClientSyncError
            ? error.details?.['causeKind']
            : undefined;
        if (
          error instanceof ClientSyncError &&
          error.retryable &&
          causeKind !== 'network' &&
          causeKind !== 'connect' &&
          cancelBackground === undefined &&
          !autoSyncScheduled
        ) {
          consumeSyncIntent({ kind: 'background', delayMs: retryDelayMs });
          retryDelayMs = Math.min(retryDelayMs * 2, 30_000);
        }
      });
  }

  function stopBackground(): void {
    cancelBackground?.();
    cancelBackground = undefined;
    backgroundDue = Number.POSITIVE_INFINITY;
  }

  function consumeSyncIntent(intent: SyncIntent): void {
    if (
      !autoSync ||
      closed ||
      client === undefined ||
      offline ||
      client.securityLifecycle() === 'preflight' ||
      intent.kind === 'none'
    ) {
      return;
    }
    if (intent.kind === 'background') {
      if (autoSyncScheduled) return;
      const due = Date.now() + Math.max(0, intent.delayMs);
      if (cancelBackground !== undefined && due >= backgroundDue) return;
      cancelBackground?.();
      backgroundDue = due;
      cancelBackground = scheduleBackground(
        () => {
          cancelBackground = undefined;
          backgroundDue = Number.POSITIVE_INFINITY;
          if (!autoSyncScheduled) {
            autoSyncScheduled = true;
            runAutoSync();
          }
        },
        Math.max(0, due - Date.now()),
      );
      return;
    }
    stopBackground();
    if (!autoSync || autoSyncScheduled || closed || client === undefined) {
      return;
    }
    autoSyncScheduled = true;
    queueMicrotask(runAutoSync);
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

  const local = createLocalAuthority?.({
    overrides,
    requireClient,
    serializedSync,
    isOffline: () => offline,
    wake: () => consumeSyncIntent({ kind: 'interactive' }),
  });

  async function init(config: WorkerInitConfig): Promise<WorkerInitResult> {
    if (config.localAuthority === true && local === undefined)
      throw new ClientSyncError(
        LOCAL_AUTHORITY_UNCONFIGURED_CODE,
        'this worker does not support a local authority',
      );
    if (config.authorityReads !== undefined && !overrides.createAuthorityReads)
      throw new ClientSyncError(
        'client.authority_read_forbidden',
        'authorityReads requires startSyncWorker({ createAuthorityReads })',
      );
    if (client !== undefined) {
      throw new ClientSyncError(
        WORKER_FAILED_CODE,
        'the worker is already initialized',
      );
    }
    autoSync = config.autoSync ?? true;
    headers = config.headers ?? {};
    const http = { headers: () => headers };

    for (let attempt = 0; ; attempt++) {
      try {
        database =
          overrides.openDatabase !== undefined
            ? await overrides.openDatabase(config)
            : await defaultOpenDatabase(config);
        break;
      } catch (error) {
        if (
          config.database.mode !== 'persistent' ||
          !(error instanceof ClientSyncError) ||
          error.code !== STORAGE_BUSY_CODE ||
          !error.retryable ||
          attempt === 6
        ) {
          throw error;
        }
        // Retain the leader lease while the previous worker's OPFS handles
        // drain. Only opening is retried; core initialization has not started.
        const delayMs = Math.min(50 * 2 ** attempt, 1000);
        if (overrides.waitForStorageRetry !== undefined) {
          await overrides.waitForStorageRetry(delayMs);
        } else {
          await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        }
      }
    }
    const remote =
      overrides.createTransport !== undefined
        ? overrides.createTransport(config, http)
        : httpSyncTransport(config.endpoints.syncUrl, http);
    const remoteSegments =
      overrides.createSegments !== undefined
        ? overrides.createSegments(config)
        : config.endpoints.segmentsUrl !== undefined
          ? httpSegmentDownloader(config.endpoints.segmentsUrl, http)
          : undefined;
    const bindings =
      config.localAuthority === true && local !== undefined
        ? await local.open(config, database, remote, remoteSegments)
        : { transport: remote, segments: remoteSegments };
    // §5.9 blob transport: only when a blobs URL is configured.
    const blobs =
      config.endpoints.blobsUrl !== undefined
        ? httpBlobTransport(config.endpoints.blobsUrl, http)
        : undefined;

    // Realtime needs the (possibly persisted) clientId for the
    // `{clientId}` URL placeholder — start the client first, then attach
    // the connector through a mutable slot read at connect time.
    let realtimeConnector: RealtimeConnector | undefined;
    offline = config.transportEnabled === false;
    const started = new SyncClient({
      transportEnabled: !offline,
      database,
      schema: config.schema,
      transport: bindings.transport,
      ...(bindings.segments !== undefined
        ? { segments: bindings.segments }
        : {}),
      ...(blobs !== undefined ? { blobs } : {}),
      realtime: (handlers, clientId) => {
        // §12.2: a local authority has no realtime channel.
        if (realtimeConnector === undefined || local?.active()) {
          throw invalidRequest('no realtime connector configured');
        }
        return realtimeConnector(handlers, clientId);
      },
      ...(config.clientId !== undefined ? { clientId: config.clientId } : {}),
      ...(config.limits !== undefined ? { limits: config.limits } : {}),
      ...(config.retainFailedCommits !== undefined
        ? { retainFailedCommits: config.retainFailedCommits }
        : {}),
      ...(config.realtimePolicy !== undefined
        ? { realtimePolicy: config.realtimePolicy }
        : {}),
      ...(config.realtimeHeartbeatMs !== undefined
        ? { realtimeHeartbeatMs: config.realtimeHeartbeatMs }
        : {}),
      schedule: scheduleBackground,
      ...(config.encryption !== undefined
        ? { encryption: encryptionConfigFromKeyring(config.encryption) }
        : {}),
      ...(config.authorityReads !== undefined
        ? {
            authorityReads: overrides.createAuthorityReads!(
              config.authorityReads,
            ),
          }
        : {}),
      ...(config.securityPreflight !== undefined
        ? { securityPreflight: config.securityPreflight }
        : {}),
      ...(config.previousVersionContext !== undefined
        ? { previousVersionContext: config.previousVersionContext }
        : {}),
      onSyncNeeded: (reason) => {
        emit({ kind: 'sync-needed', reason });
        consumeSyncIntent({ kind: 'interactive' });
      },
      onSyncIntent: consumeSyncIntent,
      onConflict: (conflict) => {
        emit({ kind: 'conflict', conflict });
      },
      onUpgrading: (upgrading) => {
        // §7.4.5: surface the schema-bump reset + completion to the UI thread.
        emit({ kind: 'upgrading', upgrading });
      },
      onPresence: (scopeKey, error) => {
        // §8.6: surface a presence change or rejection to the UI thread.
        emit({ kind: 'presence', scopeKey, error });
      },
    });
    started.onProgress((progress) => {
      emit({ kind: 'progress', progress });
    });
    started.onChange((batch) => {
      emit({ kind: 'change', batch });
    });
    await started.start();
    realtimeConnector =
      overrides.createRealtime !== undefined
        ? overrides.createRealtime(config, started.clientId, http.headers)
        : config.endpoints.realtimeUrl !== undefined
          ? webSocketRealtimeConnector(config.endpoints.realtimeUrl)
          : undefined;
    client = started;
    // `start()` may discover persisted subscriptions/outbox work. Its callback
    // fires before this worker publishes the initialized client, so consume
    // the durable state once here as well; coalescing makes this a single task.
    if (started.statusSnapshot().syncNeeded)
      consumeSyncIntent({ kind: 'interactive' });
    return { clientId: started.clientId };
  }

  // Forward every argument to core methods, including authority's zero-argument check.
  const coreMethods = [
    'securityLifecycle',
    'subscribe',
    'subscribeMany',
    'unsubscribe',
    'windowState',
    'purgeLocalData',
    'rebootstrapLocalData',
    'previousVersionSnapshot',
    'previousVersionAudit',
    'previousVersionDiscard',
    'query',
    'authoritySnapshot',
    'querySnapshot',
    'snapshotRead',
    'statusSnapshot',
    'conflicts',
    'rejections',
    'commitOutcome',
    'commitOutcomes',
    'resolveCommitOutcome',
    'pendingCommits',
    'units',
    'unit',
    'connectRealtime',
    'disconnectRealtime',
    'setPresence',
    'presence',
    'uploadBlob',
    'fetchBlob',
  ] as const satisfies readonly (keyof WorkerApi & keyof SyncClient)[];
  const api: Omit<WorkerApi, LocalAuthorityMethod> & Partial<WorkerApi> = {
    ...(Object.fromEntries(
      coreMethods.map((method) => [
        method,
        (...args: unknown[]) => {
          const running = requireClient();
          return Reflect.apply(running[method], running, args);
        },
      ]),
    ) as Pick<WorkerApi, (typeof coreMethods)[number]>),
    beginSecurityPreflight: async () => {
      stopBackground();
      autoSyncScheduled = false;
      await requireClient().beginSecurityPreflight();
    },
    activateSecurity: async (options = {}) => {
      await requireClient().activateSecurity({
        ...(options.encryption !== undefined
          ? { encryption: encryptionConfigFromKeyring(options.encryption) }
          : {}),
      });
    },
    setWindow: async (base, units) => {
      await requireClient().setWindowCommand(base, units);
    },
    mutate: (mutations) => {
      return requireClient().mutateCommand(mutations).value;
    },
    patch: (table, rowId, partial, options) => {
      // Same §8.4 rule as `mutate`: a local write must push without the app
      // orchestrating sync, so consume the core's immediate intent.
      const result = requireClient().patchCommand(
        table,
        rowId,
        partial,
        options,
      );
      return result.value;
    },
    sync: () => {
      const running = requireClient();
      return serializedSync(() => running.sync());
    },
    syncUntilIdle: (options) => {
      const running = requireClient();
      return drive(() => running.syncUntilIdle(options));
    },
    proveCurrentBase: (outcome, options) => {
      const running = requireClient();
      return serializedSync(() => running.proveCurrentBase(outcome, options));
    },
    resetClientId: () => requireClient().resetClientId(),
    localRevision: () => requireClient().localRevision,
    diagnosticsSnapshot: () => {
      const running = requireClient();
      // The first pull makes the worker a push source: no tab has asked for
      // diagnostics before it, so no snapshot is built per revision until then.
      if (!pushingDiagnostics) {
        pushingDiagnostics = true;
        running.onDiagnostics(postDiagnostics);
      }
      return workerDiagnostics(running.diagnosticsSnapshot());
    },
    setHeaders: (next) => {
      headers = next;
    },
    setOffline: (value) => {
      offline = value;
      requireClient().setTransportEnabled(!value);
      if (offline) {
        stopBackground();
      } else if (client !== undefined && pushingDiagnostics) {
        postDiagnostics(client.diagnosticsSnapshot());
      }
    },
    ...local?.methods,
    close: async () => {
      closed = true;
      cancelBackground?.();
      await client?.close();
      local?.close();
      database?.close();
      client = undefined;
      database = undefined;
    },
  };

  // Local purge/rebootstrap/discard rewrite the same durable state an
  // in-flight sync round captured at send time, and the RFC 0005 reads observe
  // (and can themselves trigger the discard of) that same previous-version
  // container. Running all of them on the sync chain orders them against RPC-
  // and auto-driven rounds (the client core's reset fence covers hosts that
  // call the core directly).
  const syncChainMethods: ReadonlySet<WorkerMethod> = new Set<WorkerMethod>([
    'purgeLocalData',
    'rebootstrapLocalData',
    'previousVersionSnapshot',
    'previousVersionAudit',
    'previousVersionDiscard',
  ]);

  async function dispatch(message: WorkerCallMessage): Promise<unknown> {
    const method = api[message.method] as
      | ((...args: unknown[]) => unknown)
      | undefined;
    if (!Object.hasOwn(api, message.method) || typeof method !== 'function')
      throw new ClientSyncError(
        WORKER_METHOD_UNAVAILABLE_CODE,
        'the worker method is not configured',
      );
    const invoke = () => Reflect.apply(method, api, message.args);
    if (syncChainMethods.has(message.method)) {
      return await serializedSync(async () => invoke());
    }
    return await invoke();
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
          : message.method === 'querySnapshot'
            ? (value) =>
                queryTransferables(
                  (value as { readonly rows: readonly unknown[] }).rows,
                )
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
      "database mode 'custom' requires startSyncWorker({ openDatabase })",
    );
  }
  return openPersistentWasmDatabase(config.database.name, {
    ...(config.database.directory !== undefined
      ? { directory: config.database.directory }
      : {}),
    ...(config.takeOverStorage === true ? { takeOver: true } : {}),
  });
}
