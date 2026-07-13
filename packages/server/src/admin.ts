/**
 * `SyncularAdmin` — the operator-facing read surface over the server core
 * (TODO §2.5). A read-only, partition-scoped, JSON-able query layer over
 * `ServerStorage`, the optional segment/blob store stats, and an in-memory
 * event ring. It delivers the 80% operator value (who's connected, what's
 * flowing, horizon health, the event tail) as a handful of queries in the
 * server package — no separate
 * UI package, no framework, no wire-protocol surface (SPEC.md is untouched;
 * this is host surface, mirrored in the server README).
 *
 * Nothing here is on the sync hot path. Every method is a plain read; the
 * additive optional storage/store methods it depends on are documented as
 * such and this module fails loud (a thrown `Error`) when a backend lacks
 * one, so a host wiring an unsupported store learns immediately rather than
 * getting a silently-empty console.
 */
import type { BlobStore, BlobStoreStats } from './blob-store';
import { clockOf, type SyncServerConfig } from './context';
import type { SyncularServerEvent } from './events';
import type { RingBufferEvents, RingEventQuery } from './events-ring';
import type { LeaseRecord, LeaseStore } from './lease-store';
import { DEFAULT_RETENTION, type RetentionPolicy } from './prune';
import { compileSchema, type ServerSchema } from './schema';
import type { SegmentStore, SegmentStoreStats } from './segment-store';
import type {
  ClientRecord,
  CommitMetadata,
  ScopeCommitActivity,
  ServerStorage,
} from './storage';

/** A connected/known client as the console sees it (§4.5, §8.1). */
export interface AdminClient {
  readonly clientId: string;
  readonly actorId: string;
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

/** One client's drill-down: record + lease + its slice of the event tail. */
export interface AdminClientDetail {
  readonly clientId: string;
  readonly exists: boolean;
  /** Present iff `exists` — the same shape `listClients` returns. */
  readonly client?: AdminClient;
  /** The client's §7.3 lease, when a lease store is wired and one exists. */
  readonly lease?: LeaseRecord;
  /** Recent ring events carrying this clientId (newest first). */
  readonly events: readonly SyncularServerEvent[];
}

/** Ring-derived request/push aggregates over a trailing window. */
export interface AdminMetrics {
  readonly partition: string;
  readonly windowMs: number;
  /** Wall-clock the aggregation ran at (window end). */
  readonly atMs: number;
  readonly requests: {
    readonly count: number;
    readonly perMinute: number;
    readonly errorCount: number;
    /** errors ÷ requests, 0 when the window is empty. */
    readonly errorRate: number;
    readonly p50Ms: number;
    readonly p95Ms: number;
  };
  readonly pushes: {
    readonly applied: number;
    readonly rejected: number;
    readonly conflicted: number;
  };
  /**
   * Request counts split into `counts.length` equal buckets, oldest first —
   * the console's sparkline. `errors` marks the error share per bucket.
   */
  readonly buckets: {
    readonly widthMs: number;
    readonly counts: readonly number[];
    readonly errors: readonly number[];
  };
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

export interface AdminRowInspection {
  readonly table: string;
  readonly rowId: string;
  readonly exists: boolean;
  readonly serverVersion?: number;
  readonly scopes?: Record<string, string>;
  /** blobIds this row currently references (§5.9.4), when the store tracks them. */
  readonly referencedBlobIds?: readonly string[];
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

export interface AdminListCommitsOptions {
  readonly afterSeq?: number;
  readonly limit?: number;
  readonly table?: string;
}

export interface AdminScopeActivityOptions {
  readonly limit?: number;
}

export interface AdminStats {
  readonly segments?: SegmentStoreStats;
  readonly blobs?: BlobStoreStats;
}

export interface SyncularAdminOptions {
  readonly storage: ServerStorage;
  /**
   * The server schema. When present, row reads (`inspectRow`) ensure the
   * relational row tables exist first — needed when the admin runs against
   * a storage instance that has not served a sync request yet.
   */
  readonly schema?: ServerSchema;
  /** The event ring feeding the event tail. Absent ⇒ `events()` is empty. */
  readonly ring?: RingBufferEvents;
  readonly segments?: SegmentStore;
  readonly blobs?: BlobStore;
  /** The §7.3 lease store — feeds the client drill-down's lease read. */
  readonly leases?: LeaseStore;
  /** Retention policy for horizon recommendation (defaults to §4.6). */
  readonly retention?: Partial<RetentionPolicy>;
  /** Epoch-ms clock (defaults to `Date.now`) — active-window math. */
  readonly clock?: () => number;
}

const DEFAULT_COMMIT_LIMIT = 50;
const DEFAULT_SCOPE_LIMIT = 50;
const DEFAULT_CLIENT_EVENT_LIMIT = 100;
const DEFAULT_METRICS_WINDOW_MS = 5 * 60 * 1000;
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
      `SyncularAdmin: the configured ${what} does not implement this read (TODO §2.5 optional method missing)`,
    );
  }
  return value;
}

function toAdminClient(
  record: ClientRecord,
  active: boolean,
  maxCommitSeq: number,
): AdminClient {
  return {
    clientId: record.clientId,
    actorId: record.actorId,
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

/** The read-only console query surface. Construct one per host process. */
export class SyncularAdmin {
  readonly #storage: ServerStorage;
  readonly #schema?: ServerSchema;
  readonly #ring?: RingBufferEvents;
  readonly #segments?: SegmentStore;
  readonly #blobs?: BlobStore;
  readonly #leases?: LeaseStore;
  readonly #retention: RetentionPolicy;
  readonly #clock: () => number;

  constructor(options: SyncularAdminOptions) {
    this.#storage = options.storage;
    if (options.schema !== undefined) this.#schema = options.schema;
    if (options.ring !== undefined) this.#ring = options.ring;
    if (options.segments !== undefined) this.#segments = options.segments;
    if (options.blobs !== undefined) this.#blobs = options.blobs;
    if (options.leases !== undefined) this.#leases = options.leases;
    this.#retention = { ...DEFAULT_RETENTION, ...options.retention };
    this.#clock = options.clock ?? Date.now;
  }

  /**
   * Build an admin over a `SyncServerConfig`, reusing its storage / segment
   * / blob store / clock. Pass the ring separately (it is an events sink,
   * composed into the config's `events` by the host — see `composeEvents`).
   */
  static fromConfig(
    config: SyncServerConfig,
    extra?: { ring?: RingBufferEvents; retention?: Partial<RetentionPolicy> },
  ): SyncularAdmin {
    return new SyncularAdmin({
      storage: config.storage,
      schema: config.schema,
      segments: config.segments,
      ...(config.blobs !== undefined ? { blobs: config.blobs } : {}),
      ...(config.leases !== undefined ? { leases: config.leases.store } : {}),
      ...(extra?.ring !== undefined ? { ring: extra.ring } : {}),
      ...(extra?.retention !== undefined ? { retention: extra.retention } : {}),
      clock: clockOf(config),
    });
  }

  /** The known clients for a partition (cursor, lag, subscriptions). */
  async listClients(partition: string): Promise<AdminClient[]> {
    const list = required(
      this.#storage.listClientRecords?.bind(this.#storage),
      'storage',
    );
    const records = await list(partition);
    const maxCommitSeq = await this.#storage.getMaxCommitSeq(partition);
    const activeFloorMs = this.#clock() - this.#retention.activeWindowMs;
    return records.map((record) =>
      toAdminClient(record, record.updatedAtMs >= activeFloorMs, maxCommitSeq),
    );
  }

  /**
   * One client's drill-down: its record (with lag), its §7.3 lease when a
   * lease store is wired, and its recent slice of the event tail. Answers
   * "why is this client stale" in a single read.
   */
  async clientDetail(
    partition: string,
    clientId: string,
    options: { readonly eventLimit?: number } = {},
  ): Promise<AdminClientDetail> {
    const record = await this.#storage.getClientRecord(partition, clientId);
    const events = this.events({
      clientId,
      limit: options.eventLimit ?? DEFAULT_CLIENT_EVENT_LIMIT,
    });
    if (record === undefined) {
      return { clientId, exists: false, events };
    }
    const maxCommitSeq = await this.#storage.getMaxCommitSeq(partition);
    const activeFloorMs = this.#clock() - this.#retention.activeWindowMs;
    const lease = await this.#leases?.get(partition, clientId);
    return {
      clientId,
      exists: true,
      client: toAdminClient(
        record,
        record.updatedAtMs >= activeFloorMs,
        maxCommitSeq,
      ),
      ...(lease !== undefined ? { lease } : {}),
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
      limit: options.limit ?? DEFAULT_COMMIT_LIMIT,
      ...(options.table !== undefined ? { table: options.table } : {}),
    });
  }

  /**
   * Inspect a single row: current server_version, stored scopes, and the
   * blobIds it references (when the store tracks references). Payload bytes
   * are deliberately NOT decoded — the console shows metadata, not content.
   */
  async inspectRow(
    partition: string,
    table: string,
    rowId: string,
  ): Promise<AdminRowInspection> {
    const read = required(
      this.#storage.getRowScopes?.bind(this.#storage),
      'storage',
    );
    if (this.#schema !== undefined) {
      await this.#storage.ensureSchema(compileSchema(this.#schema));
    }
    const row = await read(partition, table, rowId);
    if (row === undefined) {
      return { table, rowId, exists: false };
    }
    return {
      table,
      rowId,
      exists: true,
      serverVersion: row.serverVersion,
      scopes: row.scopes,
    };
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
    const cursors = await this.#storage.listClientCursors(partition);
    const activeCursors = cursors
      .filter((c) => c.updatedAtMs >= nowMs - this.#retention.activeWindowMs)
      .map((c) => c.cursor);
    const activeCursorFloor =
      activeCursors.length > 0 ? Math.min(...activeCursors) : null;
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

  /** Segment store counters alone (undefined when unsupported/unset). */
  async segmentStats(): Promise<SegmentStoreStats | undefined> {
    return this.#segments?.stats?.();
  }

  /** Blob store counters for a partition (undefined when unsupported/unset). */
  async blobStats(partition: string): Promise<BlobStoreStats | undefined> {
    return this.#blobs?.stats?.(partition);
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
   * and per-bucket counts for the console's sparkline. Only events carrying
   * this `partition` count. Empty (all zeros) when no ring is wired.
   */
  metrics(
    partition: string,
    options: { readonly windowMs?: number; readonly buckets?: number } = {},
  ): AdminMetrics {
    const windowMs = options.windowMs ?? DEFAULT_METRICS_WINDOW_MS;
    const bucketCount = options.buckets ?? DEFAULT_METRICS_BUCKETS;
    const atMs = this.#clock();
    const sinceMs = atMs - windowMs;
    const widthMs = windowMs / bucketCount;
    const counts = new Array<number>(bucketCount).fill(0);
    const errors = new Array<number>(bucketCount).fill(0);
    const durations: number[] = [];
    let requestCount = 0;
    let errorCount = 0;
    let applied = 0;
    let rejected = 0;
    let conflicted = 0;
    for (const event of this.events({ sinceMs })) {
      if (event.partition !== partition) continue;
      if (event.type === 'push.applied') applied += 1;
      else if (event.type === 'push.rejected') rejected += 1;
      else if (event.type === 'push.conflicted') conflicted += 1;
      if (event.type !== 'request.handled') continue;
      requestCount += 1;
      durations.push(event.durationMs);
      const failed = event.outcome === 'rejected' || event.outcome === 'error';
      if (failed) errorCount += 1;
      const bucket = Math.min(
        bucketCount - 1,
        Math.max(0, Math.floor((event.atMs - sinceMs) / widthMs)),
      );
      counts[bucket] = (counts[bucket] ?? 0) + 1;
      if (failed) errors[bucket] = (errors[bucket] ?? 0) + 1;
    }
    return {
      partition,
      windowMs,
      atMs,
      requests: {
        count: requestCount,
        perMinute: requestCount / (windowMs / 60_000),
        errorCount,
        errorRate: requestCount === 0 ? 0 : errorCount / requestCount,
        p50Ms: percentile(durations, 0.5),
        p95Ms: percentile(durations, 0.95),
      },
      pushes: { applied, rejected, conflicted },
      buckets: { widthMs, counts, errors },
    };
  }

  /**
   * Every partition the storage knows (commit log + client records) — the
   * fleet-view backing and the console's partition picker. Fails loud when
   * the backend omits the optional `listPartitions`.
   */
  async listPartitions(): Promise<string[]> {
    const list = required(
      this.#storage.listPartitions?.bind(this.#storage),
      'storage',
    );
    return list();
  }

  /**
   * The fleet view: one row per known partition — retained backlog, client
   * counts, prune recommendation. A cross-partition read (every other
   * method is partition-scoped); host authorization should account for it.
   */
  async partitionsOverview(): Promise<AdminPartitionOverview[]> {
    const partitions = await this.listPartitions();
    const activeFloorMs = this.#clock() - this.#retention.activeWindowMs;
    const out: AdminPartitionOverview[] = [];
    for (const partition of partitions) {
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
    return out;
  }
}
