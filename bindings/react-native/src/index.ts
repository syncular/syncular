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
 * fast path. Exact revisioned `change` batches and `presence` events arrive on
 * the `syncular::event` NativeEventEmitter topic and fan out to the registered
 * listeners. The bridge never reconstructs changes from counters.
 *
 * Bytes cross as the established `{$bytes:hex}` envelope — the same convention
 * the Rust command router, the driver protocol, and the Tauri bridge use.
 *
 * The native module is INJECTABLE (`createNativeSyncClient({ nativeModule })`),
 * so the bridge is unit-tested with a NativeModule double and never needs a
 * device. In an app it auto-resolves the codegen module from `NativeSyncular`.
 */
import type {
  ClientChangeBatch,
  ClientChangeListener,
  ClientDiagnosticsListener,
  ClientDiagnosticsRequest,
  ClientDiagnosticsSnapshot,
  CommitOutcome,
  CommitOutcomeQuery,
  ConflictRecord,
  EncryptionKeyringConfig,
  InvalidationEvent,
  InvalidationListener,
  LeaseState,
  LocalDataPurgeInput,
  LocalDataPurgeResult,
  LocalDataRebootstrapInput,
  LocalDataRebootstrapResult,
  MutationInput,
  PresencePeer,
  QueryReadSpec,
  QuerySnapshot,
  RejectionRecord,
  ResolveCommitOutcomeInput,
  SchemaFloor,
  SecurityLifecycle,
  SqlRow,
  SqlValue,
  SyncStatusSnapshot,
  WindowBase,
  WindowState,
} from '@syncular/client';
import {
  SECURITY_PREFLIGHT_REQUIRED_CODE,
  withClientDiagnosticsHost,
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
  /**
   * Stable per-device/actor client id. If omitted, the native core creates and
   * persists one in the database. A mismatched explicit id fails loudly.
   */
  readonly clientId?: string;
  /** §4.2 client limits, forwarded to the native `create`. */
  readonly limits?: Record<string, unknown>;
  /** Portable E2EE keyring installed in the Rust core. */
  readonly encryption?: EncryptionKeyringConfig;
  /** Open the native replica behind the fail-closed security gate. */
  readonly securityPreflight?: boolean;
  /** Base URL of the sync server mount (engages the native transport). */
  readonly baseUrl?: string;
  /** On-disk SQLite path; the native side may override with an app-data path. */
  readonly dbPath?: string;
  /** Extra transport headers (auth, tenant, …). */
  readonly headers?: Record<string, string>;
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

/** The bytes envelope both sides share. */
export type BytesEnvelope = { readonly $bytes: string };
type BigIntEnvelope = { readonly $bigint: string };

function isBytesEnvelope(value: unknown): value is BytesEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { $bytes?: unknown }).$bytes === 'string'
  );
}

function isBigIntEnvelope(value: unknown): value is BigIntEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { $bigint?: unknown }).$bigint === 'string'
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
  if (typeof value === 'bigint') return { $bigint: value.toString() };
  return value;
}

function encodeJsonValue(value: unknown): unknown {
  if (value instanceof Uint8Array) return { $bytes: bytesToHex(value) };
  if (typeof value === 'bigint') return { $bigint: value.toString() };
  if (Array.isArray(value)) return value.map(encodeJsonValue);
  if (value !== null && typeof value === 'object') {
    const encoded: Record<string, unknown> = {};
    for (const [key, member] of Object.entries(value)) {
      encoded[key] = encodeJsonValue(member);
    }
    return encoded;
  }
  return value;
}

function encodeEncryption(config: EncryptionKeyringConfig): unknown {
  return {
    keys: Object.fromEntries(
      Object.entries(config.keys).map(([keyId, key]) => [
        keyId,
        { $bytes: bytesToHex(key) },
      ]),
    ),
    ...(config.keyIdColumns !== undefined
      ? { keyIdColumns: config.keyIdColumns }
      : {}),
  };
}

/** Decode one query-result cell back to an `SqlValue` (`{$bytes}` → bytes). */
function decodeCell(value: unknown): SqlValue {
  if (isBytesEnvelope(value)) return hexToBytes(value.$bytes);
  if (isBigIntEnvelope(value)) return BigInt(value.$bigint);
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
  for (const [key, value] of Object.entries(row)) {
    if (key.startsWith('_sync_')) continue;
    out[key] = decodeCell(value);
  }
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
  readonly #autoSync: boolean;
  readonly #invalidationListeners = new Set<InvalidationListener>();
  readonly #changeListeners = new Set<ClientChangeListener>();
  readonly #diagnosticsListeners = new Set<ClientDiagnosticsListener>();
  readonly #presenceListeners = new Set<(scopeKey: string) => void>();
  #subscription: { remove(): void } | undefined;
  #closed = false;
  #paused = false;
  #syncScheduled = false;
  #syncRunning = false;
  #syncAgain = false;
  #retryAt: number | undefined;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #securityLifecycle: SecurityLifecycle;
  #preflightBarrier: Promise<void> | undefined;

  /** @internal — use {@link createNativeSyncClient}. */
  constructor(
    native: SyncularNativeModule,
    subscription: { remove(): void },
    autoSync: boolean,
    securityLifecycle: SecurityLifecycle = 'active',
  ) {
    this.#native = native;
    this.#subscription = subscription;
    this.#autoSync = autoSync;
    this.#securityLifecycle = securityLifecycle;
  }

  /** Dispatch a `command` and unwrap `{result}` / throw on `{error}`. */
  async #command(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    if (this.#closed) {
      throw new NativeSyncError(
        'client.closed',
        'the native sync client is closed',
      );
    }
    if (
      this.#securityLifecycle === 'preflight' &&
      ![
        'securityLifecycle',
        'beginSecurityPreflight',
        'activateSecurity',
        'purgeLocalData',
        'localRevision',
        'statusSnapshot',
      ].includes(method)
    ) {
      this.#throwSecurityPreflight();
    }
    const replyJson = await this.#native.command(
      JSON.stringify({ method, params }),
    );
    const reply = JSON.parse(replyJson) as CommandReply;
    if (reply.error !== undefined) {
      throw new NativeSyncError(reply.error.code, reply.error.message);
    }
    return reply.result;
  }

  #throwSecurityPreflight(): never {
    throw new NativeSyncError(
      SECURITY_PREFLIGHT_REQUIRED_CODE,
      'the local replica is in security preflight; complete quarantine checks and call activateSecurity before accessing protected data',
    );
  }

  #requireActive(): void {
    if (this.#securityLifecycle === 'preflight') this.#throwSecurityPreflight();
  }

  /** @internal — fan an incoming native event out to the local listeners. */
  __dispatchEvent(event: SyncularEvent): void {
    switch (event.type) {
      case 'change': {
        const batch = decodeChangeBatch(event.batch);
        if (batch === undefined) break;
        for (const listener of this.#changeListeners) {
          try {
            listener(batch);
          } catch {
            /* a UI listener must never break event dispatch */
          }
        }
        const payload = invalidationFromChange(batch);
        if (payload === undefined) break;
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
      case 'sync-intent': {
        if (!this.#autoSync) break;
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
        break;
      }
      case 'diagnostics': {
        const snapshot = decodeDiagnosticsSnapshot(
          event.snapshot,
          'react-native',
        );
        if (snapshot === undefined) break;
        for (const listener of this.#diagnosticsListeners) {
          try {
            listener(snapshot);
          } catch {
            /* a diagnostics observer must never break event dispatch */
          }
        }
        break;
      }
      default:
        // Unknown extension events are deliberately ignored.
        break;
    }
  }

  #requestAutoSync(): void {
    if (
      this.#closed ||
      this.#paused ||
      this.#securityLifecycle === 'preflight'
    ) {
      return;
    }
    if (this.#retryTimer !== undefined) clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
    this.#retryAt = undefined;
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
    if (
      this.#closed ||
      this.#paused ||
      this.#securityLifecycle === 'preflight'
    ) {
      return;
    }
    const deadline = Date.now() + delayMs;
    if (this.#retryAt !== undefined && this.#retryAt <= deadline) return;
    if (this.#retryTimer !== undefined) clearTimeout(this.#retryTimer);
    this.#retryAt = deadline;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      this.#retryAt = undefined;
      this.#requestAutoSync();
    }, delayMs);
  }

  async #runAutoSync(): Promise<void> {
    if (this.#closed || this.#paused || this.#syncRunning) return;
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

  // -- SyncClientLike ---------------------------------------------------------

  securityLifecycle(): Promise<SecurityLifecycle> {
    return Promise.resolve(this.#securityLifecycle);
  }

  beginSecurityPreflight(): Promise<void> {
    if (this.#closed) {
      return Promise.reject(
        new NativeSyncError(
          'client.closed',
          'the native sync client is closed',
        ),
      );
    }
    if (this.#preflightBarrier !== undefined) return this.#preflightBarrier;
    this.#securityLifecycle = 'preflight';
    if (this.#retryTimer !== undefined) clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
    this.#retryAt = undefined;
    this.#syncScheduled = false;
    this.#syncAgain = false;
    const barrier = this.#command('beginSecurityPreflight', {}).then(() => {});
    this.#preflightBarrier = barrier;
    void barrier.then(
      () => {
        if (this.#preflightBarrier === barrier)
          this.#preflightBarrier = undefined;
      },
      () => {
        if (this.#preflightBarrier === barrier)
          this.#preflightBarrier = undefined;
      },
    );
    return barrier;
  }

  async activateSecurity(
    options: { readonly encryption?: EncryptionKeyringConfig } = {},
  ): Promise<void> {
    if (this.#securityLifecycle === 'active') {
      throw new NativeSyncError(
        'sync.invalid_request',
        'activateSecurity requires the client to be in security preflight',
      );
    }
    await this.#preflightBarrier;
    await this.#command('activateSecurity', {
      ...(options.encryption !== undefined
        ? { encryption: encodeEncryption(options.encryption) }
        : {}),
    });
    this.#securityLifecycle = 'active';
  }

  onInvalidate(listener: InvalidationListener): () => void {
    this.#invalidationListeners.add(listener);
    return () => this.#invalidationListeners.delete(listener);
  }

  onChange(listener: ClientChangeListener): () => void {
    this.#changeListeners.add(listener);
    return () => this.#changeListeners.delete(listener);
  }

  onDiagnostics(listener: ClientDiagnosticsListener): () => void {
    this.#diagnosticsListeners.add(listener);
    return () => this.#diagnosticsListeners.delete(listener);
  }

  onPresence(listener: (scopeKey: string) => void): () => void {
    this.#presenceListeners.add(listener);
    return () => this.#presenceListeners.delete(listener);
  }

  async query(sql: string, params?: readonly SqlValue[]): Promise<SqlRow[]> {
    this.#requireActive();
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

  async querySnapshot<Row = SqlRow>(
    spec: QueryReadSpec,
  ): Promise<QuerySnapshot<Row>> {
    const result = (await this.#command('querySnapshot', {
      sql: spec.sql,
      params: (spec.params ?? []).map(encodeParam),
      coverage: spec.coverage ?? [],
    })) as {
      revision: string;
      rows: Record<string, unknown>[];
      coverage: QuerySnapshot['coverage'];
    };
    return {
      revision: BigInt(result.revision),
      rows: result.rows.map(decodeRow) as unknown as readonly Row[],
      coverage: result.coverage,
    };
  }

  async localRevision(): Promise<bigint> {
    const result = (await this.#command('localRevision', {})) as {
      revision: string;
    };
    return BigInt(result.revision);
  }

  async statusSnapshot(): Promise<SyncStatusSnapshot> {
    return (await this.#command('statusSnapshot', {})) as SyncStatusSnapshot;
  }

  async diagnosticsSnapshot(
    request: ClientDiagnosticsRequest = {},
  ): Promise<ClientDiagnosticsSnapshot> {
    const snapshot = (await this.#command('diagnosticsSnapshot', {
      expectedSubscriptions: request.expectedSubscriptions ?? [],
    })) as ClientDiagnosticsSnapshot;
    return withClientDiagnosticsHost(snapshot, {
      ...snapshot.host,
      kind: 'react-native',
      role: 'single',
    });
  }

  async mutate(mutations: readonly MutationInput[]): Promise<string> {
    const result = (await this.#command('mutate', {
      mutations: mutations.map(encodeMutation),
    })) as { clientCommitId: string };
    return result.clientCommitId;
  }

  async patch(
    table: string,
    rowId: string,
    partial: Readonly<Record<string, unknown>>,
    options?: { readonly baseVersion?: number },
  ): Promise<string> {
    const result = (await this.#command('patch', {
      table,
      rowId,
      partial: encodeJsonValue(partial),
      ...(options?.baseVersion !== undefined
        ? { baseVersion: options.baseVersion }
        : {}),
    })) as { clientCommitId: string };
    return result.clientCommitId;
  }

  async purgeLocalData(
    input: LocalDataPurgeInput,
  ): Promise<LocalDataPurgeResult> {
    return (await this.#command('purgeLocalData', {
      input,
    })) as LocalDataPurgeResult;
  }

  async rebootstrapLocalData(
    input: LocalDataRebootstrapInput,
  ): Promise<LocalDataRebootstrapResult> {
    const result = (await this.#command('rebootstrapLocalData', {
      input,
    })) as LocalDataRebootstrapResult;
    return {
      alreadyApplied: result.alreadyApplied,
      retainedCommits: result.retainedCommits,
      resetSubscriptions: result.resetSubscriptions,
    };
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
    })) as { units: string[]; pending: string[] };
    return { units: result.units, pending: result.pending };
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

  async commitOutcome(
    clientCommitId: string,
  ): Promise<CommitOutcome | undefined> {
    const result = (await this.#command('commitOutcome', {
      clientCommitId,
    })) as { outcome?: CommitOutcome };
    return result.outcome;
  }

  async commitOutcomes(
    query: CommitOutcomeQuery = {},
  ): Promise<readonly CommitOutcome[]> {
    const result = (await this.#command('commitOutcomes', { query })) as {
      outcomes: CommitOutcome[];
    };
    return result.outcomes;
  }

  async resolveCommitOutcome(
    input: ResolveCommitOutcomeInput,
  ): Promise<CommitOutcome> {
    const result = (await this.#command('resolveCommitOutcome', {
      input,
    })) as { outcome: CommitOutcome };
    return result.outcome;
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
    this.#paused = true;
    if (this.#retryTimer !== undefined) clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
    this.#retryAt = undefined;
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

  /** Detach the event listener and close the native core. Idempotent. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#retryTimer !== undefined) clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
    this.#native.stopEvents();
    this.#subscription?.remove();
    this.#subscription = undefined;
    this.#invalidationListeners.clear();
    this.#changeListeners.clear();
    this.#diagnosticsListeners.clear();
    this.#presenceListeners.clear();
    await this.#native.close();
  }
}

function decodeDiagnosticsSnapshot(
  value: unknown,
  kind: 'react-native',
): ClientDiagnosticsSnapshot | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const snapshot = value as ClientDiagnosticsSnapshot;
  if (snapshot.version !== 1 || snapshot.host === undefined) return undefined;
  return withClientDiagnosticsHost(snapshot, {
    ...snapshot.host,
    kind,
    role: 'single',
  });
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

function decodeChangeBatch(value: unknown): ClientChangeBatch | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.revision !== 'string') return undefined;
  const tables = Array.isArray(raw.tables)
    ? raw.tables.flatMap((entry) => {
        if (entry === null || typeof entry !== 'object') return [];
        const item = entry as Record<string, unknown>;
        if (typeof item.table !== 'string') return [];
        return [
          {
            table: item.table,
            ...(Array.isArray(item.scopeKeys)
              ? { scopeKeys: toStringSet(item.scopeKeys) }
              : {}),
          },
        ];
      })
    : [];
  const windows = Array.isArray(raw.windows)
    ? raw.windows.flatMap((entry) => {
        if (entry === null || typeof entry !== 'object') return [];
        const item = entry as Record<string, unknown>;
        if (
          typeof item.baseKey !== 'string' ||
          typeof item.table !== 'string'
        ) {
          return [];
        }
        return [
          {
            baseKey: item.baseKey,
            table: item.table,
            units: toStringSet(item.units),
          },
        ];
      })
    : [];
  return {
    revision: BigInt(raw.revision),
    tables,
    windows,
    ...(raw.status !== undefined
      ? { status: raw.status as SyncStatusSnapshot }
      : {}),
    conflictsChanged: raw.conflictsChanged === true,
    rejectionsChanged: raw.rejectionsChanged === true,
    outcomesChanged: raw.outcomesChanged === true,
  };
}

function invalidationFromChange(
  batch: ClientChangeBatch,
): InvalidationEvent | undefined {
  if (batch.tables.length === 0 && batch.windows.length === 0) return undefined;
  const tables = new Set<string>();
  const scopeKeys = new Set<string>();
  for (const table of batch.tables) {
    tables.add(table.table);
    for (const key of table.scopeKeys ?? []) scopeKeys.add(key);
  }
  for (const window of batch.windows) tables.add(window.table);
  return { tables, scopeKeys };
}

function encodeMutation(mutation: MutationInput): unknown {
  if (mutation.op === 'delete') return mutation;
  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(mutation.values)) {
    values[key] = encodeJsonValue(value);
  }
  return { ...mutation, values };
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

  // Wire the event stream BEFORE create so no early change batch is missed.
  const clientRef: { client: NativeSyncClient | undefined } = {
    client: undefined,
  };
  const subscription = eventEmitter.addListener(SYNCULAR_EVENT, (payload) => {
    clientRef.client?.__dispatchEvent(payload);
  });

  const client = new NativeSyncClient(
    nativeModule,
    subscription,
    config.autoSync ?? true,
    config.securityPreflight === true ? 'preflight' : 'active',
  );
  clientRef.client = client;

  const transportConfig: Record<string, unknown> = {};
  if (config.baseUrl !== undefined) transportConfig.baseUrl = config.baseUrl;
  if (config.headers !== undefined) transportConfig.headers = config.headers;

  const createParams: Record<string, unknown> = { schema: config.schema };
  if (config.clientId !== undefined) createParams.clientId = config.clientId;
  if (config.limits !== undefined) createParams.limits = config.limits;
  if (config.dbPath !== undefined) createParams.dbPath = config.dbPath;
  if (config.securityPreflight === true && config.encryption !== undefined) {
    subscription.remove();
    throw new NativeSyncError(
      'sync.invalid_request',
      'securityPreflight and encryption are mutually exclusive; install keys with activateSecurity after preflight',
    );
  }
  if (config.encryption !== undefined) {
    createParams.encryption = encodeEncryption(config.encryption);
  }
  if (config.securityPreflight !== undefined) {
    createParams.securityPreflight = config.securityPreflight;
  }

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
