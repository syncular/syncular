/**
 * @syncular/react-native — the JS bridge to the native syncular core running
 * over the FFI (the same C ABI Swift/Kotlin wrap). RN's Hermes runtime has no
 * OPFS / sqlite-wasm, so the persistent path is the NATIVE core: `rusqlite` on
 * the device filesystem, HTTP+WS owned in Rust.
 *
 * This module is the React Native host of the shared native command bridge
 * (`@syncular/client/native-bridge`, which `@syncular/tauri` also uses), so
 * `@syncular/react` hooks (`useRawSql`, `useMutation`, `usePresence`, …) work
 * unchanged in a React Native app.
 *
 * Every method forwards to the TurboModule's `command` (the whole command
 * surface in one `{method, params}` envelope); `query` uses the `query` fast
 * path. Exact revisioned `change` batches and `presence` events arrive on the
 * `syncular::event` NativeEventEmitter topic. The bridge never reconstructs
 * changes from counters.
 *
 * The native module is INJECTABLE (`createNativeSyncClient({ nativeModule })`),
 * so the bridge is unit-tested with a NativeModule double and never needs a
 * device. In an app it auto-resolves the codegen module from `NativeSyncular`.
 */
import type { SecurityLifecycle } from '@syncular/client';
import {
  NativeBridgeClient,
  type NativeCreateConfig,
  type NativeReply,
  NativeSyncError,
  nativeCreateParams,
  type SyncularEvent,
} from '@syncular/client/native-bridge';

export {
  type BytesEnvelope,
  NativeSyncError,
  type SyncularEvent,
  unitId,
  type UnitScopes,
} from '@syncular/client/native-bridge';

/**
 * The native surface the bridge needs — the TurboModule `Spec`, minus the RN
 * codegen decorations, so tests can inject a plain double. Payloads are JSON
 * STRINGS (the C ABI shape); the bridge parses/stringifies.
 */
export interface SyncularNativeModule {
  create(configJson: string, createJson: string): Promise<string>;
  command(commandJson: string): Promise<string>;
  query(sql: string, paramsJson: string): Promise<string>;
  close(): Promise<void>;
  startEvents(): void;
  stopEvents(): void;
}

/** A minimal event-emitter surface (RN's `NativeEventEmitter` satisfies it). */
export interface SyncularEventEmitter {
  addListener(
    eventName: string,
    /** The native modules deliver the FFI event as its JSON string. */
    handler: (payload: string | SyncularEvent) => void,
  ): { remove(): void };
}

/** The native event topic — mirror of the iOS/Android shims. */
export const SYNCULAR_EVENT = 'syncular::event';

/** Config for {@link createNativeSyncClient}. */
export interface NativeSyncClientConfig extends NativeCreateConfig {
  /** Base URL of the sync server mount (engages the native transport). */
  readonly baseUrl?: string;
  /**
   * SPEC §12 local authority: path of the authority's own SQLite file (never
   * `dbPath`). Rounds go to the in-process authority until
   * `attachLocalAuthority()` completes, then to `baseUrl`. Requires `baseUrl`
   * for the attach.
   */
  readonly localAuthorityPath?: string;
  /** On-disk SQLite path; the native side may override with an app-data path. */
  readonly dbPath?: string;
  /** Extra transport headers (auth, tenant, …). */
  readonly headers?: Record<string, string>;
  /** Silence bound for one HTTP request, in milliseconds: no step or wait between body bytes may exceed it. */
  readonly requestTimeoutMs?: number;
  /** One monotonic deadline for the total time of a sync round, in milliseconds; it also fails a slow transfer that is still progressing. */
  readonly roundDeadlineMs?: number;
  /** Largest HTTP request body the transport sends, in bytes. */
  readonly maxRequestBytes?: number;
  /** Largest decoded HTTP response body the transport accepts, in bytes. */
  readonly maxResponseBytes?: number;
  /** Redirect handling: `"deny"` (the default) or `"follow"`. */
  readonly redirects?: 'deny' | 'follow';
  /** Interval the server sends realtime heartbeats at, in milliseconds (default 30000). The transport treats twice this interval of silence as a lost socket. */
  readonly realtimeHeartbeatMs?: number;
  /** Consume explicit core sync intents on the JS event loop. Default true. */
  readonly autoSync?: boolean;
  /**
   * The native module + event emitter. Omit in an app to auto-resolve the
   * codegen `NativeSyncular` module and construct a `NativeEventEmitter` over
   * it; inject in tests.
   */
  readonly nativeModule?: SyncularNativeModule;
  readonly eventEmitter?: SyncularEventEmitter;
}

/** SPEC §12.3 local-authority state. */
export type LocalAuthorityState = 'local' | 'attaching' | 'attached';

/** Resolve the native module + event emitter from the RN runtime when not injected. */
function resolveNative(config: NativeSyncClientConfig): {
  nativeModule: SyncularNativeModule;
  eventEmitter: SyncularEventEmitter;
} {
  if (config.nativeModule && config.eventEmitter) {
    return {
      nativeModule: config.nativeModule,
      eventEmitter: config.eventEmitter,
    };
  }
  // App path: pull the codegen module and build a NativeEventEmitter over it.
  // Imported indirectly so this file typechecks/tests without `react-native`
  // installed (the double path never touches these requires).
  const rn = requireReactNative();
  const nativeModule = config.nativeModule ?? requireNativeSyncular();
  const eventEmitter =
    config.eventEmitter ?? new rn.NativeEventEmitter(nativeModule);
  return { nativeModule, eventEmitter };
}

// Indirected requires so bundlers/tests don't hard-resolve `react-native` when
// the caller injects doubles. These throw a clear message if reached without RN.
function requireReactNative(): {
  NativeEventEmitter: new (module?: unknown) => SyncularEventEmitter;
} {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('react-native');
  } catch {
    throw new Error(
      'react-native is not available; inject { nativeModule, eventEmitter } ' +
        'in non-RN environments (e.g. tests).',
    );
  }
}

function requireNativeSyncular(): SyncularNativeModule {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('./NativeSyncular').default;
}

/** The RN-side proxy implementing `SyncClientLike` over the TurboModule. */
export class NativeSyncClient extends NativeBridgeClient {
  readonly #native: SyncularNativeModule;
  readonly #autoSync: boolean;
  #paused = false;
  #syncScheduled = false;
  #syncRunning = false;
  #syncAgain = false;
  #retryAt: number | undefined;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;

  /** @internal — use {@link createNativeSyncClient}. */
  constructor(
    native: SyncularNativeModule,
    subscription: { remove(): void },
    autoSync: boolean,
    securityLifecycle: SecurityLifecycle = 'active',
  ) {
    super(
      'react-native',
      NativeSyncError,
      () => subscription.remove(),
      securityLifecycle,
    );
    this.#native = native;
    this.#autoSync = autoSync;
  }

  protected override async send(
    method: string,
    params: Record<string, unknown>,
  ): Promise<NativeReply> {
    return JSON.parse(
      await this.#native.command(JSON.stringify({ method, params })),
    );
  }

  protected override async sendQuery(
    sql: string,
    params: unknown,
  ): Promise<NativeReply> {
    return JSON.parse(await this.#native.query(sql, JSON.stringify(params)));
  }

  protected override sendQuerySnapshot(
    params: Record<string, unknown>,
  ): Promise<NativeReply> {
    return this.send('querySnapshot', params);
  }

  protected override sendHeaders(
    headers: Readonly<Record<string, string>>,
  ): Promise<NativeReply> {
    return this.send('setHeaders', { headers });
  }

  protected override shutdown(): Promise<void> {
    this.#clearRetry();
    this.#native.stopEvents();
    return this.#native.close();
  }

  protected override allowPreflightCommand(method: string): boolean {
    return method === 'localAuthorityState';
  }

  /** @internal — fan an incoming native event out to the local listeners. */
  override __dispatchEvent(event: SyncularEvent): void {
    if (event.type === 'realtime-wake') {
      // The core buffered inbound realtime traffic; this command applies it
      // and queues the resulting change/presence/sync-intent events.
      if (!this.closed) void this.command('drainRealtime', {});
    } else if (event.type !== 'sync-intent') {
      super.__dispatchEvent(event);
    } else if (this.#autoSync) {
      const intent =
        event.intent !== null && typeof event.intent === 'object'
          ? (event.intent as Record<string, unknown>)
          : undefined;
      if (intent?.kind === 'interactive') {
        this.#requestAutoSync();
      } else if (
        intent?.kind === 'background' &&
        typeof intent.delayMs === 'number' &&
        Number.isFinite(intent.delayMs)
      ) {
        this.#requestBackgroundSync(Math.max(0, intent.delayMs));
      }
    }
  }

  #clearRetry(): void {
    if (this.#retryTimer !== undefined) clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
    this.#retryAt = undefined;
  }

  #requestAutoSync(): void {
    if (this.closed || this.#paused || this.preflight) return;
    this.#clearRetry();
    if (this.#syncRunning) {
      this.#syncAgain = true;
      return;
    }
    if (this.#syncScheduled) return;
    this.#syncScheduled = true;
    queueMicrotask(() => {
      this.#syncScheduled = false;
      void this.#runAutoSync();
    });
  }

  #requestBackgroundSync(delayMs: number): void {
    if (this.closed || this.#paused || this.preflight) return;
    const deadline = Date.now() + delayMs;
    if (this.#retryAt !== undefined && this.#retryAt <= deadline) return;
    this.#clearRetry();
    this.#retryAt = deadline;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      this.#retryAt = undefined;
      this.#requestAutoSync();
    }, delayMs);
  }

  async #runAutoSync(): Promise<void> {
    if (this.closed || this.#paused || this.#syncRunning) return;
    this.#syncRunning = true;
    try {
      await this.syncUntilIdle();
    } catch {
      // The core emits an explicit background intent for retryable failures;
      // non-retryable outcomes remain visible through status/change state.
    } finally {
      this.#syncRunning = false;
      if (this.#syncAgain) {
        this.#syncAgain = false;
        this.#requestAutoSync();
      }
    }
  }

  override beginSecurityPreflight(): Promise<void> {
    this.#clearRetry();
    this.#syncScheduled = false;
    this.#syncAgain = false;
    return super.beginSecurityPreflight();
  }

  /**
   * SPEC §12.3 local-authority state; `null` when the client has no
   * `localAuthorityPath`.
   */
  async localAuthorityState(): Promise<LocalAuthorityState | null> {
    const result = (await this.command('localAuthorityState', {})) as {
      state: LocalAuthorityState | null;
    };
    return result.state;
  }

  /**
   * SPEC §12.3: upload the local authority's rows to `baseUrl` with the
   * headers set through `setHeaders`, then sync with that server. Rejects with
   * `sync.attach_rejected` (`details.reason`) when the server refuses an upload
   * commit, and with `client.local_authority_unconfigured` without a
   * `localAuthorityPath` or `baseUrl`.
   */
  async attachLocalAuthority(): Promise<void> {
    await this.command('attachLocalAuthority', {});
  }

  /** SPEC §12.3: delete the rows a stopped attach uploaded, then sync locally. */
  async abandonLocalAuthorityAttach(): Promise<void> {
    await this.command('abandonLocalAuthorityAttach', {});
  }

  /**
   * Pause background activity — stop the native event pump and disconnect
   * realtime. Call from `AppState` `'background'`. The database and outbox are
   * intact; mutations still queue offline. {@link resume} restarts them.
   */
  async pause(): Promise<void> {
    this.#paused = true;
    this.#clearRetry();
    this.#native.stopEvents();
    try {
      await this.disconnectRealtime();
    } catch {
      /* lean/offline core has no socket */
    }
  }

  /** Resume after {@link pause} — reconnect realtime and restart the pump. */
  async resume(): Promise<void> {
    try {
      await this.connectRealtime();
    } catch {
      /* lean/offline core */
    }
    this.#paused = false;
    this.#native.startEvents();
    if (this.#autoSync) this.#requestAutoSync();
  }
}

/**
 * Construct the bridge and issue the native `create` (opening the file DB on
 * the Rust side). Returns a ready `NativeSyncClient` satisfying `SyncClientLike`
 * — pass it straight to the React `<SyncProvider client={…}>`.
 */
export async function createNativeSyncClient(
  config: NativeSyncClientConfig,
): Promise<NativeSyncClient> {
  const createParams = {
    ...nativeCreateParams(config, NativeSyncError),
    ...(config.dbPath !== undefined ? { dbPath: config.dbPath } : {}),
  };
  const transportConfig = {
    ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
    ...(config.localAuthorityPath !== undefined
      ? { localAuthorityPath: config.localAuthorityPath }
      : {}),
    ...(config.headers !== undefined ? { headers: config.headers } : {}),
    ...(config.requestTimeoutMs !== undefined
      ? { requestTimeoutMs: config.requestTimeoutMs }
      : {}),
    ...(config.roundDeadlineMs !== undefined
      ? { roundDeadlineMs: config.roundDeadlineMs }
      : {}),
    ...(config.maxRequestBytes !== undefined
      ? { maxRequestBytes: config.maxRequestBytes }
      : {}),
    ...(config.maxResponseBytes !== undefined
      ? { maxResponseBytes: config.maxResponseBytes }
      : {}),
    ...(config.redirects !== undefined ? { redirects: config.redirects } : {}),
    ...(config.realtimeHeartbeatMs !== undefined
      ? { realtimeHeartbeatMs: config.realtimeHeartbeatMs }
      : {}),
  };
  const { nativeModule, eventEmitter } = resolveNative(config);

  // Wire the event stream BEFORE create so no early change batch is missed.
  let client: NativeSyncClient | undefined;
  const subscription = eventEmitter.addListener(SYNCULAR_EVENT, (payload) =>
    client?.__dispatchEvent(
      typeof payload === 'string'
        ? (JSON.parse(payload) as SyncularEvent)
        : payload,
    ),
  );
  client = new NativeSyncClient(
    nativeModule,
    subscription,
    config.autoSync ?? true,
    config.securityPreflight === true ? 'preflight' : 'active',
  );
  await client.__open(async () =>
    JSON.parse(
      await nativeModule.create(
        JSON.stringify(transportConfig),
        JSON.stringify(createParams),
      ),
    ),
  );

  // Begin pumping poll_event → native event emitter.
  nativeModule.startEvents();
  return client;
}
