/**
 * `SyncularAdmin` is the operator-facing surface over the server core: a
 * partition-scoped, JSON-able query layer over `ServerStorage`, the optional
 * segment/blob store stats, and an in-memory event ring, plus three explicit
 * operator actions (retry a dead-lettered reaction, prune the commit log,
 * revoke a client's lease). No separate UI package, no framework, and no
 * wire-protocol surface. This host surface is mirrored in the server README.
 *
 * Nothing here is on the sync hot path. The additive optional storage/store
 * methods it depends on are documented as such and this module fails loud (a
 * thrown `Error`) when a backend lacks one, so a host wiring an unsupported
 * store learns immediately rather than getting a silently-empty console.
 */
import {
  type ColumnType,
  decodeRow,
  type JsonValue,
  renderRowValues,
  type ScopeMap,
} from '@syncular/core';
import type { BlobStore, BlobStoreStats } from './blob-store';
import {
  clockOf,
  RESOLVER_OUTAGE,
  type ResolveScopes,
  type SyncServerConfig,
} from './context';
import { SyncError } from './errors';
import {
  emitEvent,
  type SyncularServerEvent,
  type SyncularServerEvents,
} from './events';
import type { RingBufferEvents, RingEventQuery } from './events-ring';
import type { LeaseRecord, LeaseStore } from './lease-store';
import {
  DEFAULT_RETENTION,
  pruneCommitLog,
  type RetentionPolicy,
} from './prune';
import {
  type CompiledSchema,
  compileSchema,
  type ServerSchema,
} from './schema';
import { computeEffective, matchesEffective } from './scopes';
import type { SegmentStore, SegmentStoreStats } from './segment-store';
import type {
  CheckpointDeclaration,
  ClientRecord,
  CommitMetadata,
  ReactionStatus,
  RowChangeRecord,
  ScopeCommitActivity,
  ServerStorage,
  StoredReaction,
} from './storage';

/** A connected/known client as the console sees it (§4.5, §8.1). */
export interface AdminClient {
  readonly clientId: string;
  readonly actorId: string;
  /** SSP2 wire version last accepted from this client. */
  readonly wireVersion: number;
  /** Highest codec schema version among its subscriptions, when recorded. */
  readonly schemaVersion?: number;
  readonly cursor: number;
  /**
   * Commits the client has not pulled yet: `maxCommitSeq − max(cursor, 0)`.
   * The first number an operator wants for "why is this client stale".
   */
  readonly lag: number;
  readonly updatedAtMs: number;
  readonly subscriptions: readonly {
    readonly id: string;
    readonly table: string;
    readonly scopes: Record<string, readonly string[]>;
  }[];
  /** True when the cursor record was touched within the active window. */
  readonly active: boolean;
}

export interface AdminListClientsOptions {
  /** Default 200. */
  readonly limit?: number;
  /** `seen` (default): most recently seen first. `lag`: largest lag first. */
  readonly sort?: 'seen' | 'lag';
}

export interface AdminClientPage {
  readonly clients: readonly AdminClient[];
  /** Known clients in the partition before `limit`. */
  readonly total: number;
}

/** One client's drill-down: record + lease + its slice of the event tail. */
export interface AdminClientDetail {
  readonly clientId: string;
  readonly exists: boolean;
  /** Present iff `exists` — the same shape `listClients` returns. */
  readonly client?: AdminClient;
  /** The client's §7.3 lease, when a lease store is wired and one exists. */
  readonly lease?: LeaseRecord;
  /**
   * The client's realtime socket state from the newest retained
   * `realtime.opened`/`realtime.closed` event; absent when the ring holds
   * neither. The ring is per process, so a multi-instance host sees only
   * sockets this instance served.
   */
  readonly realtime?: 'open' | 'closed';
  /** Recent ring events carrying this clientId (newest first). */
  readonly events: readonly SyncularServerEvent[];
}

/**
 * How much of a requested window the ring still holds. `complete` is false
 * when the ring dropped events inside the window; the aggregates then cover
 * only `fromMs` onward.
 */
export interface AdminEventCoverage {
  readonly complete: boolean;
  readonly fromMs: number;
}

export interface AdminPushCounts {
  readonly applied: number;
  readonly rejected: number;
  readonly conflicted: number;
}

/** Ring-derived request/push aggregates over a trailing window. */
export interface AdminMetrics {
  readonly partition: string;
  readonly windowMs: number;
  /** Wall-clock the aggregation ran at (window end). */
  readonly atMs: number;
  readonly coverage: AdminEventCoverage;
  readonly requests: {
    readonly count: number;
    readonly perMinute: number;
    readonly errorCount: number;
    /** errors ÷ requests, 0 when the window is empty. */
    readonly errorRate: number;
    readonly p50Ms: number;
    readonly p95Ms: number;
  };
  readonly pushes: AdminPushCounts;
  /**
   * The window split into `counts.length` equal buckets, oldest first: the
   * request count, failed requests, p95 duration (`null` for an empty
   * bucket), and push outcomes per bucket.
   */
  readonly buckets: {
    readonly widthMs: number;
    readonly counts: readonly number[];
    readonly errors: readonly number[];
    readonly p95Ms: readonly (number | null)[];
    readonly pushes: readonly AdminPushCounts[];
  };
}

/** Failures sharing one source and code within the window. */
export interface AdminErrorGroup {
  readonly source: 'request' | 'push' | 'reaction' | 'scopes';
  /** The §10.2 code; `scopes.resolve_failed` for a throwing resolver. */
  readonly code: string;
  readonly count: number;
  /** Distinct clients among the events that carry a clientId. */
  readonly clients: number;
  /** Distinct actors among the events that carry an actorId. */
  readonly actors: number;
  readonly lastAtMs: number;
  /** Up to five client ids, most recent first. */
  readonly sampleClientIds: readonly string[];
}

/** One client's push failures within the window. */
export interface AdminClientErrors {
  readonly clientId: string;
  readonly actorId: string;
  readonly count: number;
  readonly lastCode: string;
  readonly lastAtMs: number;
}

/** "What is failing": ring failures grouped by code and by client. */
export interface AdminErrorSummary {
  readonly partition: string;
  readonly windowMs: number;
  readonly atMs: number;
  readonly coverage: AdminEventCoverage;
  /** Largest count first. */
  readonly byCode: readonly AdminErrorGroup[];
  /** The ten clients with the most push failures, largest count first. */
  readonly byClient: readonly AdminClientErrors[];
}

/** One partition's row in the fleet view (`listPartitions` + horizon math). */
export interface AdminPartitionOverview {
  readonly partition: string;
  readonly maxCommitSeq: number;
  readonly horizonSeq: number;
  readonly retainedCommits: number;
  readonly knownClients: number;
  /** Clients whose cursor record was touched within the active window. */
  readonly activeClients: number;
  readonly recommendation: 'up-to-date' | 'prune-recommended';
}

export interface AdminPartitionPage {
  readonly partitions: readonly AdminPartitionOverview[];
  /** Every registered partition before `offset`/`limit`. */
  readonly total: number;
}

export interface AdminRowInspection {
  readonly table: string;
  readonly rowId: string;
  readonly exists: boolean;
  readonly serverVersion?: number;
  readonly scopes?: Record<string, string>;
  /** Present iff `exists`: the row decoded and rendered per §11. */
  readonly values?: Record<string, JsonValue>;
  /** The retained changes to this row, newest first. */
  readonly history: readonly RowChangeRecord[];
}

/** One change in a commit drill-down. */
export interface AdminCommitChange {
  readonly table: string;
  readonly rowId: string;
  readonly op: 'upsert' | 'delete';
  readonly rowVersion?: number;
  readonly scopes: Record<string, string>;
  /** The upserted row rendered per §11; absent for deletes. */
  readonly values?: Record<string, JsonValue>;
  /**
   * True when the stored payload does not decode against the current
   * schema (written under an older column set).
   */
  readonly undecodable?: boolean;
}

export interface AdminCommitDetail extends CommitMetadata {
  readonly changes: readonly AdminCommitChange[];
}

/**
 * The trace verdict, evaluated in this order:
 * `client-unknown`: no client record for the id.
 * `row-missing`: no row and no retained change to it.
 * `no-subscription`: the client subscribes to nothing on the table.
 * `row-deleted`: the row's newest retained change is a delete the client
 * has pulled.
 * `scope-mismatch`: no subscription requests the row's stored scopes.
 * `scope-denied`: a subscription requests them, but the actor's allowed
 * scopes (the host `resolveScopes`) exclude the row.
 * `pending-pull`: the client's cursor is below the row's newest change.
 * `delivered`: the client has pulled the row's newest change.
 */
export type AdminTraceVerdict =
  | 'client-unknown'
  | 'row-missing'
  | 'no-subscription'
  | 'row-deleted'
  | 'scope-mismatch'
  | 'scope-denied'
  | 'pending-pull'
  | 'delivered';

/** One of the client's subscriptions on the traced table. */
export interface AdminTraceSubscription {
  readonly id: string;
  readonly scopes: Record<string, readonly string[]>;
  /** The row's stored scopes satisfy the requested scopes. */
  readonly requestedMatch: boolean;
  /** Each requested variable the row's stored value fails. */
  readonly mismatches: readonly {
    readonly variable: string;
    readonly rowValue: string | null;
    readonly requested: readonly string[];
  }[];
  /**
   * The row also satisfies requested ∩ allowed (§3.2). Absent when the
   * admin has no `resolveScopes` or the resolver reported an outage.
   */
  readonly effectiveMatch?: boolean;
}

/** "Why does client X (not) see row Y": one read across row and client. */
export interface AdminRowTrace {
  readonly verdict: AdminTraceVerdict;
  readonly table: string;
  readonly rowId: string;
  readonly clientId: string;
  readonly row: AdminRowInspection;
  /** The row's newest retained change. */
  readonly lastChange?: RowChangeRecord;
  /** The partition horizon: changes at or below it are pruned. */
  readonly horizonSeq: number;
  readonly client?: AdminClient;
  /**
   * The actor's allowed scopes from the host `resolveScopes`, or `outage`
   * when it returned the §7.3.3 outage sentinel. Absent without a resolver.
   */
  readonly allowed?: ScopeMap | 'outage';
  readonly subscriptions: readonly AdminTraceSubscription[];
  /** The client's retained push rejections and conflicts, newest first. */
  readonly rejections: readonly SyncularServerEvent[];
}

export interface AdminHorizonStatus {
  readonly partition: string;
  readonly maxCommitSeq: number;
  readonly horizonSeq: number;
  /** Commits still below the retained log's tail — the pruneable backlog. */
  readonly retainedCommits: number;
  /** min(cursor) over active clients, or null when none are active. */
  readonly activeCursorFloor: number | null;
  /** The horizon a prune pass would advance to right now (§4.6). */
  readonly recommendedHorizonSeq: number;
  readonly recommendation: 'up-to-date' | 'prune-recommended';
}

export interface AdminPruneResult {
  readonly previousHorizonSeq: number;
  readonly horizonSeq: number;
}

/** One schema table as the console's pickers need it. */
export interface AdminTableInfo {
  readonly name: string;
  readonly columns: readonly {
    readonly name: string;
    readonly type: ColumnType;
    readonly nullable: boolean;
    readonly primaryKey: boolean;
  }[];
}

export interface AdminListCommitsOptions {
  readonly afterSeq?: number;
  /** Exclusive upper bound: pass the oldest seq of a page for the next. */
  readonly beforeSeq?: number;
  readonly limit?: number;
  readonly table?: string;
}

export interface AdminScopeActivityOptions {
  readonly limit?: number;
}

export interface AdminListReactionsOptions {
  readonly statuses?: readonly ReactionStatus[];
  readonly types?: readonly string[];
  readonly limit?: number;
}

export interface AdminStats {
  readonly segments?: SegmentStoreStats;
  readonly blobs?: BlobStoreStats;
}

export interface SyncularAdminOptions {
  readonly storage: ServerStorage;
  /**
   * The server schema. Row reads (`inspectRow`, `traceRow`, `commitDetail`)
   * require it: it decodes payloads and ensures the relational row tables
   * exist on a storage instance that has not served a sync request yet.
   */
  readonly schema?: ServerSchema;
  /** RFC 0007: declarations `inspectRow` carries into `ensureSchema`. */
  readonly checkpoints?: readonly CheckpointDeclaration[];
  /** The event ring feeding the event tail. Absent ⇒ `events()` is empty. */
  readonly ring?: RingBufferEvents;
  /** Receives `prune.completed` and `lease.revoked` from operator actions. */
  readonly events?: SyncularServerEvents;
  /** The host resolver: `traceRow` checks the actor's allowed scopes. */
  readonly resolveScopes?: ResolveScopes;
  readonly segments?: SegmentStore;
  readonly blobs?: BlobStore;
  /** The §7.3 lease store — the client drill-down and `revokeLease`. */
  readonly leases?: LeaseStore;
  /** Retention policy for horizon recommendation and prune (§4.6). */
  readonly retention?: Partial<RetentionPolicy>;
  /** Epoch-ms clock (defaults to `Date.now`) — active-window math. */
  readonly clock?: () => number;
}

const DEFAULT_CLIENT_LIMIT = 200;
const DEFAULT_PARTITION_LIMIT = 100;
const DEFAULT_COMMIT_LIMIT = 50;
const DEFAULT_SCOPE_LIMIT = 50;
const DEFAULT_REACTION_LIMIT = 100;
const DEFAULT_CLIENT_EVENT_LIMIT = 100;
const DEFAULT_ROW_HISTORY_LIMIT = 20;
const DEFAULT_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_METRICS_BUCKETS = 30;

/** Nearest-rank percentile over an unsorted sample; 0 for an empty one. */
function percentile(sample: readonly number[], q: number): number {
  if (sample.length === 0) return 0;
  const sorted = [...sample].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(q * sorted.length));
  return sorted[rank - 1] ?? 0;
}

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(
      `SyncularAdmin: the configured ${what} does not implement this optional read`,
    );
  }
  return value;
}

function toAdminClient(
  record: ClientRecord,
  active: boolean,
  maxCommitSeq: number,
): AdminClient {
  let schemaVersion: number | undefined;
  for (const sub of record.subscriptions) {
    if (
      sub.schemaVersion !== undefined &&
      (schemaVersion === undefined || sub.schemaVersion > schemaVersion)
    ) {
      schemaVersion = sub.schemaVersion;
    }
  }
  return {
    clientId: record.clientId,
    actorId: record.actorId,
    wireVersion: record.wireVersion,
    ...(schemaVersion !== undefined ? { schemaVersion } : {}),
    cursor: record.cursor,
    // A never-pulled cursor (-1) has seen nothing: it lags the whole log.
    lag: Math.max(0, maxCommitSeq - Math.max(0, record.cursor)),
    updatedAtMs: record.updatedAtMs,
    subscriptions: record.subscriptions.map((sub) => ({
      id: sub.id,
      table: sub.table,
      scopes: sub.scopes,
    })),
    active,
  };
}

/** The console query surface plus its operator actions. One per process. */
export class SyncularAdmin {
  readonly #storage: ServerStorage;
  readonly #schema?: CompiledSchema;
  readonly #checkpoints?: readonly CheckpointDeclaration[];
  readonly #ring?: RingBufferEvents;
  readonly #events?: SyncularServerEvents;
  readonly #resolveScopes?: ResolveScopes;
  readonly #segments?: SegmentStore;
  readonly #blobs?: BlobStore;
  readonly #leases?: LeaseStore;
  readonly #retention: RetentionPolicy;
  readonly #clock: () => number;

  constructor(options: SyncularAdminOptions) {
    this.#storage = options.storage;
    if (options.schema !== undefined) {
      this.#schema = compileSchema(options.schema);
    }
    if (options.checkpoints !== undefined)
      this.#checkpoints = options.checkpoints;
    if (options.ring !== undefined) this.#ring = options.ring;
    if (options.events !== undefined) this.#events = options.events;
    if (options.resolveScopes !== undefined) {
      this.#resolveScopes = options.resolveScopes;
    }
    if (options.segments !== undefined) this.#segments = options.segments;
    if (options.blobs !== undefined) this.#blobs = options.blobs;
    if (options.leases !== undefined) this.#leases = options.leases;
    this.#retention = { ...DEFAULT_RETENTION, ...options.retention };
    this.#clock = options.clock ?? Date.now;
  }

  /**
   * Build an admin over a `SyncServerConfig`, reusing its storage, schema,
   * resolver, events sink, stores, leases and clock. Pass the ring
   * separately (it is an events sink, composed into the config's `events` by
   * the host — see `composeEvents`).
   */
  static fromConfig(
    config: SyncServerConfig,
    extra?: { ring?: RingBufferEvents; retention?: Partial<RetentionPolicy> },
  ): SyncularAdmin {
    return new SyncularAdmin({
      storage: config.storage,
      schema: config.schema,
      ...(config.checkpoints !== undefined
        ? { checkpoints: config.checkpoints }
        : {}),
      resolveScopes: config.resolveScopes,
      ...(config.events !== undefined ? { events: config.events } : {}),
      segments: config.segments,
      ...(config.blobs !== undefined ? { blobs: config.blobs } : {}),
      ...(config.leases !== undefined ? { leases: config.leases.store } : {}),
      ...(extra?.ring !== undefined ? { ring: extra.ring } : {}),
      ...(extra?.retention !== undefined ? { retention: extra.retention } : {}),
      clock: clockOf(config),
    });
  }

  /** The schema tables and columns, for row and commit pickers. */
  tables(): AdminTableInfo[] {
    return [...(this.#schema?.tables.values() ?? [])].map((table) => ({
      name: table.name,
      columns: table.columns.map((column, i) => ({
        name: column.name,
        type: column.type,
        nullable: column.nullable,
        primaryKey: i === table.primaryKeyIndex,
      })),
    }));
  }

  /** The known clients for a partition (cursor, lag, versions, subs). */
  async listClients(
    partition: string,
    options: AdminListClientsOptions = {},
  ): Promise<AdminClientPage> {
    const list = required(
      this.#storage.listClientRecords?.bind(this.#storage),
      'storage',
    );
    const records = await list(partition);
    const maxCommitSeq = await this.#storage.getMaxCommitSeq(partition);
    const activeFloorMs = this.#clock() - this.#retention.activeWindowMs;
    const clients = records.map((record) =>
      toAdminClient(record, record.updatedAtMs >= activeFloorMs, maxCommitSeq),
    );
    clients.sort((a, b) =>
      options.sort === 'lag' ? b.lag - a.lag : b.updatedAtMs - a.updatedAtMs,
    );
    return {
      clients: clients.slice(0, options.limit ?? DEFAULT_CLIENT_LIMIT),
      total: clients.length,
    };
  }

  /**
   * One client's drill-down: its record (with lag), its §7.3 lease when a
   * lease store is wired, its realtime state, and its recent slice of the
   * event tail. Answers "why is this client stale" in a single read.
   */
  async clientDetail(
    partition: string,
    clientId: string,
    options: { readonly eventLimit?: number } = {},
  ): Promise<AdminClientDetail> {
    const record = await this.#storage.getClientRecord(partition, clientId);
    const events = this.events({
      partition,
      clientId,
      limit: options.eventLimit ?? DEFAULT_CLIENT_EVENT_LIMIT,
    });
    if (record === undefined) {
      return { clientId, exists: false, events };
    }
    const maxCommitSeq = await this.#storage.getMaxCommitSeq(partition);
    const activeFloorMs = this.#clock() - this.#retention.activeWindowMs;
    const lease = await this.#leases?.get(partition, clientId);
    const socket = this.events({ partition, clientId }).find(
      (event) =>
        event.type === 'realtime.opened' || event.type === 'realtime.closed',
    );
    return {
      clientId,
      exists: true,
      client: toAdminClient(
        record,
        record.updatedAtMs >= activeFloorMs,
        maxCommitSeq,
      ),
      ...(lease !== undefined ? { lease } : {}),
      ...(socket !== undefined
        ? { realtime: socket.type === 'realtime.opened' ? 'open' : 'closed' }
        : {}),
      events,
    };
  }

  /** Commit-log metadata (no payloads), newest first. */
  async listCommits(
    partition: string,
    options: AdminListCommitsOptions = {},
  ): Promise<CommitMetadata[]> {
    const read = required(
      this.#storage.listCommitMetadata?.bind(this.#storage),
      'storage',
    );
    return read(partition, {
      afterSeq: options.afterSeq ?? 0,
      ...(options.beforeSeq !== undefined
        ? { beforeSeq: options.beforeSeq }
        : {}),
      limit: options.limit ?? DEFAULT_COMMIT_LIMIT,
      ...(options.table !== undefined ? { table: options.table } : {}),
    });
  }

  /**
   * One retained commit with every change rendered per §11. Throws
   * `sync.not_found` when the commit does not exist or was pruned.
   */
  async commitDetail(
    partition: string,
    commitSeq: number,
  ): Promise<AdminCommitDetail> {
    const read = required(
      this.#storage.getCommit?.bind(this.#storage),
      'storage',
    );
    const schema = this.#requireSchema();
    const commit = await read(partition, commitSeq);
    if (commit === undefined) {
      throw new SyncError(
        'sync.not_found',
        'commit is not in the retained log',
        JSON.stringify({ commitSeq }),
      );
    }
    return {
      ...commit,
      changes: commit.changes.map((change): AdminCommitChange => {
        const base = {
          table: change.table,
          rowId: change.rowId,
          op: change.op,
          ...(change.rowVersion !== undefined
            ? { rowVersion: change.rowVersion }
            : {}),
          scopes: change.scopes,
        };
        const table = schema.tables.get(change.table);
        if (change.payload === undefined) return base;
        if (table === undefined) return { ...base, undecodable: true };
        try {
          return {
            ...base,
            values: renderRowValues(
              table.columns,
              decodeRow(table.columns, change.payload),
            ),
          };
        } catch {
          return { ...base, undecodable: true };
        }
      }),
    };
  }

  /** Pending, leased, completed, and dead-lettered durable reactions. */
  async listReactions(
    partition: string,
    options: AdminListReactionsOptions = {},
  ): Promise<StoredReaction[]> {
    const read = required(
      this.#storage.listReactions?.bind(this.#storage),
      'storage',
    );
    return read(partition, {
      limit: options.limit ?? DEFAULT_REACTION_LIMIT,
      ...(options.statuses !== undefined ? { statuses: options.statuses } : {}),
      ...(options.types !== undefined ? { types: options.types } : {}),
    });
  }

  /**
   * Inspect a single row: server_version, stored scopes, its values decoded
   * per §11, and its retained change history (newest first). Throws
   * `sync.unknown_table` for a table outside the schema.
   */
  async inspectRow(
    partition: string,
    table: string,
    rowId: string,
    options: { readonly historyLimit?: number } = {},
  ): Promise<AdminRowInspection> {
    const schema = this.#requireSchema();
    const compiled = schema.tables.get(table);
    if (compiled === undefined) {
      throw new SyncError(
        'sync.unknown_table',
        'table is not in the server schema',
        JSON.stringify({ table }),
      );
    }
    await this.#storage.ensureSchema(schema, this.#checkpoints);
    const listChanges = required(
      this.#storage.listRowChanges?.bind(this.#storage),
      'storage',
    );
    const history = await listChanges(partition, {
      table,
      rowId,
      limit: options.historyLimit ?? DEFAULT_ROW_HISTORY_LIMIT,
    });
    const row = await this.#storage.getRow(partition, table, rowId);
    if (row === undefined) {
      return { table, rowId, exists: false, history };
    }
    return {
      table,
      rowId,
      exists: true,
      serverVersion: row.serverVersion,
      scopes: row.scopes,
      values: renderRowValues(
        compiled.columns,
        decodeRow(compiled.columns, row.payload),
      ),
      history,
    };
  }

  /**
   * Trace whether one client receives one row, combining the row's stored
   * scopes and newest change with the client's subscriptions, cursor, the
   * actor's allowed scopes, and its retained push failures. See
   * `AdminTraceVerdict` for the verdict order.
   */
  async traceRow(
    partition: string,
    query: {
      readonly table: string;
      readonly rowId: string;
      readonly clientId: string;
    },
  ): Promise<AdminRowTrace> {
    const { table, rowId, clientId } = query;
    const row = await this.inspectRow(partition, table, rowId, {
      historyLimit: 1,
    });
    const lastChange = row.history[0];
    const horizonSeq = await this.#storage.getHorizonSeq(partition);
    const rejections = this.events({ partition, clientId }).filter(
      (event) =>
        event.type === 'push.rejected' || event.type === 'push.conflicted',
    );
    const record = await this.#storage.getClientRecord(partition, clientId);
    const base = {
      table,
      rowId,
      clientId,
      row,
      horizonSeq,
      rejections,
      ...(lastChange !== undefined ? { lastChange } : {}),
    };
    if (record === undefined) {
      return { ...base, verdict: 'client-unknown', subscriptions: [] };
    }
    const maxCommitSeq = await this.#storage.getMaxCommitSeq(partition);
    const activeFloorMs = this.#clock() - this.#retention.activeWindowMs;
    let allowed: ScopeMap | 'outage' | undefined;
    if (this.#resolveScopes !== undefined) {
      const resolved = await this.#resolveScopes({
        partition,
        actorId: record.actorId,
        clientId,
      });
      allowed = resolved === RESOLVER_OUTAGE ? 'outage' : resolved;
    }
    const rowScopes = row.scopes ?? {};
    const subscriptions = record.subscriptions
      .filter((sub) => sub.table === table)
      .map((sub): AdminTraceSubscription => {
        const mismatches = Object.entries(sub.scopes)
          .filter(([variable, values]) => {
            const value = rowScopes[variable];
            return value === undefined || !values.includes(value);
          })
          .map(([variable, values]) => ({
            variable,
            rowValue: rowScopes[variable] ?? null,
            requested: values,
          }));
        const traced = {
          id: sub.id,
          scopes: sub.scopes,
          requestedMatch: mismatches.length === 0,
          mismatches,
        };
        if (allowed === undefined || allowed === 'outage') return traced;
        const effective = computeEffective(sub.scopes, { ok: true, allowed });
        return {
          ...traced,
          effectiveMatch:
            effective.status === 'active' &&
            matchesEffective(rowScopes, effective.effective),
        };
      });
    const traced = {
      ...base,
      client: toAdminClient(
        record,
        record.updatedAtMs >= activeFloorMs,
        maxCommitSeq,
      ),
      ...(allowed !== undefined ? { allowed } : {}),
      subscriptions,
    };
    // With no retained change left, the newest one sits at or below the
    // horizon, so a cursor at the horizon has pulled it.
    const pulled = record.cursor >= (lastChange?.commitSeq ?? horizonSeq);
    if (!row.exists && lastChange === undefined) {
      return { ...traced, verdict: 'row-missing' };
    }
    if (subscriptions.length === 0) {
      return { ...traced, verdict: 'no-subscription' };
    }
    if (!row.exists) {
      return { ...traced, verdict: pulled ? 'row-deleted' : 'pending-pull' };
    }
    if (!subscriptions.some((sub) => sub.requestedMatch)) {
      return { ...traced, verdict: 'scope-mismatch' };
    }
    if (subscriptions.every((sub) => sub.effectiveMatch === false)) {
      return { ...traced, verdict: 'scope-denied' };
    }
    return { ...traced, verdict: pulled ? 'delivered' : 'pending-pull' };
  }

  /**
   * Recent commits touching one scope key (`variable:value`, e.g.
   * `project:p1`) — routed through the change-scope index, never a scan.
   */
  async scopeActivity(
    partition: string,
    scopeKey: { variable: string; value: string },
    options: AdminScopeActivityOptions = {},
  ): Promise<ScopeCommitActivity[]> {
    const read = required(
      this.#storage.scopeActivity?.bind(this.#storage),
      'storage',
    );
    return read(partition, {
      variable: scopeKey.variable,
      value: scopeKey.value,
      limit: options.limit ?? DEFAULT_SCOPE_LIMIT,
    });
  }

  /**
   * Horizon health for a partition: current horizon, retained-commit
   * backlog, active cursor floor, and the horizon a prune pass would reach
   * now (§4.6) plus a coarse recommendation.
   */
  async horizonStatus(partition: string): Promise<AdminHorizonStatus> {
    const nowMs = this.#clock();
    const maxCommitSeq = await this.#storage.getMaxCommitSeq(partition);
    const horizonSeq = await this.#storage.getHorizonSeq(partition);
    const activeCursorFloor = await this.#storage.getActiveClientCursorFloor(
      partition,
      nowMs - this.#retention.activeWindowMs,
    );
    const cursorFloor = activeCursorFloor ?? Number.MAX_SAFE_INTEGER;
    const forcedSeq = await this.#storage.getCommitSeqBefore(
      partition,
      nowMs - this.#retention.ageForceMs,
    );
    const retainFloor = maxCommitSeq - this.#retention.minRetainedCommits;
    const target = Math.min(Math.max(cursorFloor, forcedSeq), retainFloor);
    const recommendedHorizonSeq = Math.max(horizonSeq, Math.max(0, target));
    return {
      partition,
      maxCommitSeq,
      horizonSeq,
      retainedCommits: maxCommitSeq - horizonSeq,
      activeCursorFloor,
      recommendedHorizonSeq,
      recommendation:
        recommendedHorizonSeq > horizonSeq ? 'prune-recommended' : 'up-to-date',
    };
  }

  /** Segment + blob store counters where the stores expose them. */
  async stats(partition: string): Promise<AdminStats> {
    const segments = await this.#segments?.stats?.();
    const blobs = await this.#blobs?.stats?.(partition);
    return {
      ...(segments !== undefined ? { segments } : {}),
      ...(blobs !== undefined ? { blobs } : {}),
    };
  }

  /** True when this admin has an event ring wired (the event tail is live). */
  get hasEventStream(): boolean {
    return this.#ring !== undefined;
  }

  /** The event tail from the ring buffer (newest first). Empty when unwired. */
  events(query: RingEventQuery = {}): SyncularServerEvent[] {
    return this.#ring?.query(query) ?? [];
  }

  /**
   * Subscribe to events as they land in the ring (the SSE tail). Returns
   * the unsubscribe function, or `undefined` when no ring is wired — a
   * host can branch on that the same way `hasEventStream` reports it.
   */
  subscribeEvents(
    listener: (event: SyncularServerEvent) => void,
  ): (() => void) | undefined {
    return this.#ring?.subscribe(listener);
  }

  /**
   * Request/push health over a trailing window, derived entirely from the
   * ring (zero new server state): rates, error share, duration percentiles,
   * and per-bucket series. Only events carrying this `partition` count.
   * `coverage` reports when the ring dropped events inside the window.
   */
  metrics(
    partition: string,
    options: { readonly windowMs?: number; readonly buckets?: number } = {},
  ): AdminMetrics {
    const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    const bucketCount = options.buckets ?? DEFAULT_METRICS_BUCKETS;
    const atMs = this.#clock();
    const sinceMs = atMs - windowMs;
    const widthMs = windowMs / bucketCount;
    const counts = new Array<number>(bucketCount).fill(0);
    const errors = new Array<number>(bucketCount).fill(0);
    const bucketDurations = Array.from(
      { length: bucketCount },
      (): number[] => [],
    );
    const bucketPushes = Array.from({ length: bucketCount }, () => ({
      applied: 0,
      rejected: 0,
      conflicted: 0,
    }));
    const durations: number[] = [];
    let errorCount = 0;
    const pushes = { applied: 0, rejected: 0, conflicted: 0 };
    for (const event of this.events({ partition, sinceMs })) {
      const bucket = Math.min(
        bucketCount - 1,
        Math.max(0, Math.floor((event.atMs - sinceMs) / widthMs)),
      );
      const outcome =
        event.type === 'push.applied'
          ? 'applied'
          : event.type === 'push.rejected'
            ? 'rejected'
            : event.type === 'push.conflicted'
              ? 'conflicted'
              : undefined;
      if (outcome !== undefined) {
        pushes[outcome] += 1;
        const slot = bucketPushes[bucket];
        if (slot !== undefined) slot[outcome] += 1;
      }
      if (event.type !== 'request.handled') continue;
      durations.push(event.durationMs);
      bucketDurations[bucket]?.push(event.durationMs);
      counts[bucket] = (counts[bucket] ?? 0) + 1;
      if (event.outcome === 'rejected' || event.outcome === 'error') {
        errorCount += 1;
        errors[bucket] = (errors[bucket] ?? 0) + 1;
      }
    }
    return {
      partition,
      windowMs,
      atMs,
      coverage: this.#coverage(sinceMs),
      requests: {
        count: durations.length,
        perMinute: durations.length / (windowMs / 60_000),
        errorCount,
        errorRate: durations.length === 0 ? 0 : errorCount / durations.length,
        p50Ms: percentile(durations, 0.5),
        p95Ms: percentile(durations, 0.95),
      },
      pushes,
      buckets: {
        widthMs,
        counts,
        errors,
        p95Ms: bucketDurations.map((sample) =>
          sample.length === 0 ? null : percentile(sample, 0.95),
        ),
        pushes: bucketPushes,
      },
    };
  }

  /**
   * Failures over a trailing window, grouped by source and code and by
   * client: failed requests, push rejections and conflicts, dead-lettered
   * reactions, and throwing scope resolvers. Derived from the ring.
   */
  errors(
    partition: string,
    options: { readonly windowMs?: number } = {},
  ): AdminErrorSummary {
    const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    const atMs = this.#clock();
    const sinceMs = atMs - windowMs;
    const groups = new Map<
      string,
      {
        readonly source: AdminErrorGroup['source'];
        readonly code: string;
        count: number;
        readonly clients: Set<string>;
        readonly actors: Set<string>;
        readonly lastAtMs: number;
      }
    >();
    const byClient = new Map<string, AdminClientErrors>();
    // Newest first, so the first event per group or client is its latest.
    for (const event of this.events({ partition, sinceMs })) {
      let source: AdminErrorGroup['source'];
      let code: string;
      let clientId: string | undefined;
      let actorId: string | undefined;
      if (event.type === 'request.handled') {
        if (event.outcome !== 'rejected' && event.outcome !== 'error') continue;
        source = 'request';
        code = event.errorCode ?? 'sync.internal_error';
        actorId = event.actorId;
      } else if (event.type === 'push.rejected') {
        source = 'push';
        code = event.code;
        clientId = event.clientId;
        actorId = event.actorId;
      } else if (event.type === 'push.conflicted') {
        source = 'push';
        code = 'sync.version_conflict';
        clientId = event.clientId;
        actorId = event.actorId;
      } else if (event.type === 'reaction.dead_lettered') {
        source = 'reaction';
        code = event.errorCode;
      } else if (event.type === 'scopes.resolve_failed') {
        source = 'scopes';
        code = 'scopes.resolve_failed';
        actorId = event.actorId;
      } else {
        continue;
      }
      const key = `${source} ${code}`;
      const group = groups.get(key) ?? {
        source,
        code,
        count: 0,
        clients: new Set<string>(),
        actors: new Set<string>(),
        lastAtMs: event.atMs,
      };
      group.count += 1;
      if (clientId !== undefined) group.clients.add(clientId);
      if (actorId !== undefined) group.actors.add(actorId);
      groups.set(key, group);
      if (clientId !== undefined && actorId !== undefined) {
        const seen = byClient.get(clientId);
        byClient.set(
          clientId,
          seen !== undefined
            ? { ...seen, count: seen.count + 1 }
            : {
                clientId,
                actorId,
                count: 1,
                lastCode: code,
                lastAtMs: event.atMs,
              },
        );
      }
    }
    return {
      partition,
      windowMs,
      atMs,
      coverage: this.#coverage(sinceMs),
      byCode: [...groups.values()]
        .sort((a, b) => b.count - a.count)
        .map((group) => ({
          source: group.source,
          code: group.code,
          count: group.count,
          clients: group.clients.size,
          actors: group.actors.size,
          lastAtMs: group.lastAtMs,
          sampleClientIds: [...group.clients].slice(0, 5),
        })),
      byClient: [...byClient.values()]
        .sort((a, b) => b.count - a.count)
        .slice(0, 10),
    };
  }

  /** Every authenticated partition in the storage-backed registry. */
  async listPartitions(): Promise<string[]> {
    return (await this.#storage.listPartitionRegistry()).map(
      (entry) => entry.partition,
    );
  }

  /**
   * The fleet view: one row per known partition — retained backlog, client
   * counts, prune recommendation — paged by `offset`/`limit` (default 100)
   * because each row costs several reads. A cross-partition read (every
   * other method is partition-scoped); host authorization should account
   * for it.
   */
  async partitionsOverview(
    options: { readonly limit?: number; readonly offset?: number } = {},
  ): Promise<AdminPartitionPage> {
    const partitions = await this.listPartitions();
    const offset = options.offset ?? 0;
    const page = partitions.slice(
      offset,
      offset + (options.limit ?? DEFAULT_PARTITION_LIMIT),
    );
    const activeFloorMs = this.#clock() - this.#retention.activeWindowMs;
    const out: AdminPartitionOverview[] = [];
    for (const partition of page) {
      const status = await this.horizonStatus(partition);
      const cursors = await this.#storage.listClientCursors(partition);
      out.push({
        partition,
        maxCommitSeq: status.maxCommitSeq,
        horizonSeq: status.horizonSeq,
        retainedCommits: status.retainedCommits,
        knownClients: cursors.length,
        activeClients: cursors.filter((c) => c.updatedAtMs >= activeFloorMs)
          .length,
        recommendation: status.recommendation,
      });
    }
    return { partitions: out, total: partitions.length };
  }

  /**
   * Operator action: requeue a dead-lettered reaction. Throws
   * `sync.invalid_request` when the key names no dead-lettered reaction.
   */
  async retryReaction(
    partition: string,
    idempotencyKey: string,
  ): Promise<StoredReaction> {
    const retry = required(
      this.#storage.retryReaction?.bind(this.#storage),
      'storage',
    );
    const read = required(
      this.#storage.getReaction?.bind(this.#storage),
      'storage',
    );
    if (!(await retry(partition, idempotencyKey, this.#clock()))) {
      throw new SyncError(
        'sync.invalid_request',
        'no dead-lettered reaction with this key',
        JSON.stringify({ idempotencyKey }),
      );
    }
    const reaction = await read(partition, idempotencyKey);
    if (reaction === undefined) {
      throw new Error('SyncularAdmin: a retried reaction disappeared');
    }
    return reaction;
  }

  /** Operator action: one §4.6 prune pass now, emitting `prune.completed`. */
  async prune(partition: string): Promise<AdminPruneResult> {
    const previousHorizonSeq = await this.#storage.getHorizonSeq(partition);
    const horizonSeq = await pruneCommitLog({
      storage: this.#storage,
      partition,
      nowMs: this.#clock(),
      retention: this.#retention,
      ...(this.#events !== undefined ? { events: this.#events } : {}),
    });
    return { previousHorizonSeq, horizonSeq };
  }

  /**
   * Operator action: revoke the client's §7.3 lease (§7.3.4), emitting
   * `lease.revoked`. Throws `sync.invalid_request` when the client holds no
   * lease.
   */
  async revokeLease(partition: string, clientId: string): Promise<LeaseRecord> {
    const leases = required(this.#leases, 'lease store');
    const lease = await leases.get(partition, clientId);
    if (lease === undefined) {
      throw new SyncError(
        'sync.invalid_request',
        'the client holds no lease',
        JSON.stringify({ clientId }),
      );
    }
    await leases.revoke(partition, lease.leaseId);
    if (this.#events !== undefined) {
      emitEvent(this.#events, {
        type: 'lease.revoked',
        atMs: this.#clock(),
        partition,
        leaseId: lease.leaseId,
      });
    }
    return { ...lease, revoked: true };
  }

  #requireSchema(): CompiledSchema {
    if (this.#schema === undefined) {
      throw new Error('SyncularAdmin: row reads require the server schema');
    }
    return this.#schema;
  }

  #coverage(sinceMs: number): AdminEventCoverage {
    const evicted = this.#ring?.evictedThroughMs;
    return evicted === undefined || evicted < sinceMs
      ? { complete: true, fromMs: sinceMs }
      : { complete: false, fromMs: evicted };
  }
}
