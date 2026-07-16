/**
 * @syncular/tauri — the JS bridge to the native syncular instance running
 * inside the Tauri process (see `tauri-plugin-syncular`).
 *
 * The Tauri host runs a REAL Rust syncular client (file DB + native HTTP+WS
 * transport). This module is a thin webview-side proxy that implements the SAME
 * `SyncClientLike` interface the React package normalizes — so the hooks
 * (`useRawSql`, `useMutation`, `usePresence`, …) work UNCHANGED against a
 * Tauri app. It is the fourth host of one interface, after the direct
 * `SyncClient`, the worker-leader `SyncClientHandle`, and the multi-tab
 * follower (ROADMAP.md block 1).
 *
 * Every method forwards to the plugin's `syncular_command` command (the whole
 * command surface in one JSON envelope — `{method, params}`), mirroring the FFI
 * and the conformance shim. `query` uses the dedicated `syncular_query` fast
 * path; atomic reactive reads use `syncular_query_snapshot`, backed by an
 * independent read-only SQLite connection so network sync cannot stall local
 * UI reads. Client-observable
 * events (`change` / `presence`) arrive on
 * the `syncular://event` Tauri event and fan out to the registered listeners.
 *
 * Bytes cross the command JSON as the established `{$bytes: hex}` envelope, the
 * same convention the Rust command router and the driver protocol use.
 *
 * `@tauri-apps/api` is a required peer dependency: the bridge takes
 * `invoke`/`listen` either from its ESM entry points, from the ambient
 * `window.__TAURI__`, or via injected doubles (tests).
 */

// -- Types the bridge speaks (structurally the web-client's) -----------------
// Imported as types only, so the bridge has no runtime dependency on
// @syncular/client (the app already carries it via @syncular/react).
import type {
  ClientChangeBatch,
  ClientChangeListener,
  CommitOutcome,
  CommitOutcomeQuery,
  ConflictRecord,
  EncryptionKeyringConfig,
  InvalidationEvent,
  InvalidationListener,
  LeaseState,
  MutationInput,
  PresencePeer,
  QueryReadSpec,
  QuerySnapshot,
  RejectionRecord,
  ResolveCommitOutcomeInput,
  SchemaFloor,
  SqlRow,
  SqlValue,
  SyncStatusSnapshot,
  WindowBase,
  WindowState,
} from '@syncular/client';

/** A driver-protocol reply: `{result}` on success or `{error}` on failure. */
interface CommandReply {
  readonly result?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
}

/** One event pushed on `syncular://event` (the derived client-observable set). */
interface SyncularEvent {
  readonly type: string;
  readonly [key: string]: unknown;
}

/** The two Tauri primitives the bridge needs — injectable for tests. */
export interface TauriApi {
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  listen<T>(
    event: string,
    handler: (event: { payload: T }) => void,
  ): Promise<() => void>;
}

/** The plugin's Tauri event name — mirror of `tauri-plugin-syncular`. */
export const SYNCULAR_EVENT = 'syncular://event';

const PLUGIN = 'plugin:syncular|';

/** Config for {@link createTauriSyncClient}. */
export interface TauriSyncClientConfig {
  /** The generated schema JSON (the app passes `schema` from typegen). */
  readonly schema: unknown;
  /**
   * Client id for this device/actor. If omitted, the native client generates
   * one and persists it in the database. Supplying a different id when opening
   * an existing database fails with `client.identity_mismatch`.
   */
  readonly clientId?: string;
  /** §4.2 client limits, forwarded to the native `create`. */
  readonly limits?: Record<string, unknown>;
  /**
   * Portable E2EE keys and declarative per-row key-id columns. Raw keys are
   * encoded into the native command envelope and never sent to the server.
   */
  readonly encryption?: EncryptionKeyringConfig;
  /**
   * The Tauri primitives. Omit in a real Tauri webview to auto-resolve from
   * `@tauri-apps/api` (peer dep) or the ambient `window.__TAURI__`; inject in
   * tests. Resolution is async, so construction is a factory (below).
   */
  readonly tauri?: TauriApi;
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
  for (const b of bytes) {
    out += b.toString(16).padStart(2, '0');
  }
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

/** Encode an SQL param for the command JSON (bytes → `{$bytes: hex}`). */
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
  // Objects/arrays that are not the bytes envelope round-trip as their JSON
  // string (SQLite json columns arrive as text already; this is defensive).
  return JSON.stringify(value);
}

function decodeRow(row: Record<string, unknown>): SqlRow {
  const out: SqlRow = {};
  for (const [key, value] of Object.entries(row)) {
    // Reserved `_sync_*` columns stay engine-internal (parity with the
    // web client's `query()`), so a `SELECT *` row round-trips straight
    // into `mutate()` values. Alias (`_sync_version AS v`) to read one.
    if (key.startsWith('_sync_')) continue;
    out[key] = decodeCell(value);
  }
  return out;
}

/** Resolve the Tauri primitives from the ambient environment when not injected. */
async function resolveTauri(injected: TauriApi | undefined): Promise<TauriApi> {
  if (injected !== undefined) return injected;
  // Prefer the ambient global (present when `withGlobalTauri` is enabled).
  const ambient = (
    globalThis as {
      __TAURI__?: {
        core?: { invoke?: TauriApi['invoke'] };
        event?: { listen?: TauriApi['listen'] };
      };
    }
  ).__TAURI__;
  if (ambient?.core?.invoke && ambient.event?.listen) {
    return {
      invoke: ambient.core.invoke.bind(ambient.core),
      listen: ambient.event.listen.bind(ambient.event),
    };
  }
  // Fall back to the ESM package (the common path). These must remain literal,
  // bundler-visible specifiers: hiding a bare package import behind
  // `@vite-ignore` makes WebKit resolve it as a URL at runtime instead of
  // letting Vite/Bun include the Tauri API in the webview bundle.
  const [core, event] = await Promise.all([
    import('@tauri-apps/api/core'),
    import('@tauri-apps/api/event'),
  ]);
  return { invoke: core.invoke, listen: event.listen };
}

/**
 * The webview-side proxy implementing `SyncClientLike` over the plugin. Every
 * method is a promise (an IPC round trip); the React `normalizeClient` already
 * wraps sync and async members uniformly, so the hooks accept it directly.
 */
export class TauriSyncClient {
  readonly #tauri: TauriApi;
  readonly #invalidationListeners = new Set<InvalidationListener>();
  readonly #changeListeners = new Set<ClientChangeListener>();
  readonly #presenceListeners = new Set<(scopeKey: string) => void>();
  #unlisten: (() => void) | undefined;
  #closed = false;

  /** @internal — use {@link createTauriSyncClient}. */
  constructor(tauri: TauriApi, unlisten: () => void) {
    this.#tauri = tauri;
    this.#unlisten = unlisten;
  }

  /** Dispatch a `syncular_command` and unwrap `{result}` / throw on `{error}`. */
  async #command(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const reply = await this.#tauri.invoke<CommandReply>(
      `${PLUGIN}syncular_command`,
      { command: { method, params } },
    );
    if (reply.error !== undefined) {
      throw new TauriSyncError(reply.error.code, reply.error.message);
    }
    return reply.result;
  }

  /** @internal — fan an incoming plugin event out to the local listeners. */
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
      default:
        // Unknown extension events are deliberately ignored. All durable
        // observable state arrives in the revisioned `change` batch.
        break;
    }
  }

  // -- SyncClientLike --------------------------------------------------------

  onInvalidate(listener: InvalidationListener): () => void {
    this.#invalidationListeners.add(listener);
    return () => this.#invalidationListeners.delete(listener);
  }

  onChange(listener: ClientChangeListener): () => void {
    this.#changeListeners.add(listener);
    return () => this.#changeListeners.delete(listener);
  }

  onPresence(listener: (scopeKey: string) => void): () => void {
    this.#presenceListeners.add(listener);
    return () => this.#presenceListeners.delete(listener);
  }

  async query(sql: string, params?: readonly SqlValue[]): Promise<SqlRow[]> {
    const reply = await this.#tauri.invoke<CommandReply>(
      `${PLUGIN}syncular_query`,
      { sql, params: (params ?? []).map(encodeParam) },
    );
    if (reply.error !== undefined) {
      throw new TauriSyncError(reply.error.code, reply.error.message);
    }
    const rows = (reply.result as { rows?: unknown[] }).rows ?? [];
    return rows.map((r) => decodeRow(r as Record<string, unknown>));
  }

  async querySnapshot<Row = SqlRow>(
    spec: QueryReadSpec,
  ): Promise<QuerySnapshot<Row>> {
    const reply = await this.#tauri.invoke<CommandReply>(
      `${PLUGIN}syncular_query_snapshot`,
      {
        sql: spec.sql,
        params: (spec.params ?? []).map(encodeParam),
        coverage: spec.coverage ?? [],
      },
    );
    if (reply.error !== undefined) {
      throw new TauriSyncError(reply.error.code, reply.error.message);
    }
    const result = reply.result as {
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

  /**
   * Replace the native transport's request headers at runtime — the auth
   * rotation path (RFC 0002 §2.3). Pass the FULL header set (it replaces,
   * it does not merge). HTTP requests use the new set from the next call;
   * the realtime socket applies it on its next (re)connect.
   */
  async setHeaders(headers: Readonly<Record<string, string>>): Promise<void> {
    const reply = await this.#tauri.invoke<CommandReply>(
      `${PLUGIN}syncular_set_headers`,
      { headers },
    );
    if (reply.error !== undefined) {
      throw new TauriSyncError(reply.error.code, reply.error.message);
    }
  }

  // -- Native CRDT (SPEC.md §5.10.5; needs the plugin `crdt-yjs` feature) ------

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

  /** Detach the event listener; the native core keeps running (host process). */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#unlisten?.();
    this.#unlisten = undefined;
    this.#invalidationListeners.clear();
    this.#changeListeners.clear();
    this.#presenceListeners.clear();
  }
}

/** The error a `{error}` reply surfaces (mirrors the web-client `ClientSyncError`). */
export class TauriSyncError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'TauriSyncError';
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

/** Encode one mutation for the command JSON (bytes inside `values` handled by
 * the native side; the driver form is already JSON-able). */
function encodeMutation(mutation: MutationInput): unknown {
  if (mutation.op === 'delete') return mutation;
  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(mutation.values)) {
    values[key] = encodeJsonValue(value);
  }
  return { ...mutation, values };
}

/**
 * Construct the bridge and issue the native `create` (opening/attaching the
 * file DB on the Rust side per the plugin config). Returns a ready
 * `TauriSyncClient` that satisfies `SyncClientLike` — pass it straight to the
 * React `<SyncProvider client={…}>`.
 */
export async function createTauriSyncClient(
  config: TauriSyncClientConfig,
): Promise<TauriSyncClient> {
  const tauri = await resolveTauri(config.tauri);

  // Wire the event stream BEFORE create, so no early change batch is missed.
  const clientRef: { client: TauriSyncClient | undefined } = {
    client: undefined,
  };
  const unlisten = await tauri.listen<SyncularEvent>(
    SYNCULAR_EVENT,
    (event) => {
      clientRef.client?.__dispatchEvent(event.payload);
    },
  );

  const client = new TauriSyncClient(tauri, unlisten);
  clientRef.client = client;

  // The native side owns the db path (plugin config); the JS side supplies the
  // schema, clientId, and limits. `dbPath` is injected by the plugin.
  const reply = await tauri.invoke<CommandReply>(`${PLUGIN}syncular_command`, {
    command: {
      method: 'create',
      params: {
        ...(config.clientId !== undefined ? { clientId: config.clientId } : {}),
        schema: config.schema,
        ...(config.limits !== undefined ? { limits: config.limits } : {}),
        ...(config.encryption !== undefined
          ? { encryption: encodeEncryption(config.encryption) }
          : {}),
      },
    },
  });
  if (reply.error !== undefined) {
    unlisten();
    throw new TauriSyncError(reply.error.code, reply.error.message);
  }

  return client;
}
