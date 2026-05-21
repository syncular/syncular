import { Database } from 'bun:sqlite';
import type {
  SyncularBridge,
  SyncularBridgeMutationBatch,
  SyncularBridgeQueryRequest,
  SyncularBridgeQueryResult,
  SyncularBridgeStatus,
  SyncularV2AuthLeaseRecord,
  SyncularV2ClientEventMap,
  SyncularV2ClientEventSink,
  SyncularV2ClientEventType,
  SyncularV2ConflictResolution,
  SyncularV2ConflictStats,
  SyncularV2ConflictSummary,
  SyncularV2ConnectionState,
  SyncularV2LifecycleState,
  SyncularV2PresenceChangeEvent,
  SyncularV2PresenceEntry,
  SyncularV2PresenceSink,
  SyncularV2SubscriptionSpec,
  SyncularV2SyncResult,
} from '@syncular/client';
import type { SyncAuthLeaseIssueRequest, SyncOperation } from '@syncular/core';
import type { AsyncDisposableResource } from './disposable';
import { createAsyncDisposableResource } from './disposable';

export type ClientBridgeSeed = Record<
  string,
  readonly Record<string, unknown>[]
>;

export type ClientBridgeTauriInvoke = <TResult>(
  command: string,
  args?: Record<string, unknown>
) => Promise<TResult>;

export type ClientBridgeTauriListen = <TPayload>(
  event: string,
  handler: (event: { payload: TPayload }) => void
) => Promise<() => void>;

export type ClientBridgeNativeEventSubscription =
  | (() => void)
  | { remove(): void };

export interface ClientBridgeNativeModule {
  executeSql<Row extends Record<string, unknown> = Record<string, unknown>>(
    request: SyncularBridgeQueryRequest
  ): Promise<SyncularBridgeQueryResult<Row>> | SyncularBridgeQueryResult<Row>;
  applyMutationsCommit(
    batch: SyncularBridgeMutationBatch
  ): Promise<string> | string;
  applyLeasedMutationsCommit?(
    batch: SyncularBridgeMutationBatch
  ): Promise<string> | string;
  sync?(): Promise<SyncularV2SyncResult>;
  resumeFromBackground?(): Promise<SyncularV2SyncResult>;
  start?(): Promise<void>;
  stop?(): Promise<void>;
  setSubscriptions?(
    subscriptions: readonly SyncularV2SubscriptionSpec[]
  ): Promise<void>;
  getStatus?(): SyncularBridgeStatus;
  issueAuthLease?(
    request: SyncAuthLeaseIssueRequest
  ): Promise<SyncularV2AuthLeaseRecord>;
  upsertAuthLease?(lease: SyncularV2AuthLeaseRecord): Promise<void>;
  authLease?(leaseId: string): Promise<SyncularV2AuthLeaseRecord | null>;
  activeAuthLeases?(
    actorId?: string | null,
    nowMs?: number
  ): Promise<SyncularV2AuthLeaseRecord[]>;
  addListener?<T extends SyncularV2ClientEventType>(
    event: T,
    listener: SyncularV2ClientEventSink<T>
  ): ClientBridgeNativeEventSubscription;
  getPresence?<TMetadata = Record<string, unknown>>(
    scopeKey: string
  ): SyncularV2PresenceEntry<TMetadata>[];
  joinPresence?(scopeKey: string, metadata?: Record<string, unknown>): void;
  leavePresence?(scopeKey: string): void;
  updatePresenceMetadata?(
    scopeKey: string,
    metadata: Record<string, unknown>
  ): void;
  conflictSummaries?(): Promise<SyncularV2ConflictSummary[]>;
  retryConflictKeepLocal?(id: string): Promise<string>;
  resolveConflict?(
    id: string,
    resolution: SyncularV2ConflictResolution
  ): Promise<void>;
}

export interface CreateClientBridgeHarnessOptions {
  seed?: ClientBridgeSeed;
  idColumn?: string;
  actorId?: string;
  clientId?: string;
}

export interface ClientBridgeInvocation {
  command: string;
  args: Record<string, unknown> | undefined;
}

export interface ClientBridgeSqlQuery extends SyncularBridgeQueryRequest {}

export interface ClientBridgeHarness {
  bridge: SyncularBridge;
  tauri: {
    invoke: ClientBridgeTauriInvoke;
    listen: ClientBridgeTauriListen;
    invocations(): ClientBridgeInvocation[];
  };
  reactNative: {
    module: ClientBridgeNativeModule;
  };
  queries(): ClientBridgeSqlQuery[];
  batches(): SyncularBridgeMutationBatch[];
  leasedBatches(): SyncularBridgeMutationBatch[];
  operations(): SyncOperation[];
  syncCount(): number;
  listenerCount(event: SyncularV2ClientEventType): number;
  rows(table: string): Record<string, unknown>[];
  setRows(table: string, rows: readonly Record<string, unknown>[]): void;
  setStatus(status: SyncularBridgeStatus): void;
  setConflicts(conflicts: readonly SyncularV2ConflictSummary[]): void;
  authLease(leaseId: string): SyncularV2AuthLeaseRecord | null;
  authLeases(): SyncularV2AuthLeaseRecord[];
  emit<T extends SyncularV2ClientEventType>(
    event: T,
    payload: SyncularV2ClientEventMap[T]
  ): void;
  emitRowsChanged(event: SyncularV2ClientEventMap['rowsChanged']): void;
  presence<TMetadata = Record<string, unknown>>(
    scopeKey: string
  ): SyncularV2PresenceEntry<TMetadata>[];
  close(): void;
}

export async function createClientBridgeHarness(
  options: CreateClientBridgeHarnessOptions = {}
): Promise<AsyncDisposableResource<ClientBridgeHarness>> {
  const harness = new InProcessClientBridgeHarness(options);
  return createAsyncDisposableResource(harness, () => harness.close());
}

class InProcessClientBridgeHarness implements ClientBridgeHarness {
  readonly #db = new Database(':memory:');
  readonly #idColumn: string;
  readonly #actorId: string;
  readonly #clientId: string;
  readonly #queries: ClientBridgeSqlQuery[] = [];
  readonly #batches: SyncularBridgeMutationBatch[] = [];
  readonly #leasedBatches: SyncularBridgeMutationBatch[] = [];
  readonly #invocations: ClientBridgeInvocation[] = [];
  readonly #listeners = new Map<
    SyncularV2ClientEventType,
    Set<SyncularV2ClientEventSink<SyncularV2ClientEventType>>
  >();
  readonly #tauriListeners = new Map<
    string,
    Set<(event: { payload: unknown }) => void>
  >();
  readonly #presenceListeners = new Set<SyncularV2PresenceSink>();
  readonly #presence = new Map<string, SyncularV2PresenceEntry[]>();
  #conflicts: SyncularV2ConflictSummary[] = [];
  #status: SyncularBridgeStatus = {};
  #authLeases = new Map<string, SyncularV2AuthLeaseRecord>();
  #syncCount = 0;
  #commitIndex = 1;
  #leaseIndex = 1;

  constructor(options: CreateClientBridgeHarnessOptions) {
    this.#idColumn = options.idColumn ?? 'id';
    this.#actorId = options.actorId ?? 'actor-test';
    this.#clientId = options.clientId ?? 'client-test';
    for (const [table, rows] of Object.entries(options.seed ?? {})) {
      this.setRows(table, rows);
    }
  }

  readonly bridge: SyncularBridge = {
    executeSql: (request) => this.executeSql(request),
    applyMutationsCommit: (batch) => this.applyMutationsCommit(batch),
    applyLeasedMutationsCommit: (batch) =>
      this.applyMutationsCommit(batch, { leased: true }),
    sync: () => this.sync(),
    resumeFromBackground: () => this.resumeFromBackground(),
    start: async () => {
      this.setConnection('connected');
    },
    stop: async () => {
      this.setConnection('disconnected');
    },
    setSubscriptions: async () => undefined,
    getStatus: () => this.#status,
    issueAuthLease: (request) => this.issueAuthLease(request),
    upsertAuthLease: async (lease) => {
      this.#authLeases.set(lease.leaseId, { ...lease });
    },
    authLease: async (leaseId) => this.authLease(leaseId),
    activeAuthLeases: async (actorId, nowMs) =>
      this.activeAuthLeases(actorId, nowMs),
    on: (event, listener) => this.addEventListener(event, listener),
    presence: {
      get: (scopeKey) => this.presence(scopeKey),
      join: (scopeKey, metadata) => this.joinPresence(scopeKey, metadata),
      leave: (scopeKey) => this.leavePresence(scopeKey),
      updateMetadata: (scopeKey, metadata) =>
        this.updatePresenceMetadata(scopeKey, metadata),
      onChange: (listener) => {
        this.#presenceListeners.add(listener as SyncularV2PresenceSink);
        return () =>
          this.#presenceListeners.delete(listener as SyncularV2PresenceSink);
      },
    },
    conflicts: {
      list: async () => this.#conflicts,
      retryKeepLocal: async (id) => `retry-${id}`,
      resolve: async (id, resolution) => {
        this.#conflicts = this.#conflicts.map((conflict) =>
          conflict.id === id
            ? { ...conflict, resolvedAt: Date.now(), resolution }
            : conflict
        );
        this.emit('conflictsChanged', conflictStats(this.#conflicts));
      },
    },
  };

  readonly tauri = {
    invoke: (async <TResult>(
      command: string,
      args?: Record<string, unknown>
    ) => {
      this.#invocations.push({ command, args });
      return this.handleTauriCommand(command, args) as TResult;
    }) satisfies ClientBridgeTauriInvoke,
    listen: (async <TPayload>(
      event: string,
      handler: (event: { payload: TPayload }) => void
    ) => {
      const listeners = this.#tauriListeners.get(event) ?? new Set();
      const wrapped = handler as (event: { payload: unknown }) => void;
      listeners.add(wrapped);
      this.#tauriListeners.set(event, listeners);
      return () => listeners.delete(wrapped);
    }) satisfies ClientBridgeTauriListen,
    invocations: () => [...this.#invocations],
  };

  readonly reactNative = {
    module: {
      executeSql: (request) => this.executeSql(request),
      applyMutationsCommit: (batch) =>
        this.applyMutationsCommit(batch).commitId,
      applyLeasedMutationsCommit: (batch) =>
        this.applyMutationsCommit(batch, { leased: true }).commitId,
      sync: () => this.sync(),
      resumeFromBackground: () => this.resumeFromBackground(),
      start: async () => {
        this.setConnection('connected');
      },
      stop: async () => {
        this.setConnection('disconnected');
      },
      setSubscriptions: async (_subscriptions) => undefined,
      getStatus: () => this.#status,
      issueAuthLease: (request) => this.issueAuthLease(request),
      upsertAuthLease: async (lease) => {
        this.#authLeases.set(lease.leaseId, { ...lease });
      },
      authLease: async (leaseId) => this.authLease(leaseId),
      activeAuthLeases: async (actorId, nowMs) =>
        this.activeAuthLeases(actorId, nowMs),
      addListener: (event, listener) =>
        this.reactNativeSubscription(this.addEventListener(event, listener)),
      getPresence: (scopeKey) => this.presence(scopeKey),
      joinPresence: (scopeKey, metadata) =>
        this.joinPresence(scopeKey, metadata),
      leavePresence: (scopeKey) => this.leavePresence(scopeKey),
      updatePresenceMetadata: (scopeKey, metadata) =>
        this.updatePresenceMetadata(scopeKey, metadata),
      conflictSummaries: async () => this.#conflicts,
      retryConflictKeepLocal: async (id) => `retry-${id}`,
      resolveConflict: async (id, resolution) => {
        await this.bridge.conflicts?.resolve(id, resolution);
      },
    } satisfies ClientBridgeNativeModule,
  };

  queries(): ClientBridgeSqlQuery[] {
    return [...this.#queries];
  }

  batches(): SyncularBridgeMutationBatch[] {
    return [...this.#batches];
  }

  leasedBatches(): SyncularBridgeMutationBatch[] {
    return [...this.#leasedBatches];
  }

  operations(): SyncOperation[] {
    return [...this.#batches, ...this.#leasedBatches].flatMap(
      (batch) => batch.operations
    );
  }

  syncCount(): number {
    return this.#syncCount;
  }

  listenerCount(event: SyncularV2ClientEventType): number {
    return this.#listeners.get(event)?.size ?? 0;
  }

  rows(table: string): Record<string, unknown>[] {
    this.ensureTable(table);
    return this.#db.query(`select * from ${quoteIdent(table)}`).all() as Record<
      string,
      unknown
    >[];
  }

  setRows(table: string, rows: readonly Record<string, unknown>[]): void {
    this.ensureTable(table, rows);
    this.#db.run(`delete from ${quoteIdent(table)}`);
    for (const row of rows) {
      this.upsertRow(table, row);
    }
  }

  setStatus(status: SyncularBridgeStatus): void {
    this.#status = status;
  }

  setConflicts(conflicts: readonly SyncularV2ConflictSummary[]): void {
    this.#conflicts = [...conflicts];
    this.emit('conflictsChanged', conflictStats(this.#conflicts));
  }

  authLease(leaseId: string): SyncularV2AuthLeaseRecord | null {
    const lease = this.#authLeases.get(leaseId);
    return lease ? { ...lease } : null;
  }

  authLeases(): SyncularV2AuthLeaseRecord[] {
    return [...this.#authLeases.values()].map((lease) => ({ ...lease }));
  }

  emit<T extends SyncularV2ClientEventType>(
    event: T,
    payload: SyncularV2ClientEventMap[T]
  ): void {
    for (const listener of this.#listeners.get(event) ?? []) {
      listener(payload as never);
    }
    this.emitTauri(`syncular:${event}`, payload);
  }

  emitRowsChanged(event: SyncularV2ClientEventMap['rowsChanged']): void {
    this.emit('rowsChanged', event);
  }

  presence<TMetadata = Record<string, unknown>>(
    scopeKey: string
  ): SyncularV2PresenceEntry<TMetadata>[] {
    return [
      ...(this.#presence.get(scopeKey) ?? []),
    ] as SyncularV2PresenceEntry<TMetadata>[];
  }

  close(): void {
    this.#db.close();
    this.#listeners.clear();
    this.#tauriListeners.clear();
    this.#presenceListeners.clear();
  }

  private executeSql<Row extends Record<string, unknown>>(
    request: SyncularBridgeQueryRequest
  ): SyncularBridgeQueryResult<Row> {
    this.#queries.push(request);
    const statement = this.#db.query(request.sql);
    const rows = statement.all(...(request.parameters as never[])) as Row[];
    return { rows };
  }

  private applyMutationsCommit(
    batch: SyncularBridgeMutationBatch,
    options: { leased?: boolean } = {}
  ): {
    commitId: string;
    clientCommitId: string;
  } {
    const target = options.leased ? this.#leasedBatches : this.#batches;
    target.push({
      operations: batch.operations.map((operation) => ({ ...operation })),
    });
    const commitId = `bridge-commit-${this.#commitIndex++}`;
    for (const operation of batch.operations) {
      this.applyOperation(operation);
    }
    return { commitId, clientCommitId: commitId };
  }

  private async sync(): Promise<SyncularV2SyncResult> {
    this.#syncCount += 1;
    return zeroSyncResult();
  }

  private async resumeFromBackground(): Promise<SyncularV2SyncResult> {
    this.setConnection('connected');
    return this.sync();
  }

  private async issueAuthLease(
    request: SyncAuthLeaseIssueRequest
  ): Promise<SyncularV2AuthLeaseRecord> {
    const nowMs = Date.now();
    const leaseId = `bridge-lease-${this.#leaseIndex++}`;
    const expiresAtMs = nowMs + (request.ttlMs ?? 60_000);
    const payload = {
      version: 1,
      leaseId,
      issuer: 'syncular-testkit',
      audience: 'syncular-testkit',
      actorId: this.#actorId,
      subject: {},
      schemaVersion: request.schemaVersion,
      protocolVersion: 1,
      issuedAtMs: nowMs,
      notBeforeMs: nowMs,
      expiresAtMs,
      maxClockSkewMs: 0,
      scopes: request.scopes,
      capabilities: {
        allowBlobs: true,
        allowCrdt: true,
        allowEncryptedFields: true,
      },
    };
    const lease: SyncularV2AuthLeaseRecord = {
      leaseId,
      kid: 'syncular-testkit',
      actorId: this.#actorId,
      issuedAtMs: nowMs,
      notBeforeMs: nowMs,
      expiresAtMs,
      schemaVersion: request.schemaVersion,
      payloadJson: JSON.stringify(payload),
      token: `testkit.${leaseId}`,
      status: 'active',
      lastValidationError: null,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    };
    this.#authLeases.set(leaseId, lease);
    return { ...lease };
  }

  private handleTauriCommand(
    command: string,
    args: Record<string, unknown> | undefined
  ): unknown {
    switch (command) {
      case 'syncular_execute_sql':
        return this.executeSql(args?.request as SyncularBridgeQueryRequest);
      case 'syncular_apply_mutations_commit':
        return this.applyMutationsCommit(
          args?.batch as SyncularBridgeMutationBatch
        ).commitId;
      case 'syncular_apply_leased_mutations_commit':
        return this.applyMutationsCommit(
          args?.batch as SyncularBridgeMutationBatch,
          { leased: true }
        ).commitId;
      case 'syncular_sync':
        return this.sync();
      case 'syncular_resume_from_background':
        return this.resumeFromBackground();
      case 'syncular_start':
        return this.bridge.start?.();
      case 'syncular_stop':
        return this.bridge.stop?.();
      case 'syncular_set_subscriptions':
        return undefined;
      case 'syncular_issue_auth_lease':
        return this.issueAuthLease(args?.request as SyncAuthLeaseIssueRequest);
      case 'syncular_upsert_auth_lease':
        this.#authLeases.set(
          (args?.lease as SyncularV2AuthLeaseRecord).leaseId,
          { ...(args?.lease as SyncularV2AuthLeaseRecord) }
        );
        return undefined;
      case 'syncular_auth_lease':
        return this.authLease(String(args?.leaseId));
      case 'syncular_active_auth_leases':
        return this.activeAuthLeases(
          args?.actorId == null ? null : String(args.actorId),
          typeof args?.nowMs === 'number' ? args.nowMs : undefined
        );
      case 'syncular_join_presence':
        return this.joinPresence(
          String(args?.scopeKey),
          args?.metadata as Record<string, unknown> | undefined
        );
      case 'syncular_leave_presence':
        return this.leavePresence(String(args?.scopeKey));
      case 'syncular_update_presence_metadata':
        return this.updatePresenceMetadata(
          String(args?.scopeKey),
          args?.metadata as Record<string, unknown>
        );
      case 'syncular_conflict_summaries':
        return this.#conflicts;
      case 'syncular_retry_conflict_keep_local':
        return `retry-${String(args?.id)}`;
      case 'syncular_resolve_conflict':
        return this.bridge.conflicts?.resolve(
          String(args?.id),
          args?.resolution as SyncularV2ConflictResolution
        );
      default:
        throw new Error(`Unknown Syncular test bridge command: ${command}`);
    }
  }

  private addEventListener<T extends SyncularV2ClientEventType>(
    event: T,
    listener: SyncularV2ClientEventSink<T>
  ): () => void {
    const listeners = this.#listeners.get(event) ?? new Set();
    listeners.add(
      listener as SyncularV2ClientEventSink<SyncularV2ClientEventType>
    );
    this.#listeners.set(event, listeners);
    return () =>
      listeners.delete(
        listener as SyncularV2ClientEventSink<SyncularV2ClientEventType>
      );
  }

  private emitTauri(event: string, payload: unknown): void {
    for (const listener of this.#tauriListeners.get(event) ?? []) {
      listener({ payload });
    }
  }

  private reactNativeSubscription(
    unsubscribe: () => void
  ): ClientBridgeNativeEventSubscription {
    return { remove: unsubscribe };
  }

  private setConnection(realtime: SyncularV2ConnectionState['realtime']): void {
    const connection: SyncularV2ConnectionState = {
      closed: false,
      pendingRequests: 0,
      realtime,
    };
    const lifecycle: SyncularV2LifecycleState = {
      phase: realtime === 'connected' ? 'complete' : 'offline',
      realtime,
      online: realtime === 'connected',
      requiresAction: false,
      pendingRequests: 0,
    };
    this.#status = { ...this.#status, connection, lifecycle };
    this.emit('lifecycleChanged', lifecycle);
  }

  private joinPresence(
    scopeKey: string,
    metadata?: Record<string, unknown>
  ): void {
    this.#presence.set(scopeKey, [
      {
        clientId: this.#clientId,
        actorId: this.#actorId,
        joinedAt: Date.now(),
        metadata,
      },
    ]);
    this.emitPresence(scopeKey);
  }

  private leavePresence(scopeKey: string): void {
    this.#presence.set(scopeKey, []);
    this.emitPresence(scopeKey);
  }

  private updatePresenceMetadata(
    scopeKey: string,
    metadata: Record<string, unknown>
  ): void {
    this.#presence.set(
      scopeKey,
      this.presence(scopeKey).map((entry) => ({ ...entry, metadata }))
    );
    this.emitPresence(scopeKey);
  }

  private emitPresence(scopeKey: string): void {
    const event: SyncularV2PresenceChangeEvent = {
      scopeKey,
      presence: this.presence(scopeKey),
    };
    for (const listener of this.#presenceListeners) listener(event);
    this.emit('presenceChanged', event);
  }

  private activeAuthLeases(
    actorId?: string | null,
    nowMs = Date.now()
  ): SyncularV2AuthLeaseRecord[] {
    return this.authLeases().filter(
      (lease) =>
        lease.status === 'active' &&
        lease.notBeforeMs <= nowMs &&
        lease.expiresAtMs > nowMs &&
        (actorId == null || lease.actorId === actorId)
    );
  }

  private applyOperation(operation: SyncOperation): void {
    if (operation.op === 'delete') {
      this.ensureTable(operation.table);
      this.#db
        .query(
          `delete from ${quoteIdent(operation.table)} where ${quoteIdent(
            this.#idColumn
          )} = ?`
        )
        .run(operation.row_id);
      this.emitOperationChange(operation);
      return;
    }

    this.upsertRow(operation.table, {
      [this.#idColumn]: operation.row_id,
      ...(operation.payload ?? {}),
    });
    this.emitOperationChange(operation);
  }

  private emitOperationChange(operation: SyncOperation): void {
    this.emitRowsChanged({
      source: 'localWrite',
      changedTables: [operation.table],
      changedRows: [
        {
          table: operation.table,
          rowId: operation.row_id,
          operation: operation.op === 'delete' ? 'delete' : 'update',
          changedFields: Object.keys(operation.payload ?? {}),
          crdtFields: [],
        },
      ],
    });
  }

  private upsertRow(table: string, row: Record<string, unknown>): void {
    this.ensureTable(table, [row]);
    const columns = Object.keys(row);
    const assignments = columns
      .filter((column) => column !== this.#idColumn)
      .map((column) => `${quoteIdent(column)} = excluded.${quoteIdent(column)}`)
      .join(', ');
    const sql = `insert into ${quoteIdent(table)} (${columns
      .map(quoteIdent)
      .join(', ')}) values (${columns
      .map(() => '?')
      .join(', ')}) on conflict(${quoteIdent(this.#idColumn)}) do update set ${
      assignments ||
      `${quoteIdent(this.#idColumn)} = excluded.${quoteIdent(this.#idColumn)}`
    }`;
    const statement = this.#db.query(sql) as unknown as {
      run: (...bindings: unknown[]) => unknown;
    };
    statement.run(...columns.map((column) => encodeSqlValue(row[column])));
  }

  private ensureTable(
    table: string,
    rows: readonly Record<string, unknown>[] = []
  ): void {
    this.#db.run(
      `create table if not exists ${quoteIdent(table)} (${quoteIdent(
        this.#idColumn
      )} text primary key)`
    );
    const columns = new Set<string>([this.#idColumn]);
    for (const row of rows) {
      for (const column of Object.keys(row)) columns.add(column);
    }
    const existing = new Set(
      (
        this.#db
          .query(`pragma table_info(${quoteIdent(table)})`)
          .all() as Array<{
          name: string;
        }>
      ).map((column) => column.name)
    );
    for (const column of columns) {
      if (!existing.has(column)) {
        this.#db.run(
          `alter table ${quoteIdent(table)} add column ${quoteIdent(
            column
          )} ${column === this.#idColumn ? 'text' : 'any'}`
        );
      }
    }
  }
}

function quoteIdent(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function encodeSqlValue(value: unknown): unknown {
  if (value == null) return null;
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    typeof value === 'boolean' ||
    value instanceof Uint8Array
  ) {
    return value;
  }
  return JSON.stringify(value);
}

function conflictStats(
  conflicts: readonly SyncularV2ConflictSummary[]
): SyncularV2ConflictStats {
  const resolved = conflicts.filter((conflict) => conflict.resolvedAt != null);
  return {
    unresolved: conflicts.length - resolved.length,
    resolved: resolved.length,
    total: conflicts.length,
  };
}

function zeroSyncResult(): SyncularV2SyncResult {
  return {
    changedTables: [],
    changedRows: [],
    changedRowsTruncated: false,
    subscriptions: [],
    bootstrap: {
      channelPhase: 'idle',
      progressPercent: 100,
      isBootstrapping: false,
      criticalReady: true,
      interactiveReady: true,
      complete: true,
      activePhase: null,
      expectedSubscriptionIds: [],
      readySubscriptionIds: [],
      pendingSubscriptionIds: [],
      subscriptions: [],
      phases: [],
    },
    pushedCommits: 0,
    timings: {
      totalMs: 0,
      pushMs: 0,
      pullMs: 0,
      pullRequestMs: 0,
      syncPackDecodeMs: 0,
      pullTransformMs: 0,
      integrityVerifyMs: 0,
      snapshotFetchMs: 0,
      pullApplyMs: 0,
      scopeClearMs: 0,
      snapshotRowApplyMs: 0,
      snapshotArtifactApplyMs: 0,
      snapshotArtifactCheckpointMs: 0,
      snapshotArtifactCheckpointCount: 0,
      snapshotChunkApplyMs: 0,
      snapshotChunkMaterializeMs: 0,
      snapshotChunkResetMs: 0,
      snapshotChunkBindMs: 0,
      snapshotChunkStepMs: 0,
      commitApplyMs: 0,
      subscriptionStateMs: 0,
      notifyMs: 0,
    },
  };
}
