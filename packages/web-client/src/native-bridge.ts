/**
 * The command bridge shared by the native hosts: `@syncular/tauri` (the Tauri
 * plugin over IPC) and the React Native binding (the C-ABI core behind a
 * TurboModule). Both drive one Rust core through the driver-protocol command
 * envelope `{method, params}`, so the codec, the security preflight gate, the
 * event fanout, and every command method live here. A host subclass supplies
 * the transport: the generic command, the query fast path, the snapshot read,
 * header replacement, and shutdown.
 *
 * Bytes cross as `{$bytes: hex}` and unsafe SQLite integers as
 * `{$bigint: decimal}`, the convention of the Rust command router. The browser
 * client and worker entries never import this module.
 */
import {
  type ClientSnapshotMethods,
  type CurrentBaseProof,
  type MutationInput,
  type PresencePeer,
  type PromiseMethods,
  type QueryReadSpec,
  type QuerySnapshot,
  SECURITY_PREFLIGHT_REQUIRED_CODE,
  type SecurityLifecycle,
  type SnapshotRead,
  type SnapshotReadRequest,
  type SyncClient,
  type SyncClientConfig,
  type UnitCatchup,
  type WindowState,
} from './client';
import type { SqlRow, SqlValue } from './database';
import type { PresenceErrorCode, UnitScopes } from '@syncular/core';
export { unitId, type UnitScopes } from '@syncular/core';
import {
  CLIENT_DIAGNOSTICS_VERSION,
  type ClientDiagnosticsListener,
  type ClientDiagnosticsSnapshot,
  withClientDiagnosticsHost,
} from './diagnostics';
import type { EncryptionKeyringConfig } from './encryption';
import type {
  ClientChangeBatch,
  ClientChangeListener,
  InvalidationListener,
  SyncStatusSnapshot,
} from './invalidation';
import type { LocalDataPurgeInput, LocalDataPurgeResult } from './local-purge';
import {
  decodeLocalDataRebootstrapResult,
  type LocalDataRebootstrapInput,
  type LocalDataRebootstrapResult,
} from './local-rebootstrap';
import type {
  CommitOutcome,
  CommitOutcomeQuery,
  ConflictRecord,
  RejectionRecord,
  ResolveCommitOutcomeInput,
  RetainedCommitRow,
} from './outcomes';
import {
  decodePreviousVersionAuditResult,
  decodePreviousVersionDiscardResult,
  decodePreviousVersionSnapshot,
  type PreviousVersionAudit,
  type PreviousVersionReadSpec,
  type PreviousVersionSnapshot,
} from './previous-version';
import {
  ProgressEmitter,
  type SyncProgress,
  type SyncProgressListener,
} from './progress';
import type { UnitRecord } from './state';
import type { WindowBase } from './window';

/** A driver-protocol reply: `{result}` on success or `{error}` on failure. */
export interface NativeReply {
  readonly result?: unknown;
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly details?: Readonly<Record<string, unknown>> | null;
    readonly retryable?: boolean;
  };
}

/** One event the native core pushes (the derived client-observable set). */
export interface SyncularEvent {
  readonly type: string;
  readonly [key: string]: unknown;
}

/** The bytes envelope both sides share. */
export type BytesEnvelope = { readonly $bytes: string };

/** The `create` options every native host forwards to the Rust core. */
export interface NativeCreateConfig {
  /** The generated schema JSON (the app passes `schema` from typegen). */
  readonly schema: unknown;
  /**
   * Client id for this device or actor. If omitted, the native core generates
   * one and persists it in the database. Supplying a different id when opening
   * an existing database fails with `client.identity_mismatch`.
   */
  readonly clientId?: string;
  /** §4.2 client limits. */
  readonly limits?: Record<string, unknown>;
  /**
   * SPEC §8.8 realtime policy. Absent ⇒ `optional`. `required` refuses a sync
   * round while the socket is not connected instead of falling back to HTTP.
   */
  readonly realtimePolicy?: SyncClientConfig['realtimePolicy'];
  /**
   * Portable E2EE keys and declarative per-row key-id columns, installed in
   * the Rust core. Raw keys are never sent to the server.
   */
  readonly encryption?: EncryptionKeyringConfig;
  /** Open the native replica behind the fail-closed security gate. */
  readonly securityPreflight?: boolean;
  /** RFC 0005 previous-version context (default off). */
  readonly previousVersionContext?: SyncClientConfig['previousVersionContext'];
}

/** The error a native `{error}` reply surfaces (mirrors `ClientSyncError`). */
export class NativeSyncError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>> | undefined;
  readonly retryable: boolean;
  constructor(
    code: string,
    message: string,
    details?: Readonly<Record<string, unknown>>,
    retryable = false,
  ) {
    super(message);
    this.name = 'NativeSyncError';
    this.code = code;
    this.details = details;
    this.retryable = retryable;
  }
}

/** §7.1: exactly one `$bytes` key holding even-length hexadecimal. */
function isBytesEnvelope(value: unknown): value is BytesEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 1 &&
    typeof record.$bytes === 'string' &&
    /^(?:[0-9a-fA-F]{2})*$/.test(record.$bytes)
  );
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Encode a command value: bytes → `{$bytes}`, bigint → `{$bigint}`, recursively. */
function encodeValue(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    let hex = '';
    for (const byte of value) hex += byte.toString(16).padStart(2, '0');
    return { $bytes: hex };
  }
  if (typeof value === 'bigint') return { $bigint: value.toString() };
  if (Array.isArray(value)) return value.map(encodeValue);
  if (value !== null && typeof value === 'object') {
    const encoded: Record<string, unknown> = {};
    for (const [key, member] of Object.entries(value)) {
      encoded[key] = encodeValue(member);
    }
    return encoded;
  }
  return value;
}

function toStringSet(value: unknown): ReadonlySet<string> {
  return new Set(
    Array.isArray(value)
      ? value.filter((v): v is string => typeof v === 'string')
      : [],
  );
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
        if (typeof item.baseKey !== 'string') return [];
        return [{ baseKey: item.baseKey, units: toStringSet(item.units) }];
      })
    : [];
  const appliedCommits: NonNullable<
    ClientChangeBatch['appliedCommits']
  >[number][] = [];
  if (raw.appliedCommits !== undefined) {
    if (!Array.isArray(raw.appliedCommits)) return undefined;
    for (const entry of raw.appliedCommits) {
      if (entry === null || typeof entry !== 'object') return undefined;
      const item = entry as Record<string, unknown>;
      if (
        typeof item.table !== 'string' ||
        typeof item.commitSeq !== 'number' ||
        !Number.isSafeInteger(item.commitSeq) ||
        item.commitSeq < 1 ||
        (item.source !== 'delta' && item.source !== 'pull')
      )
        return undefined;
      appliedCommits.push({
        table: item.table,
        commitSeq: item.commitSeq,
        source: item.source,
      });
    }
  }
  return {
    revision: BigInt(raw.revision),
    tables,
    windows,
    ...(raw.appliedCommits !== undefined ? { appliedCommits } : {}),
    ...(raw.status !== undefined
      ? { status: raw.status as SyncStatusSnapshot }
      : {}),
    conflictsChanged: raw.conflictsChanged === true,
    rejectionsChanged: raw.rejectionsChanged === true,
    outcomesChanged: raw.outcomesChanged === true,
  };
}

/**
 * The `create` params every native host sends. Keys cannot be installed
 * before a security preflight; that combination fails before the host is
 * touched.
 */
export function nativeCreateParams(
  config: NativeCreateConfig,
  ErrorType: typeof NativeSyncError,
): Record<string, unknown> {
  if (config.securityPreflight === true && config.encryption !== undefined) {
    throw new ErrorType(
      'sync.invalid_request',
      'securityPreflight and encryption are mutually exclusive; install keys with activateSecurity after preflight',
    );
  }
  return {
    schema: config.schema,
    ...(config.clientId !== undefined ? { clientId: config.clientId } : {}),
    ...(config.limits !== undefined ? { limits: config.limits } : {}),
    ...(config.realtimePolicy !== undefined
      ? { realtimePolicy: config.realtimePolicy }
      : {}),
    ...(config.encryption !== undefined
      ? { encryption: encodeValue(config.encryption) }
      : {}),
    ...(config.securityPreflight !== undefined
      ? { securityPreflight: config.securityPreflight }
      : {}),
    ...(config.previousVersionContext !== undefined
      ? { previousVersionContext: config.previousVersionContext }
      : {}),
  };
}

/** A decoded outcome row cell; native outcome rows carry no `$bigint`. */
type OutcomeRowValue = ConflictRecord['serverRow'][string];

/**
 * The `SyncClientLike` proxy over a native core. Every snapshot method
 * returns a promise from one host round trip; React hooks accept the
 * canonical snapshot interface directly.
 */
/** Native hosts whose one core a live bridge client of this page holds. */
const heldHosts = new WeakSet<object>();

export abstract class NativeBridgeClient implements PromiseMethods<
  ClientSnapshotMethods & Pick<SyncClient, 'unit' | 'units' | 'unitCatchup'>
> {
  readonly #kind: 'tauri' | 'react-native';
  readonly #Error: typeof NativeSyncError;
  readonly #release: () => void;
  readonly #invalidationListeners = new Set<InvalidationListener>();
  readonly #changeListeners = new Set<ClientChangeListener>();
  readonly #progress = new ProgressEmitter();
  readonly #diagnosticsListeners = new Set<ClientDiagnosticsListener>();
  readonly #presenceListeners = new Set<
    (scopeKey: string, error?: PresenceErrorCode) => void
  >();
  #closed = false;
  #closing: Promise<void> | undefined;
  #host: object | undefined;
  #securityLifecycle: SecurityLifecycle;
  #preflightBarrier: Promise<void> | undefined;

  /**
   * `release` detaches the host event listener; the bridge calls it once,
   * after shutdown or after a failed `create`.
   */
  constructor(
    kind: 'tauri' | 'react-native',
    ErrorType: typeof NativeSyncError,
    release: () => void,
    securityLifecycle: SecurityLifecycle,
  ) {
    this.#kind = kind;
    this.#Error = ErrorType;
    this.#release = release;
    this.#securityLifecycle = securityLifecycle;
  }

  /** Run one `{method, params}` command on the native core. */
  protected abstract send(
    method: string,
    params: Record<string, unknown>,
  ): Promise<NativeReply>;
  /** The read-only SQL fast path; `params` are already envelope-encoded. */
  protected abstract sendQuery(
    sql: string,
    params: unknown,
  ): Promise<NativeReply>;
  /** The atomic `querySnapshot` read. */
  protected abstract sendQuerySnapshot(
    params: Record<string, unknown>,
  ): Promise<NativeReply>;
  /** Replace the native transport's full header set. */
  protected abstract sendHeaders(
    headers: Readonly<Record<string, string>>,
  ): Promise<NativeReply>;
  /** Stop the native core. `close()` detaches listeners once it settles. */
  protected abstract shutdown(): Promise<void>;

  /** Unwrap a host reply; a rejected host call surfaces as `client.failed`. */
  async #reply(send: () => Promise<NativeReply>): Promise<unknown> {
    let reply: NativeReply;
    try {
      reply = await send();
    } catch (cause) {
      throw new this.#Error(
        'client.failed',
        'the native host rejected the call',
        { cause: String(cause) },
      );
    }
    if (reply.error !== undefined) {
      throw new this.#Error(
        reply.error.code,
        reply.error.message,
        reply.error.details ?? undefined,
        reply.error.retryable ?? false,
      );
    }
    return reply.result;
  }

  /**
   * @internal Settle the native `create`; a failure detaches the listener.
   * `host` is the page's native host: its one core serves one live bridge
   * client, so a second `create` before `close()` settles is refused
   * instead of replacing the first client's core.
   */
  async __open(
    create: () => Promise<NativeReply>,
    host: object,
  ): Promise<void> {
    if (heldHosts.has(host)) {
      this.#release();
      throw new this.#Error(
        'client.native_client_exists',
        'this page already holds the native client; close it before creating another',
      );
    }
    heldHosts.add(host);
    try {
      await this.#reply(create);
    } catch (error) {
      heldHosts.delete(host);
      this.#release();
      throw error;
    }
    this.#host = host;
  }

  /** Dispatch a command through the closed check and the preflight gate. */
  protected async command(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    this.requireOpen();
    if (
      this.#securityLifecycle === 'preflight' &&
      ![
        'authoritySnapshot',
        'securityLifecycle',
        'beginSecurityPreflight',
        'activateSecurity',
        'setTransportEnabled',
        'purgeLocalData',
        'previousVersionDiscard',
        'localRevision',
        'statusSnapshot',
        'drainRealtime',
        'shutdown',
      ].includes(method) &&
      !this.allowPreflightCommand(method)
    ) {
      this.#throwSecurityPreflight();
    }
    return this.#reply(() => this.send(method, params));
  }

  /** Additional preflight operations a host subclass permits. */
  protected allowPreflightCommand(_method: string): boolean {
    return false;
  }

  protected get closed(): boolean {
    return this.#closed;
  }

  protected get preflight(): boolean {
    return this.#securityLifecycle === 'preflight';
  }

  protected requireOpen(): void {
    if (this.#closed) {
      throw new this.#Error(
        'client.closed',
        'the native sync client is closed',
      );
    }
  }

  #throwSecurityPreflight(): never {
    throw new this.#Error(
      SECURITY_PREFLIGHT_REQUIRED_CODE,
      'the local replica is in security preflight; complete quarantine checks and call activateSecurity before accessing protected data',
    );
  }

  #requireActive(): void {
    this.requireOpen();
    if (this.#securityLifecycle === 'preflight') this.#throwSecurityPreflight();
  }

  #cell(value: unknown): SqlValue {
    if (typeof value === 'object' && value !== null && '$bytes' in value) {
      // §7.1: a malformed envelope is refused, never padded into other bytes.
      if (!isBytesEnvelope(value))
        throw new this.#Error(
          'sync.invalid_request',
          'a $bytes envelope requires exactly one $bytes key holding an even-length hexadecimal string',
        );
      return hexToBytes(value.$bytes);
    }
    if (
      typeof value === 'object' &&
      value !== null &&
      '$bigint' in value &&
      typeof value.$bigint === 'string'
    )
      return BigInt(value.$bigint);
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      return value;
    }
    // Other objects keep their JSON text (SQLite json columns arrive as text).
    return JSON.stringify(value);
  }

  /** Decode a native row. Reserved `_sync_*` columns stay engine-internal,
   * so a `SELECT *` row round-trips into `mutate()` values. */
  protected decodeRow(row: Readonly<Record<string, unknown>>): SqlRow {
    const out: SqlRow = {};
    for (const [key, value] of Object.entries(row)) {
      if (!key.startsWith('_sync_')) out[key] = this.#cell(value);
    }
    return out;
  }

  #outcomeRow(
    row: Readonly<Record<string, unknown>>,
  ): Record<string, OutcomeRowValue> {
    const out: Record<string, OutcomeRowValue> = {};
    for (const [key, cell] of Object.entries(this.decodeRow(row))) {
      out[key] =
        typeof cell === 'bigint'
          ? JSON.stringify({ $bigint: String(cell) })
          : cell;
    }
    return out;
  }

  #retainedRows(rows: readonly RetainedCommitRow[]): RetainedCommitRow[] {
    return rows.map((row) => ({
      ...row,
      localRow: row.localRow === null ? null : this.#outcomeRow(row.localRow),
      serverRow:
        row.serverRow === null ? null : this.#outcomeRow(row.serverRow),
      ...(row.uniqueConflicts !== undefined
        ? {
            uniqueConflicts: row.uniqueConflicts.map((conflict) => ({
              ...conflict,
              serverRow: this.#outcomeRow(conflict.serverRow),
            })),
          }
        : {}),
    }));
  }

  #conflict(conflict: ConflictRecord): ConflictRecord {
    return { ...conflict, serverRow: this.#outcomeRow(conflict.serverRow) };
  }

  #commitOutcome(outcome: CommitOutcome): CommitOutcome {
    return {
      ...outcome,
      results: outcome.results.map((result) =>
        result.status === 'conflict'
          ? { ...result, conflict: this.#conflict(result.conflict) }
          : result,
      ),
      ...(outcome.retainedRows !== undefined
        ? { retainedRows: this.#retainedRows(outcome.retainedRows) }
        : {}),
    };
  }

  /** @internal Fan an incoming native event out to the local listeners. */
  __dispatchEvent(event: SyncularEvent): void {
    // A UI listener that throws must never break event dispatch.
    const fanOut = <Args extends unknown[]>(
      listeners: ReadonlySet<(...args: Args) => void>,
      ...args: Args
    ) => {
      for (const listener of listeners) {
        try {
          listener(...args);
        } catch {}
      }
    };
    switch (event.type) {
      case 'progress':
        this.#progress.emit(event.progress as SyncProgress);
        break;
      case 'change': {
        const batch = decodeChangeBatch(event.batch);
        if (batch === undefined) break;
        fanOut(this.#changeListeners, batch);
        if (batch.tables.length === 0) break;
        const tables = new Set<string>();
        const scopeKeys = new Set<string>();
        for (const table of batch.tables) {
          tables.add(table.table);
          for (const key of table.scopeKeys ?? []) scopeKeys.add(key);
        }
        fanOut(this.#invalidationListeners, { tables, scopeKeys });
        break;
      }
      case 'presence':
        fanOut(
          this.#presenceListeners,
          typeof event.scopeKey === 'string' ? event.scopeKey : '',
          event.error as PresenceErrorCode | undefined,
        );
        break;
      case 'diagnostics': {
        const snapshot = event.snapshot as ClientDiagnosticsSnapshot | null;
        if (
          snapshot === null ||
          typeof snapshot !== 'object' ||
          snapshot.version !== CLIENT_DIAGNOSTICS_VERSION ||
          snapshot.host === undefined
        )
          break;
        fanOut(
          this.#diagnosticsListeners,
          withClientDiagnosticsHost(snapshot, {
            ...snapshot.host,
            kind: this.#kind,
            role: 'single',
          }),
        );
        break;
      }
      default:
        // Unknown extension events are deliberately ignored. All durable
        // observable state arrives in the revisioned `change` batch.
        break;
    }
  }

  // -- SyncClientLike --------------------------------------------------------

  async securityLifecycle(): Promise<SecurityLifecycle> {
    this.requireOpen();
    return this.#securityLifecycle;
  }

  beginSecurityPreflight(): Promise<void> {
    if (this.#closed) {
      return Promise.reject(
        new this.#Error('client.closed', 'the native sync client is closed'),
      );
    }
    if (this.#preflightBarrier !== undefined) return this.#preflightBarrier;
    // Flip synchronously so a same-tick query cannot race the native barrier.
    this.#securityLifecycle = 'preflight';
    const barrier = this.command('beginSecurityPreflight', {}).then(() => {});
    this.#preflightBarrier = barrier;
    const settle = () => {
      if (this.#preflightBarrier === barrier)
        this.#preflightBarrier = undefined;
    };
    void barrier.then(settle, settle);
    return barrier;
  }

  /**
   * Complete the security preflight. `headers` optionally carries a fresh
   * FULL transport header set that the native host applies atomically with
   * the activation, before the startup sync it enqueues, so a preflight that
   * outlives the boot token starts its first round with valid credentials
   * (the direct `setHeaders` path stays refused while gated).
   */
  async activateSecurity(
    options: {
      readonly encryption?: EncryptionKeyringConfig;
      readonly headers?: Readonly<Record<string, string>>;
    } = {},
  ): Promise<void> {
    this.requireOpen();
    if (this.#securityLifecycle === 'active') {
      throw new this.#Error(
        'sync.invalid_request',
        'activateSecurity requires the client to be in security preflight',
      );
    }
    await this.#preflightBarrier;
    await this.command('activateSecurity', {
      ...(options.encryption !== undefined
        ? { encryption: encodeValue(options.encryption) }
        : {}),
      ...(options.headers !== undefined ? { headers: options.headers } : {}),
    });
    this.#securityLifecycle = 'active';
  }

  onInvalidate(listener: InvalidationListener): () => void {
    this.requireOpen();
    this.#invalidationListeners.add(listener);
    return () => this.#invalidationListeners.delete(listener);
  }

  onProgress(listener: SyncProgressListener): () => void {
    this.requireOpen();
    return this.#progress.on(listener);
  }

  progressSnapshot(): SyncProgress | undefined {
    this.requireOpen();
    return this.#progress.snapshot();
  }

  onChange(listener: ClientChangeListener): () => void {
    this.requireOpen();
    this.#changeListeners.add(listener);
    return () => this.#changeListeners.delete(listener);
  }

  onDiagnostics(listener: ClientDiagnosticsListener): () => void {
    this.requireOpen();
    this.#diagnosticsListeners.add(listener);
    return () => this.#diagnosticsListeners.delete(listener);
  }

  onPresence(
    listener: (scopeKey: string, error?: PresenceErrorCode) => void,
  ): () => void {
    this.requireOpen();
    this.#presenceListeners.add(listener);
    return () => this.#presenceListeners.delete(listener);
  }

  async query(
    sql: string,
    params: readonly SqlValue[] = [],
  ): Promise<SqlRow[]> {
    this.#requireActive();
    const result = (await this.#reply(() =>
      this.sendQuery(sql, encodeValue(params)),
    )) as { rows?: Readonly<Record<string, unknown>>[] };
    return (result.rows ?? []).map((row) => this.decodeRow(row));
  }

  querySnapshot<Row = SqlRow>(spec: QueryReadSpec): Promise<QuerySnapshot<Row>>;
  async querySnapshot(spec: QueryReadSpec): Promise<QuerySnapshot> {
    this.#requireActive();
    const result = (await this.#reply(() =>
      this.sendQuerySnapshot({
        sql: spec.sql,
        params: encodeValue(spec.params ?? []),
        coverage: spec.coverage ?? [],
        ...(spec.owner !== undefined ? { owner: spec.owner } : {}),
      }),
    )) as {
      revision: string;
      rows: Record<string, unknown>[];
      coverage: QuerySnapshot['coverage'];
    };
    return {
      revision: BigInt(result.revision),
      rows: result.rows.map((row) => this.decodeRow(row)),
      coverage: result.coverage,
    };
  }

  /**
   * §7.5: one atomic read. Every statement and every catch-up and delivery
   * read shares one revision and one read transaction.
   */
  async snapshotRead(request: SnapshotReadRequest): Promise<SnapshotRead> {
    const result = (await this.command('snapshotRead', {
      statements: request.statements.map((statement) => ({
        sql: statement.sql,
        params: encodeValue(statement.params ?? []),
      })),
      coverage: request.coverage ?? [],
      units: request.units ?? [],
      commitIds: request.commitIds ?? [],
      ...(request.owner !== undefined ? { owner: request.owner } : {}),
    })) as {
      revision: string;
      queries: readonly (readonly Record<string, unknown>[])[];
      coverage: SnapshotRead['coverage'];
      units: SnapshotRead['units'];
      deliveries: SnapshotRead['deliveries'];
    };
    return {
      revision: BigInt(result.revision),
      queries: result.queries.map((rows) =>
        rows.map((row) => this.decodeRow(row)),
      ),
      coverage: result.coverage,
      units: result.units,
      deliveries: result.deliveries.map((delivery) =>
        delivery.status === 'known'
          ? { ...delivery, outcome: this.#commitOutcome(delivery.outcome) }
          : delivery,
      ),
    };
  }

  async localRevision(): Promise<bigint> {
    const result = (await this.command('localRevision', {})) as {
      revision: string;
    };
    return BigInt(result.revision);
  }

  async statusSnapshot(): Promise<SyncStatusSnapshot> {
    return (await this.command('statusSnapshot', {})) as SyncStatusSnapshot;
  }

  async diagnosticsSnapshot(): Promise<ClientDiagnosticsSnapshot> {
    const snapshot = (await this.command(
      'diagnosticsSnapshot',
      {},
    )) as ClientDiagnosticsSnapshot;
    return withClientDiagnosticsHost(snapshot, {
      ...snapshot.host,
      kind: this.#kind,
      role: 'single',
    });
  }

  async mutate(mutations: readonly MutationInput[]): Promise<string> {
    const result = (await this.command('mutate', {
      mutations: encodeValue(mutations),
    })) as { clientCommitId: string };
    return result.clientCommitId;
  }

  async patch(
    table: string,
    rowId: string,
    partial: Readonly<Record<string, unknown>>,
    options?: { readonly baseVersion?: number },
  ): Promise<string> {
    const result = (await this.command('patch', {
      table,
      rowId,
      partial: encodeValue(partial),
      ...(options?.baseVersion !== undefined
        ? { baseVersion: options.baseVersion }
        : {}),
    })) as { clientCommitId: string };
    return result.clientCommitId;
  }

  async purgeLocalData(
    input: LocalDataPurgeInput,
  ): Promise<LocalDataPurgeResult> {
    return (await this.command('purgeLocalData', {
      input,
    })) as LocalDataPurgeResult;
  }

  async rebootstrapLocalData(
    input: LocalDataRebootstrapInput,
  ): Promise<LocalDataRebootstrapResult> {
    return decodeLocalDataRebootstrapResult(
      await this.command('rebootstrapLocalData', { input }),
    );
  }

  async previousVersionSnapshot(
    spec: PreviousVersionReadSpec,
  ): Promise<PreviousVersionSnapshot> {
    const reply = await this.command('previousVersionSnapshot', { spec });
    // Decode the row cell envelopes first; a malformed reply passes through
    // untouched so the strict decoder rejects it.
    return decodePreviousVersionSnapshot(
      reply !== null &&
        typeof reply === 'object' &&
        'rows' in reply &&
        Array.isArray(reply.rows)
        ? {
            ...reply,
            rows: reply.rows.map((row) =>
              row !== null && typeof row === 'object' && !Array.isArray(row)
                ? this.decodeRow(row)
                : row,
            ),
          }
        : reply,
    );
  }

  async previousVersionAudit(): Promise<PreviousVersionAudit | undefined> {
    return decodePreviousVersionAuditResult(
      await this.command('previousVersionAudit', {}),
    );
  }

  async previousVersionDiscard(): Promise<{
    present: boolean;
    discarded: boolean;
  }> {
    return decodePreviousVersionDiscardResult(
      await this.command('previousVersionDiscard', {}),
    );
  }

  /**
   * Replace the native transport's request headers at runtime, the auth
   * rotation path. Pass the FULL header set: it replaces the current set.
   * HTTP requests use the new set from the next call; the realtime socket
   * applies it on its next (re)connect.
   */
  async setHeaders(headers: Readonly<Record<string, string>>): Promise<void> {
    this.#requireActive();
    await this.#reply(() => this.sendHeaders(headers));
  }

  // -- Native CRDT (SPEC.md §5.10.5; needs the host's `crdt-yjs` feature) ----

  /** Materialize a `crdt` column's collaborative text from the stored
   * (server-merged) Yjs bytes. `name` selects the shared text (default
   * `"text"`). An absent row or NULL column is the empty document. */
  async crdtText(
    table: string,
    rowId: string,
    column: string,
    name = 'text',
  ): Promise<string> {
    const result = (await this.command('crdtText', {
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
    const result = (await this.command('crdtInsertText', {
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
    const result = (await this.command('crdtDeleteText', {
      table,
      rowId,
      column,
      name,
      index,
      len,
    })) as { clientCommitId: string };
    return result.clientCommitId;
  }

  /** Apply an arbitrary Yjs update onto a `crdt` column. */
  async crdtApplyUpdate(
    table: string,
    rowId: string,
    column: string,
    update: Uint8Array,
  ): Promise<string> {
    const result = (await this.command('crdtApplyUpdate', {
      table,
      rowId,
      column,
      update: encodeValue(update),
    })) as { clientCommitId: string };
    return result.clientCommitId;
  }

  /**
   * Stage a blob for attachment (§5.9.7) and return the canonical `BlobRef`
   * string to store in a `blob_ref` column. The native core owns the upload
   * queue; write the referencing row after this resolves (§5.9.3).
   */
  async uploadBlob(
    bytes: Uint8Array,
    options?: { readonly mediaType?: string; readonly name?: string },
  ): Promise<string> {
    const result = (await this.command('uploadBlob', {
      bytes: encodeValue(bytes),
      ...(options?.mediaType !== undefined
        ? { mediaType: options.mediaType }
        : {}),
      ...(options?.name !== undefined ? { name: options.name } : {}),
    })) as { ref: string };
    return result.ref;
  }

  /**
   * Resolve blob bytes for a `blob_ref` column value or a bare `blobId`
   * (§5.9.7): the native core serves a local cache hit and otherwise
   * downloads and verifies the content address.
   */
  async fetchBlob(ref: string): Promise<{
    readonly blobId: string;
    readonly byteLength: number;
    readonly bytes: Uint8Array;
    readonly mediaType?: string;
  }> {
    const result = (await this.command('fetchBlob', { blob: ref })) as {
      blob: {
        blobId: string;
        byteLength: number;
        bytes: unknown;
        mediaType?: string;
      };
    };
    const bytes = result.blob.bytes;
    if (!isBytesEnvelope(bytes))
      throw new this.#Error(
        'sync.invalid_request',
        'fetchBlob reply carried no $bytes envelope',
      );
    return {
      blobId: result.blob.blobId,
      byteLength: result.blob.byteLength,
      bytes: hexToBytes(bytes.$bytes),
      ...(result.blob.mediaType !== undefined
        ? { mediaType: result.blob.mediaType }
        : {}),
    };
  }

  /** §4.1: register one unit; returns its id. */
  async subscribe(scopes: UnitScopes): Promise<string> {
    return ((await this.command('subscribe', { scopes })) as { id: string }).id;
  }

  /** Register several units in one local transaction; returns their ids. */
  async subscribeMany(units: readonly UnitScopes[]): Promise<string[]> {
    return (
      (await this.command('subscribeMany', { units })) as { ids: string[] }
    ).ids;
  }

  async unsubscribe(id: string): Promise<void> {
    await this.command('unsubscribe', { id });
  }

  /** Every unit in registration order (§4.1), including revoked and failed. */
  async units(): Promise<UnitRecord[]> {
    return ((await this.command('units', {})) as { units: UnitRecord[] }).units;
  }

  async unit(id: string): Promise<UnitRecord | undefined> {
    return (
      ((await this.command('unit', { id })) as { unit: UnitRecord | null })
        .unit ?? undefined
    );
  }

  /** §7.5: one unit's persisted catch-up state (never the owner cache). */
  async unitCatchup(id: string): Promise<UnitCatchup> {
    return (await this.snapshotRead({ statements: [], units: [id] })).units[0]!;
  }

  async setWindow(base: WindowBase, units: readonly string[]): Promise<void> {
    await this.command('setWindow', { base, units });
  }

  async windowState(base: WindowBase): Promise<WindowState> {
    const result = (await this.command('windowState', { base })) as {
      units: string[];
      pending: string[];
    };
    return { units: result.units, pending: result.pending };
  }

  async sync(): Promise<unknown> {
    return this.command('sync', {});
  }

  async syncUntilIdle(
    maxRounds?: number,
    timeoutMs?: number,
  ): Promise<unknown> {
    return this.command('syncUntilIdle', {
      ...(maxRounds !== undefined ? { maxRounds } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
  }

  async proveCurrentBase(
    outcome: Pick<CommitOutcome, 'clientCommitId' | 'sequence'>,
    maxRounds?: number,
  ): Promise<CurrentBaseProof> {
    if (
      maxRounds !== undefined &&
      (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 0xffffffff)
    )
      throw new this.#Error(
        'sync.invalid_request',
        'maxRounds must be a positive integer',
      );
    const proof = (await this.command('proveCurrentBase', {
      outcome: {
        clientCommitId: outcome.clientCommitId,
        sequence: outcome.sequence,
      },
      ...(maxRounds !== undefined ? { maxRounds } : {}),
    })) as CurrentBaseProof;
    return proof.proven
      ? { proven: true, rows: this.#retainedRows(proof.rows) }
      : proof;
  }

  async conflicts(): Promise<readonly ConflictRecord[]> {
    const result = (await this.command('conflicts', {})) as {
      conflicts: ConflictRecord[];
    };
    return result.conflicts.map((conflict) => this.#conflict(conflict));
  }

  async rejections(): Promise<readonly RejectionRecord[]> {
    const result = (await this.command('rejections', {})) as {
      rejections: RejectionRecord[];
    };
    return result.rejections;
  }

  async commitOutcome(
    clientCommitId: string,
  ): Promise<CommitOutcome | undefined> {
    const result = (await this.command('commitOutcome', {
      clientCommitId,
    })) as { outcome?: CommitOutcome };
    return result.outcome === undefined
      ? undefined
      : this.#commitOutcome(result.outcome);
  }

  async commitOutcomes(
    query: CommitOutcomeQuery = {},
  ): Promise<readonly CommitOutcome[]> {
    const result = (await this.command('commitOutcomes', { query })) as {
      outcomes: CommitOutcome[];
    };
    return result.outcomes.map((outcome) => this.#commitOutcome(outcome));
  }

  async resolveCommitOutcome(
    input: ResolveCommitOutcomeInput,
  ): Promise<CommitOutcome> {
    const result = (await this.command('resolveCommitOutcome', {
      input,
    })) as { outcome: CommitOutcome };
    return this.#commitOutcome(result.outcome);
  }

  async pendingCommits(): Promise<unknown[]> {
    const result = (await this.command('pendingCommitIds', {})) as {
      ids: string[];
    };
    return result.ids;
  }

  async presence(scopeKey: string): Promise<readonly PresencePeer[]> {
    const result = (await this.command('presence', { scopeKey })) as {
      peers: PresencePeer[];
    };
    return result.peers;
  }

  async setPresence(
    scopeKey: string,
    doc: Record<string, unknown> | null,
  ): Promise<void> {
    await this.command('setPresence', { scopeKey, doc });
  }

  async connectRealtime(): Promise<void> {
    await this.command('connectRealtime', {});
  }

  async disconnectRealtime(): Promise<void> {
    await this.command('disconnectRealtime', {});
  }

  /**
   * Shut down the native core, then detach listeners. Every call returns the
   * same promise, so a concurrent or repeated close settles only when the one
   * native shutdown settles, with its outcome.
   */
  close(): Promise<void> {
    if (this.#closing === undefined) {
      const shutdown = this.shutdown();
      this.#closed = true;
      this.#closing = shutdown.finally(() => {
        if (this.#host !== undefined) heldHosts.delete(this.#host);
        this.#release();
        this.#invalidationListeners.clear();
        this.#progress.clear();
        this.#changeListeners.clear();
        this.#diagnosticsListeners.clear();
        this.#presenceListeners.clear();
      });
    }
    return this.#closing;
  }
}
