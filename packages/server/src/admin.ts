/**
 * `SyncularAdmin` — the operator-facing read surface over the server core
 * (TODO §2.5). A read-only, partition-scoped, JSON-able query layer over
 * `ServerStorage`, the optional segment/blob store stats, and an in-memory
 * event ring. This is v2's answer to v1's full React console app: the same
 * 80% operator value (who's connected, what's flowing, horizon health, the
 * event tail) as a handful of queries in the server package — no separate
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
import { DEFAULT_RETENTION, type RetentionPolicy } from './prune';
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
  readonly updatedAtMs: number;
  readonly subscriptions: readonly {
    readonly id: string;
    readonly table: string;
    readonly scopes: Record<string, readonly string[]>;
  }[];
  /** True when the cursor record was touched within the active window. */
  readonly active: boolean;
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
  /** The event ring feeding the event tail. Absent ⇒ `events()` is empty. */
  readonly ring?: RingBufferEvents;
  readonly segments?: SegmentStore;
  readonly blobs?: BlobStore;
  /** Retention policy for horizon recommendation (defaults to §4.6). */
  readonly retention?: Partial<RetentionPolicy>;
  /** Epoch-ms clock (defaults to `Date.now`) — active-window math. */
  readonly clock?: () => number;
}

const DEFAULT_COMMIT_LIMIT = 50;
const DEFAULT_SCOPE_LIMIT = 50;

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(
      `SyncularAdmin: the configured ${what} does not implement this read (TODO §2.5 optional method missing)`,
    );
  }
  return value;
}

function toAdminClient(record: ClientRecord, active: boolean): AdminClient {
  return {
    clientId: record.clientId,
    actorId: record.actorId,
    cursor: record.cursor,
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
  readonly #ring?: RingBufferEvents;
  readonly #segments?: SegmentStore;
  readonly #blobs?: BlobStore;
  readonly #retention: RetentionPolicy;
  readonly #clock: () => number;

  constructor(options: SyncularAdminOptions) {
    this.#storage = options.storage;
    if (options.ring !== undefined) this.#ring = options.ring;
    if (options.segments !== undefined) this.#segments = options.segments;
    if (options.blobs !== undefined) this.#blobs = options.blobs;
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
      segments: config.segments,
      ...(config.blobs !== undefined ? { blobs: config.blobs } : {}),
      ...(extra?.ring !== undefined ? { ring: extra.ring } : {}),
      ...(extra?.retention !== undefined ? { retention: extra.retention } : {}),
      clock: clockOf(config),
    });
  }

  /** The known clients for a partition (cursor, last-seen, subscriptions). */
  async listClients(partition: string): Promise<AdminClient[]> {
    const list = required(
      this.#storage.listClientRecords?.bind(this.#storage),
      'storage',
    );
    const records = await list(partition);
    const activeFloorMs = this.#clock() - this.#retention.activeWindowMs;
    return records.map((record) =>
      toAdminClient(record, record.updatedAtMs >= activeFloorMs),
    );
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
}
