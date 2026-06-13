import {
  randomId,
  type SyncAuthLeaseIssueRequest,
  type SyncOperation,
} from '@syncular/core';
import {
  type CompiledQuery,
  type DatabaseConnection,
  type Dialect,
  Kysely,
  type QueryResult,
} from 'kysely';
import { BaseSqliteDialect, BaseSqliteDriver } from 'kysely-generic-sqlite';
import type {
  SyncularBlobClientLike,
  SyncularClientLike,
  SyncularClientStatus,
} from './client';
import {
  createMutationsApi,
  type MutationReceipt,
  type MutationsApi,
  type MutationsCommitFn,
  type MutationsTx,
} from './mutations';
import { assertSyncularReadonlySql } from './sql-safety';
import type {
  SyncularAuthLeaseRecord,
  SyncularClientEventSink,
  SyncularClientEventType,
  SyncularConflictResolution,
  SyncularConflictStats,
  SyncularConflictSummary,
  SyncularConnectionState,
  SyncularDiagnosticSnapshot,
  SyncularLifecycleState,
  SyncularOutboxStats,
  SyncularPresenceEntry,
  SyncularPresenceSink,
  SyncularSubscriptionSpec,
  SyncularSyncRequestOptions,
  SyncularSyncResult,
} from './types';

export interface SyncularBridgeQueryRequest {
  sql: string;
  parameters: readonly unknown[];
}

export interface SyncularBridgeQueryResult<
  Row extends Record<string, unknown> = Record<string, unknown>,
> {
  rows: Row[];
  numAffectedRows?: bigint | number | string;
  insertId?: bigint | number | string | null;
}

export interface SyncularBridgeMutationBatch {
  operations: SyncOperation[];
}

export interface SyncularBridgeStatus {
  lifecycle?: SyncularLifecycleState;
  connection?: SyncularConnectionState;
  outbox?: SyncularOutboxStats | null;
  conflicts?: SyncularConflictStats | null;
}

export interface SyncularBridgePresence {
  get<TMetadata = Record<string, unknown>>(
    scopeKey: string
  ): SyncularPresenceEntry<TMetadata>[];
  join(scopeKey: string, metadata?: Record<string, unknown>): void;
  leave(scopeKey: string): void;
  updateMetadata(scopeKey: string, metadata: Record<string, unknown>): void;
  onChange<TMetadata = Record<string, unknown>>(
    listener: SyncularPresenceSink<TMetadata>
  ): () => void;
}

export interface SyncularBridgeConflicts {
  list(): Promise<SyncularConflictSummary[]>;
  retryKeepLocal(id: string): Promise<string>;
  resolve(id: string, resolution: SyncularConflictResolution): Promise<void>;
}

export interface SyncularBridge {
  open?(): Promise<void> | void;
  close?(): Promise<void> | void;
  executeSql<Row extends Record<string, unknown> = Record<string, unknown>>(
    request: SyncularBridgeQueryRequest
  ): Promise<SyncularBridgeQueryResult<Row>> | SyncularBridgeQueryResult<Row>;
  applyMutationsCommit(
    batch: SyncularBridgeMutationBatch
  ): Promise<string | MutationReceipt> | string | MutationReceipt;
  applyLeasedMutationsCommit?(
    batch: SyncularBridgeMutationBatch
  ): Promise<string | MutationReceipt> | string | MutationReceipt;
  sync?(): Promise<SyncularSyncResult>;
  resumeFromBackground?(
    options?: SyncularSyncRequestOptions
  ): Promise<SyncularSyncResult>;
  start?(): Promise<void>;
  stop?(): Promise<void>;
  setSubscriptions?(
    subscriptions: readonly SyncularSubscriptionSpec[]
  ): Promise<void>;
  getStatus?(): Promise<SyncularBridgeStatus> | SyncularBridgeStatus;
  issueAuthLease?(
    request: SyncAuthLeaseIssueRequest
  ): Promise<SyncularAuthLeaseRecord>;
  upsertAuthLease?(lease: SyncularAuthLeaseRecord): Promise<void>;
  authLease?(leaseId: string): Promise<SyncularAuthLeaseRecord | null>;
  activeAuthLeases?(
    actorId?: string | null,
    nowMs?: number
  ): Promise<SyncularAuthLeaseRecord[]>;
  diagnosticSnapshot?(): Promise<SyncularDiagnosticSnapshot>;
  on?<T extends SyncularClientEventType>(
    event: T,
    listener: SyncularClientEventSink<T>
  ): () => void;
  presence?: SyncularBridgePresence;
  conflicts?: SyncularBridgeConflicts;
  blobs?: Partial<SyncularBlobClientLike>;
}

export interface CreateSyncularBridgeClientOptions {
  bridge: SyncularBridge;
  sync?: {
    autoSyncAfterMutation?: boolean;
  };
  idColumn?: string;
  versionColumn?: string | null;
  omitColumns?: readonly string[];
}

export function createSyncularBridgeDialect(bridge: SyncularBridge): Dialect {
  return new BaseSqliteDialect(() => new SyncularBridgeDriver(bridge));
}

export async function createSyncularBridgeClient<DB>(
  options: CreateSyncularBridgeClientOptions
): Promise<SyncularClientLike<DB>> {
  await options.bridge.open?.();
  const dialect = createSyncularBridgeDialect(options.bridge);
  const db = new Kysely<DB>({ dialect });
  let closed = false;
  const syncAfterMutation = options.sync?.autoSyncAfterMutation !== false;

  const client: SyncularClientLike<DB> = {
    db,
    dialect,
    mutations: createSyncularBridgeMutations<DB>(options, async () => {
      if (syncAfterMutation) await client.sync().catch(() => undefined);
    }),
    leasedMutations: createSyncularBridgeMutations<DB>(
      options,
      async () => {
        if (syncAfterMutation) await client.sync().catch(() => undefined);
      },
      { leased: true }
    ),
    blobs: createBridgeBlobs(options.bridge),
    on: (event, listener) => options.bridge.on?.(event, listener) ?? noop,
    getStatus: () => resolveBridgeStatusSnapshot(options.bridge),
    setSubscriptions: async (subscriptions) => {
      await options.bridge.setSubscriptions?.(subscriptions);
    },
    resumeFromBackground: (syncOptions) =>
      requireBridgeMethod(
        options.bridge.resumeFromBackground,
        'resumeFromBackground'
      )(syncOptions),
    issueAuthLease: (request) =>
      requireBridgeMethod(
        options.bridge.issueAuthLease,
        'issueAuthLease'
      )(request),
    upsertAuthLease: (lease) =>
      requireBridgeMethod(
        options.bridge.upsertAuthLease,
        'upsertAuthLease'
      )(lease),
    authLease: (leaseId) =>
      requireBridgeMethod(options.bridge.authLease, 'authLease')(leaseId),
    activeAuthLeases: (actorId, nowMs) =>
      requireBridgeMethod(options.bridge.activeAuthLeases, 'activeAuthLeases')(
        actorId,
        nowMs
      ),
    diagnosticSnapshot: () =>
      requireBridgeMethod(
        options.bridge.diagnosticSnapshot,
        'diagnosticSnapshot'
      )(),
    presence: createBridgePresence(options.bridge),
    conflicts: createBridgeConflicts(options.bridge),
    start: async () => {
      await options.bridge.start?.();
    },
    stop: async () => {
      await options.bridge.stop?.();
    },
    sync: async () => {
      if (!options.bridge.sync) {
        throw new Error('Syncular bridge does not implement sync().');
      }
      return await options.bridge.sync();
    },
    async close() {
      if (closed) return;
      closed = true;
      await options.bridge.stop?.();
      await db.destroy();
      await options.bridge.close?.();
    },
  };

  return client;
}

function createSyncularBridgeMutations<DB>(
  options: CreateSyncularBridgeClientOptions,
  afterCommit: () => Promise<void>,
  mode: { leased?: boolean } = {}
): MutationsApi<DB, undefined> {
  const commit = createSyncularBridgeCommit<DB>(options, afterCommit, mode);
  return createMutationsApi(commit);
}

function createSyncularBridgeCommit<DB>(
  options: CreateSyncularBridgeClientOptions,
  afterCommit: () => Promise<void>,
  mode: { leased?: boolean } = {}
): MutationsCommitFn<DB, { operations: SyncOperation[] }, undefined> {
  const idColumn = options.idColumn ?? 'id';
  const versionColumn = options.versionColumn ?? 'server_version';
  const omitColumns = options.omitColumns ?? [];

  return async (fn) => {
    const operations: SyncOperation[] = [];
    const makeTxTable = (table: string) => ({
      async insert(values: unknown) {
        const raw = objectRecord(values);
        const id =
          typeof raw[idColumn] === 'string' && raw[idColumn]
            ? raw[idColumn]
            : randomId();
        operations.push({
          table,
          row_id: id,
          op: 'upsert',
          payload: sanitizeOperationPayload({ ...raw, [idColumn]: id }, [
            idColumn,
            ...(versionColumn ? [versionColumn] : []),
            ...omitColumns,
          ]),
          base_version: null,
        });
        return id;
      },
      async insertMany(rows: unknown[]) {
        const ids: string[] = [];
        for (const row of rows) ids.push(await this.insert(row));
        return ids;
      },
      async update(
        id: string,
        patch: unknown,
        opts?: { baseVersion?: number | null }
      ) {
        operations.push(upsertOperation(table, id, patch, opts));
      },
      async delete(id: string, opts?: { baseVersion?: number | null }) {
        operations.push({
          table,
          row_id: id,
          op: 'delete',
          payload: null,
          base_version: opts?.baseVersion ?? null,
        });
      },
      async upsert(
        id: string,
        patch: unknown,
        opts?: { baseVersion?: number | null }
      ) {
        operations.push(upsertOperation(table, id, patch, opts));
      },
    });

    const tx = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') return undefined;
          return typeof prop === 'string' ? makeTxTable(prop) : undefined;
        },
      }
    ) as MutationsTx<DB>;

    const result = await fn(tx);
    if (operations.length === 0) throw new Error('No mutations were enqueued');
    const commitFn = mode.leased
      ? requireBridgeMethod(
          options.bridge.applyLeasedMutationsCommit,
          'applyLeasedMutationsCommit'
        )
      : options.bridge.applyMutationsCommit.bind(options.bridge);
    const receipt = normalizeMutationReceipt(await commitFn({ operations }));
    await afterCommit();
    return { result, receipt, meta: { operations } };
  };

  function upsertOperation(
    table: string,
    id: string,
    patch: unknown,
    opts?: { baseVersion?: number | null }
  ): SyncOperation {
    return {
      table,
      row_id: id,
      op: 'upsert',
      payload: sanitizeOperationPayload(objectRecord(patch), [
        idColumn,
        ...(versionColumn ? [versionColumn] : []),
        ...omitColumns,
      ]),
      base_version: opts?.baseVersion ?? null,
    };
  }
}

class SyncularBridgeDriver extends BaseSqliteDriver {
  constructor(bridge: SyncularBridge) {
    super(async () => {
      this.conn = new SyncularBridgeConnection(bridge);
    });
  }

  async destroy(): Promise<void> {
    this.conn = undefined;
  }
}

class SyncularBridgeConnection implements DatabaseConnection {
  constructor(private readonly bridge: SyncularBridge) {}

  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    assertSyncularReadonlySql(compiledQuery.sql);
    const result = await this.bridge.executeSql<R & Record<string, unknown>>({
      sql: compiledQuery.sql,
      parameters: compiledQuery.parameters,
    });
    return {
      rows: result.rows as R[],
      numAffectedRows:
        result.numAffectedRows == null
          ? undefined
          : BigInt(result.numAffectedRows),
      insertId: result.insertId == null ? undefined : BigInt(result.insertId),
    };
  }

  streamQuery<R>(
    _compiledQuery: CompiledQuery,
    _chunkSize?: number
  ): AsyncIterableIterator<QueryResult<R>> {
    throw new Error('Syncular bridge dialect does not support streaming.');
  }
}

function createBridgePresence(bridge: SyncularBridge): SyncularBridgePresence {
  return (
    bridge.presence ?? {
      get: () => [],
      join: unsupportedFn('presence.join'),
      leave: unsupportedFn('presence.leave'),
      updateMetadata: unsupportedFn('presence.updateMetadata'),
      onChange: () => noop,
    }
  );
}

function createBridgeConflicts(
  bridge: SyncularBridge
): SyncularBridgeConflicts {
  return (
    bridge.conflicts ?? {
      list: async () => [],
      retryKeepLocal: unsupportedFn('conflicts.retryKeepLocal'),
      resolve: unsupportedFn('conflicts.resolve'),
    }
  );
}

function createBridgeBlobs(bridge: SyncularBridge): SyncularBlobClientLike {
  return {
    getUploadQueueStats: async () =>
      bridge.blobs?.getUploadQueueStats?.() ?? {
        pending: 0,
        uploading: 0,
        failed: 0,
      },
    processUploadQueue: async (options) =>
      bridge.blobs?.processUploadQueue?.(options) ?? { uploaded: 0, failed: 0 },
    retrieve:
      bridge.blobs?.retrieve ??
      (async () => {
        throw new Error('Syncular bridge does not implement blob retrieval.');
      }),
  };
}

function resolveBridgeStatusSnapshot(
  bridge: SyncularBridge
): SyncularClientStatus {
  const snapshot = readSynchronousStatus(bridge);
  const connection = snapshot.connection ?? {
    closed: false,
    pendingRequests: 0,
    realtime: 'disconnected',
  };
  const lifecycle = snapshot.lifecycle ?? {
    phase: connection.closed ? 'closed' : 'offline',
    realtime: connection.realtime,
    online: connection.realtime === 'connected',
    requiresAction: false,
    pendingRequests: connection.pendingRequests,
    ...(snapshot.outbox ? { outbox: snapshot.outbox } : {}),
    ...(snapshot.conflicts ? { conflicts: snapshot.conflicts } : {}),
  };
  const outbox = snapshot.outbox ?? lifecycle.outbox ?? null;
  const conflicts = snapshot.conflicts ?? lifecycle.conflicts ?? null;
  return {
    lifecycle,
    connection,
    outbox,
    conflicts,
    isConnected: connection.realtime === 'connected' && !connection.closed,
    isSyncing:
      lifecycle.phase === 'syncing' || lifecycle.phase === 'recovering',
    hasPendingMutations: (outbox?.pending ?? 0) + (outbox?.sending ?? 0) > 0,
    hasConflicts: (conflicts?.unresolved ?? 0) > 0,
    requiresAction: lifecycle.requiresAction,
  };
}

function readSynchronousStatus(bridge: SyncularBridge): SyncularBridgeStatus {
  if (!bridge.getStatus) return {};
  const snapshot = bridge.getStatus();
  if (isPromiseLike(snapshot)) {
    throw new Error(
      'Syncular bridge getStatus() must be synchronous for React snapshots.'
    );
  }
  return snapshot;
}

function normalizeMutationReceipt(
  value: string | MutationReceipt
): MutationReceipt {
  if (typeof value === 'string')
    return { commitId: value, clientCommitId: value };
  return value;
}

function sanitizeOperationPayload(
  payload: Record<string, unknown>,
  omitColumns: readonly string[]
): Record<string, unknown> {
  const omit = new Set(omitColumns);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!omit.has(key)) out[key] = value;
  }
  return out;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function unsupportedFn<Args extends unknown[], Result>(
  method: string
): (...args: Args) => Result {
  return () => {
    throw new Error(`Syncular bridge does not implement ${method}.`);
  };
}

function requireBridgeMethod<Fn extends (...args: any[]) => any>(
  fn: Fn | undefined,
  method: string
): Fn {
  if (typeof fn === 'function') return fn;
  return unsupportedFn(method) as Fn;
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return (
    value != null &&
    typeof value === 'object' &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

function noop(): void {}
