/**
 * @syncular/react-native — the JS bridge to the native syncular core running
 * over the FFI (the same C ABI Swift/Kotlin wrap). RN's Hermes runtime has no
 * OPFS / sqlite-wasm, so the persistent path is the NATIVE core (decided in
 * ROADMAP block 1) — `rusqlite` on the device filesystem, HTTP+WS owned in Rust.
 *
 * This module is the webview-equivalent of `@syncular/tauri`: a thin JS proxy
 * that implements the SAME `SyncClientLike` interface the React package
 * normalizes, so `@syncular/react` hooks (`useRawSql`, `useMutation`,
 * `usePresence`, …) work UNCHANGED in a React Native app. It is the fifth host
 * of one interface, after direct / worker-leader / multi-tab follower / Tauri.
 *
 * Every method forwards to the TurboModule's `command` (the whole command
 * surface in one JSON envelope — `{method, params}`); `query` uses the `query`
 * fast path. Client-observable events (`invalidate` / `presence` / `sync-needed`
 * / `conflict` / …) arrive on the `syncular::event` NativeEventEmitter topic and
 * fan out to the registered listeners.
 *
 * Bytes cross as the established `{$bytes:hex}` envelope — the same convention
 * the Rust command router, the driver protocol, and the Tauri bridge use.
 *
 * The native module is INJECTABLE (`createNativeSyncClient({ nativeModule })`),
 * so the bridge is unit-tested with a NativeModule double and never needs a
 * device. In an app it auto-resolves the codegen module from `NativeSyncular`.
 */
import type {
  ConflictRecord,
  InvalidationEvent,
  InvalidationListener,
  LeaseState,
  MutationInput,
  PresencePeer,
  RejectionRecord,
  SchemaFloor,
  SqlRow,
  SqlValue,
  WindowBase,
  WindowState,
} from '@syncular/client';

/** A driver-protocol reply: `{result}` on success or `{error}` on failure. */
interface CommandReply {
  readonly result?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
}

/** One event pushed on the native event topic (the derived observable set). */
export interface SyncularEvent {
  readonly type: string;
  readonly [key: string]: unknown;
}

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
    handler: (payload: SyncularEvent) => void,
  ): { remove(): void };
}

/** The native event topic — mirror of the iOS/Android shims. */
export const SYNCULAR_EVENT = 'syncular::event';

/** Config for {@link createNativeSyncClient}. */
export interface NativeSyncClientConfig {
  /** The generated schema JSON (the app passes `schema` from typegen). */
  readonly schema: unknown;
  /** Stable per-device/actor client id (reuse across launches). */
  readonly clientId: string;
  /** §4.2 client limits, forwarded to the native `create`. */
  readonly limits?: Record<string, unknown>;
  /** Base URL of the sync server mount (engages the native transport). */
  readonly baseUrl?: string;
  /** On-disk SQLite path; the native side may override with an app-data path. */
  readonly dbPath?: string;
  /** Extra transport headers (auth, tenant, …). */
  readonly headers?: Record<string, string>;
  /**
   * The native module + event emitter. Omit in an app to auto-resolve the
   * codegen `NativeSyncular` module and construct a `NativeEventEmitter` over
   * it; inject in tests.
   */
  readonly nativeModule?: SyncularNativeModule;
  readonly eventEmitter?: SyncularEventEmitter;
}

/** The bytes envelope both sides share. */
export type BytesEnvelope = { readonly $bytes: string };

function isBytesEnvelope(value: unknown): value is BytesEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { $bytes?: unknown }).$bytes === 'string'
  );
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.length % 2 === 0 ? hex : `0${hex}`;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Encode an SQL param for the command JSON (bytes → `{$bytes:hex}`). */
function encodeParam(value: SqlValue): unknown {
  if (value instanceof Uint8Array) return { $bytes: bytesToHex(value) };
  if (typeof value === 'bigint') return Number(value);
  return value;
}

/** Decode one query-result cell back to an `SqlValue` (`{$bytes}` → bytes). */
function decodeCell(value: unknown): SqlValue {
  if (isBytesEnvelope(value)) return hexToBytes(value.$bytes);
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  return JSON.stringify(value);
}

function decodeRow(row: Record<string, unknown>): SqlRow {
  const out: SqlRow = {};
  for (const [key, value] of Object.entries(row)) out[key] = decodeCell(value);
  return out;
}

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
  const nativeModule =
    config.nativeModule ??
    (requireNativeSyncular() as unknown as SyncularNativeModule);
  const eventEmitter =
    config.eventEmitter ??
    (new rn.NativeEventEmitter(
      nativeModule as unknown as ConstructorParameters<
        typeof rn.NativeEventEmitter
      >[0],
    ) as SyncularEventEmitter);
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

function requireNativeSyncular(): unknown {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('./NativeSyncular').default;
}

/**
 * The RN-side proxy implementing `SyncClientLike` over the TurboModule. Every
 * method is a promise; the React `normalizeClient` wraps sync/async members
 * uniformly, so the hooks accept it directly.
 */
export class NativeSyncClient {
  readonly #native: SyncularNativeModule;
  readonly #invalidationListeners = new Set<InvalidationListener>();
  readonly #presenceListeners = new Set<(scopeKey: string) => void>();
  #subscription: { remove(): void } | undefined;
  #closed = false;

  /** @internal — use {@link createNativeSyncClient}. */
  constructor(native: SyncularNativeModule, subscription: { remove(): void }) {
    this.#native = native;
    this.#subscription = subscription;
  }

  /** Dispatch a `command` and unwrap `{result}` / throw on `{error}`. */
  async #command(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const replyJson = await this.#native.command(
      JSON.stringify({ method, params }),
    );
    const reply = JSON.parse(replyJson) as CommandReply;
    if (reply.error !== undefined) {
      throw new NativeSyncError(reply.error.code, reply.error.message);
    }
    return reply.result;
  }

  /** @internal — fan an incoming native event out to the local listeners. */
  __dispatchEvent(event: SyncularEvent): void {
    switch (event.type) {
      case 'invalidate': {
        const payload: InvalidationEvent = {
          tables: toStringSet(event.tables),
          scopeKeys: toStringSet(event.scopeKeys),
        };
        for (const listener of this.#invalidationListeners) {
          try {
            listener(payload);
          } catch {
            /* a UI listener must never break event dispatch */
          }
        }
        break;
      }
      case 'presence': {
        const scopeKey =
          typeof event.scopeKey === 'string' ? event.scopeKey : '';
        for (const listener of this.#presenceListeners) {
          try {
            listener(scopeKey);
          } catch {
            /* never break dispatch */
          }
        }
        break;
      }
      default:
        // sync-needed / conflict / rejection / schema-floor / lease: observable
        // via the accessor methods; nothing else to fan out here.
        break;
    }
  }

  // -- SyncClientLike ---------------------------------------------------------

  onInvalidate(listener: InvalidationListener): () => void {
    this.#invalidationListeners.add(listener);
    return () => this.#invalidationListeners.delete(listener);
  }

  onPresence(listener: (scopeKey: string) => void): () => void {
    this.#presenceListeners.add(listener);
    return () => this.#presenceListeners.delete(listener);
  }

  async query(sql: string, params?: readonly SqlValue[]): Promise<SqlRow[]> {
    const replyJson = await this.#native.query(
      sql,
      JSON.stringify((params ?? []).map(encodeParam)),
    );
    const reply = JSON.parse(replyJson) as CommandReply;
    if (reply.error !== undefined) {
      throw new NativeSyncError(reply.error.code, reply.error.message);
    }
    const rows = (reply.result as { rows?: unknown[] }).rows ?? [];
    return rows.map((r) => decodeRow(r as Record<string, unknown>));
  }

  async mutate(mutations: readonly MutationInput[]): Promise<string> {
    const result = (await this.#command('mutate', {
      mutations: mutations.map((m) => m as unknown),
    })) as { clientCommitId: string };
    return result.clientCommitId;
  }

  // -- Native CRDT (SPEC.md §5.10.5; needs the FFI `crdt-yjs` feature) ---------

  /** Materialize a `crdt` column's collaborative text — decoded from the
   * stored (server-merged) Yjs bytes. `name` selects the shared text
   * (default `"text"`). An absent row / NULL column is the empty document. */
  async crdtText(
    table: string,
    rowId: string,
    column: string,
    name = 'text',
  ): Promise<string> {
    const result = (await this.#command('crdtText', {
      table,
      rowId,
      column,
      name,
    })) as { text: string };
    return result.text;
  }

  /** Insert `value` at UTF-16 offset `index` in a `crdt` column's text and
   * push the resulting Yjs update (baseVersion-less). Returns the commit id. */
  async crdtInsertText(
    table: string,
    rowId: string,
    column: string,
    index: number,
    value: string,
    name = 'text',
  ): Promise<string> {
    const result = (await this.#command('crdtInsertText', {
      table,
      rowId,
      column,
      name,
      index,
      value,
    })) as { clientCommitId: string };
    return result.clientCommitId;
  }

  /** Delete `len` UTF-16 code units at `index` in a `crdt` column's text. */
  async crdtDeleteText(
    table: string,
    rowId: string,
    column: string,
    index: number,
    len: number,
    name = 'text',
  ): Promise<string> {
    const result = (await this.#command('crdtDeleteText', {
      table,
      rowId,
      column,
      name,
      index,
      len,
    })) as { clientCommitId: string };
    return result.clientCommitId;
  }

  /** Escape hatch: apply an arbitrary Yjs update onto a `crdt` column. */
  async crdtApplyUpdate(
    table: string,
    rowId: string,
    column: string,
    update: Uint8Array,
  ): Promise<string> {
    const result = (await this.#command('crdtApplyUpdate', {
      table,
      rowId,
      column,
      update: { $bytes: bytesToHex(update) },
    })) as { clientCommitId: string };
    return result.clientCommitId;
  }

  async subscribe(input: {
    readonly id: string;
    readonly table: string;
    readonly scopes?: Record<string, readonly string[]>;
    readonly params?: string;
  }): Promise<void> {
    await this.#command('subscribe', {
      id: input.id,
      table: input.table,
      scopes: input.scopes ?? {},
      ...(input.params !== undefined ? { params: input.params } : {}),
    });
  }

  async unsubscribe(id: string): Promise<void> {
    await this.#command('unsubscribe', { id });
  }

  async setWindow(base: WindowBase, units: readonly string[]): Promise<void> {
    await this.#command('setWindow', {
      base: base as unknown as Record<string, unknown>,
      units: units as string[],
    });
  }

  async windowState(base: WindowBase): Promise<WindowState> {
    const result = (await this.#command('windowState', {
      base: base as unknown as Record<string, unknown>,
    })) as { units: string[] };
    return { units: result.units };
  }

  async sync(): Promise<unknown> {
    return this.#command('sync', {});
  }

  async syncUntilIdle(maxRounds?: number): Promise<unknown> {
    return this.#command('syncUntilIdle', {
      ...(maxRounds !== undefined ? { maxRounds } : {}),
    });
  }

  async conflicts(): Promise<readonly ConflictRecord[]> {
    const result = (await this.#command('conflicts', {})) as {
      conflicts: ConflictRecord[];
    };
    return result.conflicts;
  }

  async rejections(): Promise<readonly RejectionRecord[]> {
    const result = (await this.#command('rejections', {})) as {
      rejections: RejectionRecord[];
    };
    return result.rejections;
  }

  async schemaFloor(): Promise<SchemaFloor | undefined> {
    const result = (await this.#command('schemaFloor', {})) as {
      floor?: SchemaFloor;
    };
    return result.floor ?? undefined;
  }

  async leaseState(): Promise<LeaseState | undefined> {
    const result = (await this.#command('leaseState', {})) as {
      lease?: LeaseState;
    };
    return result.lease ?? undefined;
  }

  async upgrading(): Promise<boolean> {
    const result = (await this.#command('upgrading', {})) as { value: boolean };
    return result.value;
  }

  async syncNeeded(): Promise<boolean> {
    const result = (await this.#command('syncNeeded', {})) as {
      value: boolean;
    };
    return result.value;
  }

  async pendingCommits(): Promise<unknown[]> {
    const result = (await this.#command('pendingCommitIds', {})) as {
      ids: string[];
    };
    return result.ids;
  }

  async presence(scopeKey: string): Promise<readonly PresencePeer[]> {
    const result = (await this.#command('presence', { scopeKey })) as {
      peers: PresencePeer[];
    };
    return result.peers;
  }

  async setPresence(
    scopeKey: string,
    doc: Record<string, unknown> | null,
  ): Promise<void> {
    await this.#command('setPresence', { scopeKey, doc });
  }

  async connectRealtime(): Promise<void> {
    await this.#command('connectRealtime', {});
  }

  async disconnectRealtime(): Promise<void> {
    await this.#command('disconnectRealtime', {});
  }

  /**
   * Pause background activity — stop the native event pump and disconnect
   * realtime. Call from `AppState` `'background'`. The database and outbox are
   * intact; mutations still queue offline. {@link resume} restarts them.
   */
  async pause(): Promise<void> {
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
    this.#native.startEvents();
  }

  /** Detach the event listener and close the native core. Idempotent. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#native.stopEvents();
    this.#subscription?.remove();
    this.#subscription = undefined;
    this.#invalidationListeners.clear();
    this.#presenceListeners.clear();
    await this.#native.close();
  }
}

/** The error a `{error}` reply surfaces (mirrors the web-client `ClientSyncError`). */
export class NativeSyncError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'NativeSyncError';
    this.code = code;
  }
}

function toStringSet(value: unknown): ReadonlySet<string> {
  if (Array.isArray(value)) {
    return new Set(value.filter((v): v is string => typeof v === 'string'));
  }
  return new Set<string>();
}

/**
 * Construct the bridge and issue the native `create` (opening the file DB on
 * the Rust side). Returns a ready `NativeSyncClient` satisfying `SyncClientLike`
 * — pass it straight to the React `<SyncProvider client={…}>`.
 */
export async function createNativeSyncClient(
  config: NativeSyncClientConfig,
): Promise<NativeSyncClient> {
  const { nativeModule, eventEmitter } = resolveNative(config);

  // Wire the event stream BEFORE create so no early invalidate is missed.
  const clientRef: { client: NativeSyncClient | undefined } = {
    client: undefined,
  };
  const subscription = eventEmitter.addListener(SYNCULAR_EVENT, (payload) => {
    clientRef.client?.__dispatchEvent(payload);
  });

  const client = new NativeSyncClient(nativeModule, subscription);
  clientRef.client = client;

  const transportConfig: Record<string, unknown> = {};
  if (config.baseUrl !== undefined) transportConfig.baseUrl = config.baseUrl;
  if (config.headers !== undefined) transportConfig.headers = config.headers;

  const createParams: Record<string, unknown> = {
    clientId: config.clientId,
    schema: config.schema,
  };
  if (config.limits !== undefined) createParams.limits = config.limits;
  if (config.dbPath !== undefined) createParams.dbPath = config.dbPath;

  const replyJson = await nativeModule.create(
    JSON.stringify(transportConfig),
    JSON.stringify(createParams),
  );
  const reply = JSON.parse(replyJson) as CommandReply;
  if (reply.error !== undefined) {
    subscription.remove();
    throw new NativeSyncError(reply.error.code, reply.error.message);
  }

  // Begin pumping poll_event → native event emitter.
  nativeModule.startEvents();
  return client;
}
