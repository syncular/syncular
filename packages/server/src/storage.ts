import type { AuthoritativeRelationPlan } from './authoritative-query';
/**
 * Storage interface (defined by the SPEC's needs, implementation-agnostic).
 *
 * Requirements it encodes:
 * - commit log with per-partition `commitSeq` (§2.1) and a commit→scope
 *   inverted index (§3.1): pulls filter
 *   by scope via the index, never by scanning the log;
 * - idempotency results per §2.3 persisted in the same transaction as the
 *   commit's writes (§6.4);
 * - the pruning horizon per §4.6;
 * - current-row reads for write authorization (§3.4) and conflict handling
 *   (§6.2);
 * - the per-(partition, clientId) client record: registration list,
 *   catching-up units and record cursor (§4.5, §8.1);
 * - the per-outbox acknowledged watermark (§6.3.2).
 *
 * The interface is async throughout so a Postgres implementation slots in
 * without touching the core. All methods are partition-local (§2.1).
 */
import type {
  PushOperationResult,
  RowValue,
  ScopeMap,
  UnitScopes,
} from '@syncular/core';
import type { CompiledSchema } from './schema';

export interface CommitPruneQuery {
  readonly logEpoch: string;
  readonly throughSeq: number;
}

export interface CommitPruneResult {
  readonly previousHorizonSeq: number;
  readonly horizonSeq: number;
  readonly removedCommits: number;
}

/** RFC 0007 backfill lifecycle. `activated` is terminal within a schema version. */
export type CheckpointState = 'declared' | 'backfilling' | 'activated';

/**
 * Host-owned checkpoint installation carried on `ensureSchema`: the schema
 * bump, the `declared` row, and the raised writer fence commit together.
 */
export interface CheckpointDeclaration {
  readonly partition: string;
  readonly name: string;
  readonly schemaVersion: number;
}

/** One host-storage backfill checkpoint row. Never a synced application row. */
export interface StoredCheckpoint {
  readonly partition: string;
  readonly name: string;
  readonly schemaVersion: number;
  readonly state: CheckpointState;
  /** Highest source `commit_seq` the projection was derived from. */
  readonly watermark: number;
  /** Monotonic claim counter; a batch is stale when it does not match. */
  readonly ownerEpoch: number;
  readonly observedRows: number;
  readonly updatedAtMs: number;
}

/**
 * RFC 0007 serve-gate token, read inside the transaction that produces the
 * result. `storedSchemaVersion` is the published marker; `logEpoch` is the
 * partition's log generation, so a restore that presents V -> other -> V is
 * still distinguishable. `pending` names every incomplete declared checkpoint
 * at the running schema version, across partitions.
 */
export interface ServeGate {
  readonly storedSchemaVersion: number;
  readonly logEpoch: string | undefined;
  readonly pending: readonly {
    readonly partition: string;
    readonly name: string;
  }[];
}

/**
 * The push apply's admission token: the partition lock, the serve gate, and
 * the idempotency record read in one round trip. A storage with per-statement
 * network cost answers all three with one statement (see
 * `PostgresServerStorage`); the lock is held from this call through commit.
 */
export interface PreparedPushApply {
  readonly gate: ServeGate;
  /** The already-persisted outcome for this key, or `undefined` on a miss. */
  readonly persisted: StoredPushResult | undefined;
  /**
   * The partition's delete floor (§2.2): the highest version any applied
   * delete recorded, `0` before the first. An insert starts one above it.
   */
  readonly deleteFloor: number;
  /**
   * The outbox watermark `W` after §6.3.2 step 1; present iff the call
   * carried an {@link OutboxSettlement}. A commit of the request whose
   * `persisted` is `undefined` and whose `clientSeq` is below `W` is
   * expired (`sync.commit_expired`); at or above `W` it was never seen.
   */
  readonly watermark?: number;
}

/** The outbox position of one pushed commit (§6.3.2). */
export interface OutboxSequence {
  readonly outboxId: string;
  readonly clientSeq: number;
}

/**
 * One push request's outbox, for the §9 settlement of results stored before
 * wire version 4 and §6.3.2 steps 1 and 2.
 */
export interface OutboxSettlement {
  readonly outboxId: string;
  /** Every `PUSH_COMMIT` of the request in frame order. */
  readonly commits: readonly {
    readonly clientCommitId: string;
    readonly clientSeq: number;
  }[];
}

/** Why `serveGate` refuses, or `undefined` when this request may serve. */
export type ServeGateRefusal =
  | {
      readonly kind: 'schema';
      readonly stored: number;
      readonly running: number;
    }
  | {
      readonly kind: 'checkpoint';
      readonly partition: string;
      readonly name: string;
    }
  | {
      /** The token changed between two reads: a restore rotated the epoch. */
      readonly kind: 'epoch';
    };

/**
 * Evaluate the RFC 0007 predicate against a gate token. A process that
 * declares the pending checkpoint may serve while it backfills; any other
 * process is refused, and a database newer than the running build is always
 * refused.
 */
export function serveGateRefusal(
  gate: ServeGate,
  runningSchemaVersion: number,
  checkpoints: readonly CheckpointDeclaration[] | undefined,
): ServeGateRefusal | undefined {
  if (gate.storedSchemaVersion > runningSchemaVersion) {
    return {
      kind: 'schema',
      stored: gate.storedSchemaVersion,
      running: runningSchemaVersion,
    };
  }
  for (const pending of gate.pending) {
    const declared = (checkpoints ?? []).some(
      (declaration) =>
        declaration.partition === pending.partition &&
        declaration.name === pending.name,
    );
    if (!declared) {
      return {
        kind: 'checkpoint',
        partition: pending.partition,
        name: pending.name,
      };
    }
  }
  return undefined;
}

/**
 * RFC 0007: compare two gate tokens read around a data read. The token binds
 * the published schema version and the partition log epoch, so a restore that
 * presents V → other → V is distinguishable. Returns a refusal when either
 * changed across the read.
 */
export function serveGateTokenChanged(
  before: ServeGate,
  after: ServeGate,
): ServeGateRefusal | undefined {
  if (
    before.storedSchemaVersion !== after.storedSchemaVersion ||
    before.logEpoch !== after.logEpoch
  ) {
    return { kind: 'epoch' };
  }
  return undefined;
}

/** The current stored state of a synced row. */
export interface StoredRow {
  readonly rowId: string;
  /** `server_version` (§2.2): starts at 1, +1 per applied upsert. */
  readonly serverVersion: number;
  /** Stored scopes (§3.1): variable → single value. */
  readonly scopes: Record<string, string>;
  /** Row-codec payload (§2.4) for the server's schema version. */
  readonly payload: Uint8Array;
  /**
   * §2.2 per-column versions: the `_sync_column_versions` blob (LEB128
   * (ordinal, version) pairs for columns above 1). Absent when no column
   * exceeds 1, and for rows written before column versions existed — a row
   * without the blob carries every column at `serverVersion`.
   */
  readonly columnVersions?: Uint8Array;
}

export interface NewChange {
  readonly table: string;
  readonly rowId: string;
  readonly op: 'upsert' | 'delete';
  /**
   * The row's `server_version` after the write (§2.2): an upsert's written
   * version, a delete's advanced version, which its tombstone records and
   * the delete floor rises to.
   */
  readonly rowVersion: number;
  readonly scopes: Record<string, string>;
  /** Present for upsert. */
  readonly payload?: Uint8Array;
}

/** §2.2 delete-precedence tombstone of a row deleted within the horizon. */
export interface Tombstone {
  readonly commitSeq: number;
  /**
   * The deleted row's last `server_version` and stored scopes. Both are
   * absent on a tombstone written before servers recorded them.
   */
  readonly serverVersion?: number;
  readonly scopes?: Record<string, string>;
}

export interface NewCommit {
  readonly clientId: string;
  readonly clientCommitId: string;
  readonly actorId: string;
  readonly createdAtMs: number;
  readonly changes: readonly NewChange[];
}

/**
 * §2.2: rows whose final change in this commit is an upsert that followed a
 * delete. That delete is one half of a scope move, so it MUST NOT leave a
 * tombstone behind the live row. A row whose final change is a delete keeps
 * its tombstone.
 */
export function rowsLiveAfterDelete(
  changes: readonly NewChange[],
): Set<string> {
  const last = new Map<string, NewChange['op']>();
  const deleted = new Set<string>();
  const live = new Set<string>();
  for (const change of changes) {
    const key = `${change.table}\u0000${change.rowId}`;
    if (change.op === 'delete') {
      deleted.add(key);
    } else if (deleted.has(key)) {
      live.add(key);
    }
    last.set(key, change.op);
  }
  for (const key of live) {
    if (last.get(key) !== 'upsert') live.delete(key);
  }
  return live;
}

/**
 * The delete floor a commit raises the partition's to (§2.2): the highest
 * version of a delete that leaves a tombstone, `0` without one.
 */
export function commitDeleteFloor(changes: readonly NewChange[]): number {
  const live = rowsLiveAfterDelete(changes);
  let floor = 0;
  for (const change of changes) {
    if (
      change.op === 'delete' &&
      !live.has(`${change.table}\u0000${change.rowId}`)
    ) {
      floor = Math.max(floor, change.rowVersion);
    }
  }
  return floor;
}

export interface StoredChange {
  readonly table: string;
  readonly rowId: string;
  readonly op: 'upsert' | 'delete';
  /** Absent only on a delete logged before wire version 4. */
  readonly rowVersion?: number;
  readonly scopes: Record<string, string>;
  readonly payload?: Uint8Array;
}

export interface StoredCommit {
  readonly commitSeq: number;
  readonly createdAtMs: number;
  readonly actorId: string;
  readonly changes: readonly StoredChange[];
}

/** JSON values accepted by the durable reaction payload/failure store. */
export type DurableJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly DurableJsonValue[]
  | { readonly [key: string]: DurableJsonValue };

export type ReactionStatus = 'pending' | 'leased' | 'completed' | 'dead-letter';

export interface ReactionFailure {
  /** Stable application or Syncular error identity. */
  readonly code: string;
  readonly atMs: number;
  /** Bounded JSON metadata. Diagnostic exception text is never persisted. */
  readonly details?: { readonly [key: string]: DurableJsonValue };
}

/** A validated reaction row written with its source commit. */
export interface NewReaction {
  readonly idempotencyKey: string;
  readonly type: string;
  readonly version: number;
  readonly payload: DurableJsonValue;
  readonly sourceClientId: string;
  readonly sourceClientCommitId: string;
  readonly sourceCommitSeq: number;
  readonly createdAtMs: number;
  readonly maxAttempts: number;
}

/** Durable reaction state returned to workers and administrative readers. */
export interface StoredReaction extends NewReaction {
  readonly status: ReactionStatus;
  /** Incremented atomically when a worker claims the reaction. */
  readonly attempts: number;
  readonly availableAtMs: number;
  readonly leaseOwner?: string;
  readonly leaseExpiresAtMs?: number;
  readonly completedAtMs?: number;
  readonly lastFailure?: ReactionFailure;
}

export interface ReactionClaimQuery {
  /** Opaque token unique to this claim operation. */
  readonly leaseOwner: string;
  readonly types: readonly string[];
  readonly nowMs: number;
  readonly leaseDurationMs: number;
  readonly limit: number;
}

export interface ReactionListQuery {
  readonly statuses?: readonly ReactionStatus[];
  readonly types?: readonly string[];
  readonly limit: number;
}

export interface ReactionFailureUpdate {
  readonly leaseOwner: string;
  readonly failure: ReactionFailure;
  /** Present for retry; absent moves the row to the dead-letter state. */
  readonly retryAtMs?: number;
}

export interface ReactionPruneQuery {
  readonly completedBeforeMs: number;
  readonly deadLetterBeforeMs: number;
  readonly limit: number;
}

export interface PrunedReactionCounts {
  readonly completed: number;
  readonly deadLetter: number;
}

/** Persisted push outcome for idempotent replay (§2.3, §6.3). */
export interface StoredPushResult {
  readonly status: 'applied' | 'rejected';
  /** Present iff `status` is `applied`. */
  readonly commitSeq?: number;
  /** Host clock when this terminal idempotency outcome was first recorded. */
  readonly recordedAtMs?: number;
  /** Privacy-safe identity used to distinguish this stored outcome from a race. */
  readonly cacheIdentity?: string;
  /** The scope of a persisted conflict snapshot, for replay authorization. */
  readonly conflictAuthorization?: {
    readonly table: string;
    readonly schemaVersion: number;
    readonly scopes: Readonly<Record<string, string>>;
  };
  readonly results: readonly PushOperationResult[];
}

/** The registration list a client last sent, with its digest (§4.1). */
export interface ClientRegistration {
  /** Scope maps in registration order. */
  readonly units: readonly UnitScopes[];
  /** The 32-byte registration digest. */
  readonly digest: Uint8Array;
}

/** A unit still catching up after the client's last completed round (§4.1). */
export interface CatchingUpUnit {
  /** The unit id (§4.1). */
  readonly id: string;
  /** `-1`, the bootstrap pin, or the post-bootstrap cursor `P`. */
  readonly cursor: number;
}

/** The §4.5 client record. */
export interface ClientRecord {
  readonly clientId: string;
  readonly actorId: string;
  /** SSP2 version last accepted from this client. */
  readonly wireVersion: number;
  /** The record cursor (§4.5); feeds the §4.6 retention watermark. */
  readonly cursor: number;
  readonly updatedAtMs: number;
  /**
   * Schema version of the latest completed round; realtime projects deltas
   * through its codec. Absent on a record written before wire version 4.
   */
  readonly schemaVersion?: number;
  /**
   * The stored registration list; absent when none is stored (§9: a record
   * written before wire version 4 holds none). On `putClientRecord`, absent
   * keeps the stored list and digest: a round writes them only when its
   * list traveled.
   */
  readonly registration?: ClientRegistration;
  /** Catching-up units in registration order; the rest of the list is live. */
  readonly catchingUp: readonly CatchingUpUnit[];
  /** When this client's last sync round finished, successfully or not. */
  readonly lastRoundAtMs?: number;
  /** Code of the last round when it failed; absent after a successful round. */
  readonly lastErrorCode?: string;
  /** Rounds that failed in a row since the last successful round. */
  readonly consecutiveFailures?: number;
}

/** `putClientRecord` options. */
export interface ClientRecordWriteOptions {
  /**
   * Leave the stored round outcome (`lastErrorCode`, `consecutiveFailures`)
   * untouched. Set for a completed round that carried a `ROUND_FAILURE` report
   * (§1.5, §4.5). `lastRoundAtMs` still moves to this round's completion.
   */
  readonly keepRoundOutcome?: boolean;
}

/** The round-state fields of a stored `sync_clients` row. */
export function clientRoundState(
  lastRoundAtMs: number | null,
  lastErrorCode: string | null,
  consecutiveFailures: number,
): Pick<
  ClientRecord,
  'lastRoundAtMs' | 'lastErrorCode' | 'consecutiveFailures'
> {
  return {
    ...(lastRoundAtMs !== null ? { lastRoundAtMs } : {}),
    ...(lastErrorCode !== null ? { lastErrorCode } : {}),
    ...(consecutiveFailures > 0 ? { consecutiveFailures } : {}),
  };
}

/** One unit of the §4.5 scan set. */
export interface LiveScanUnit {
  /** The unit's scope map; its first variable (keys sorted) is its index key. */
  readonly scopes: UnitScopes;
  /** Exclusive lower bound: `R`, the unit's cursor `P`, or its pin. */
  readonly afterSeq: number;
  /**
   * The unit's active (unit, table) pairs: covered table → effective scopes
   * (§3.2). A change of table `t` matches iff its stored scopes satisfy the
   * pair for `t` and its commit lies above `afterSeq`.
   */
  readonly tables: ReadonlyMap<string, ScopeMap>;
}

export interface LiveWindowQuery {
  readonly units: readonly LiveScanUnit[];
  /** `maxCommitSeq` read at the start of the pull. */
  readonly throughSeq: number;
  /** The `limitCommits` budget: stop after the commit that reaches it. */
  readonly limitChanges: number;
  /**
   * `ServerLimits.maxLiveSectionBytes`: the stored bytes (payload, row id,
   * scopes) of the changes a section loads. The section stops before the
   * commit that would pass it; a commit that passes it alone is oversized.
   */
  readonly limitBytes: number;
}

/** The commits of one live section (§4.5). */
export interface LiveWindow {
  /** Oldest first, each with its matching changes in change order. */
  readonly commits: readonly StoredCommit[];
  /**
   * `T`: `query.throughSeq`, or the last scanned `commitSeq` when a budget
   * cut the section.
   */
  readonly throughSeq: number;
  /**
   * A commit whose changes for the scan set pass `limitBytes` on their own
   * (§4.6): `units` are the indexes into `query.units` it reaches. The
   * section is unusable; the caller resets those units and reads again.
   */
  readonly oversized?: {
    readonly commitSeq: number;
    readonly units: readonly number[];
  };
}

export interface RowScanQuery {
  readonly table: string;
  /**
   * Effective scopes (§3.2): a row matches iff, for every key, its stored
   * value is in the list. Candidates come from the inverted row-scope index.
   */
  readonly scopeFilter: ScopeMap;
  /** Resume after this rowId (exclusive); `null` = start of table. */
  readonly afterRowId: string | null;
  readonly limit: number;
}

/**
 * Exact server-host lookup through one declared relational index.
 *
 * This is deliberately NOT a Syncular scope or client query. It is available
 * only to trusted server code that already owns a `ServerStorage` or
 * `StorageTransaction` capability. Every declared index column must have one
 * exact value, so adapters can keep the lookup bounded and deterministic.
 */
export interface IndexRowScanQuery {
  readonly table: string;
  /** `TableSchema.indexes[].name`; never exposed as a client subscription. */
  readonly index: string;
  /** Exact values in the index declaration's column order. */
  readonly values: readonly RowValue[];
  /** Resume after this rowId (exclusive); `null` = start of the match set. */
  readonly afterRowId?: string | null;
  /** Integer from 1 through 1,000. */
  readonly limit: number;
}

export interface ClientCursorInfo {
  readonly clientId: string;
  readonly cursor: number;
  readonly updatedAtMs: number;
}

/** Durable partition identity refreshed after host authentication (§2.1). */
/** Longest age of `lastAuthenticatedAtMs` that `touchPartition` leaves unwritten. */
export const PARTITION_TOUCH_INTERVAL_MS = 60_000;

export interface PartitionRegistryEntry {
  readonly partition: string;
  readonly logEpoch: string;
  readonly epochRequired: boolean;
  readonly lastAuthenticatedAtMs: number;
}

/**
 * Commit-log metadata (no change payloads) for the admin/console read
 * surface. `changeCount` is the number of changes the commit carries;
 * `tables` is the distinct set of tables it touched, cheap to derive from
 * the change index.
 */
export interface CommitMetadata {
  readonly commitSeq: number;
  readonly clientId: string;
  readonly clientCommitId: string;
  readonly actorId: string;
  readonly createdAtMs: number;
  readonly changeCount: number;
  readonly tables: readonly string[];
  /** The first `changeSample` changes in commit order, when requested. */
  readonly sample?: readonly CommitChangeSummary[];
}

/** One change without its payload, for commit lists. */
export interface CommitChangeSummary {
  readonly table: string;
  readonly rowId: string;
  readonly op: 'upsert' | 'delete';
}

export interface CommitMetadataQuery {
  /** Window lower bound, exclusive: `afterSeq < commitSeq`. */
  readonly afterSeq: number;
  /** Window upper bound, exclusive: `commitSeq < beforeSeq` (older pages). */
  readonly beforeSeq?: number;
  /** Newest first, at most `limit` commits. */
  readonly limit: number;
  /** Restrict to commits that touched this table (via the change index). */
  readonly table?: string;
  /** Attach the first N changes of each commit as `sample`. */
  readonly changeSample?: number;
}

export interface RowListQuery {
  readonly table: string;
  /** Resume after this rowId (exclusive); `null` = start of table. */
  readonly afterRowId: string | null;
  readonly limit: number;
}

/** One §6.3.2 watermark row. */
export interface PushWatermark {
  readonly clientId: string;
  readonly outboxId: string;
  /** `W`: results of this outbox below it are deleted. */
  readonly throughSeq: number;
}

/** A stored push outcome with the client that sent it. */
export interface ClientPushResult {
  readonly clientId: string;
  readonly result: StoredPushResult;
}

/** One retained commit with its changes, for the admin commit drill-down. */
export interface CommitDetail extends CommitMetadata {
  readonly changes: readonly StoredChange[];
}

/** One retained change to a single row, for the admin row history. */
export interface RowChangeRecord {
  readonly commitSeq: number;
  readonly op: 'upsert' | 'delete';
  readonly rowVersion?: number;
  readonly actorId: string;
  readonly clientId: string;
  readonly createdAtMs: number;
}

export interface RowChangesQuery {
  readonly table: string;
  readonly rowId: string;
  readonly limit: number;
}

/** One recent commit touching a scope key, for the admin scope activity view. */
export interface ScopeCommitActivity {
  readonly commitSeq: number;
  readonly table: string;
  readonly createdAtMs: number;
  readonly actorId: string;
  readonly changeCount: number;
}

export interface ScopeActivityQuery {
  /** The scope key as `variable + ':' + value` (§3.1) — e.g. `project:p1`. */
  readonly variable: string;
  readonly value: string;
  readonly limit: number;
}

/** A registered SELECT executed against the authoritative row projection. */
export type AuthoritativeQueryValue =
  | string
  | number
  | bigint
  | boolean
  | Uint8Array
  | null;

export interface AuthoritativeQueryRequest {
  /** Generated, positional SQLite-family SQL. It never comes from the request. */
  readonly plan: AuthoritativeRelationPlan;
  readonly params: readonly AuthoritativeQueryValue[];
  /** Generated dependency set, used to validate and partition every relation. */
  readonly tables: readonly string[];
}

/** One transactionally consistent authoritative query snapshot. */
export interface AuthoritativeQueryResult {
  readonly rows: readonly Readonly<Record<string, unknown>>[];
  readonly maxCommitSeq: number;
}

/**
 * One transaction per push commit (§6.4): all row writes, the appended
 * commit (with its scope-index entries), and the idempotency record either
 * land together or not at all.
 */
export interface StorageTransaction {
  getRow(table: string, rowId: string): Promise<StoredRow | undefined>;
  /**
   * Optional candidate-state batch read by primary key. A storage with
   * per-statement network cost answers any number of ids in one statement
   * (Postgres binds the ids as one array); SQLite and D1 issue one lookup per
   * id. Absent ids are missing from the map and repeated ids read once. The
   * result observes this transaction's staged writes and deletes, exactly as
   * `getRow` does. Both commit readers fall back to one `getRow` per id when
   * a custom transaction omits the capability.
   */
  getRows?(
    table: string,
    rowIds: readonly string[],
  ): Promise<ReadonlyMap<string, StoredRow>>;
  /**
   * Optional read-ahead: the push layer names every row a commit's
   * operations target, across every table, before it applies them. A storage
   * with per-statement network cost reads them in one statement (one branch
   * per table) and answers the following `getRow` calls from that snapshot
   * until the row is written in this transaction.
   */
  prefetchRows?(
    targets: readonly {
      readonly table: string;
      readonly rowIds: readonly string[];
    }[],
  ): Promise<void>;
  /**
   * §5 delete-precedence tombstone read: the newest applied delete of this
   * row still within the pruning horizon, or `undefined` when no tombstone
   * exists. Consulted only when an upsert's stored row is absent. Required:
   * in-tree adapters implement it on the transaction's own connection with
   * read-your-own-writes semantics.
   */
  getTombstone(table: string, rowId: string): Promise<Tombstone | undefined>;
  /**
   * Remove the row's tombstone because the row is live again in this
   * transaction: an insert over its tombstone (§6.2) or a §2.2 scope move.
   * A no-op when no tombstone exists.
   */
  clearTombstone(table: string, rowId: string): Promise<void>;
  /**
   * Optional candidate-state scan used only by whole-commit validation.
   * In-tree SQLite/Postgres/D1 backends implement it with read-your-own-writes
   * semantics. A custom backend may omit it until `commitValidator` is used.
   */
  scanRows?(query: RowScanQuery): Promise<StoredRow[]>;
  /**
   * Optional additive capability for trusted authoritative commands. In-tree
   * SQLite/PostgreSQL/D1 adapters implement it with transaction-local
   * read-your-own-writes semantics. It is not reachable from SSP2 requests.
   */
  scanRowsByIndex?(query: IndexRowScanQuery): Promise<StoredRow[]>;
  /**
   * Optional transaction-bound registered query (§6.7, §6.8): the relation
   * rewrite of `ServerStorage.queryAuthoritative`, bound to this
   * transaction's partition and executed on this transaction's connection.
   * A hook inside the push transaction therefore reads the transaction's
   * snapshot and never waits for a second connection. The push layer has
   * already evaluated the serve gate on this transaction, so the call takes
   * no checkpoint declarations. SQLite and PostgreSQL return the staged
   * writes of this transaction. D1 buffers writes until commit and fails
   * with `sync.storage.query_over_staged_writes` when the query reads a
   * table this transaction has written.
   */
  queryAuthoritative?(
    query: AuthoritativeQueryRequest,
  ): Promise<AuthoritativeQueryResult>;
  /**
   * Acquire the push-serialization lock until commit or rollback. This
   * capability does not evaluate the serve gate; host-owned authority paths
   * use `prepareAuthorityTransaction` before reading or writing. Optional so
   * existing custom storage implementations fail closed at that boundary.
   */
  lockPartition?(): Promise<void>;
  /**
   * Serialize every push apply for this partition before any operation read,
   * validation, merge, or write, and read the admission token in the same
   * round trip: the RFC 0007 serve gate and the §2.3 idempotency record for
   * `clientCommitId`. The lock is retained through terminal-result commit,
   * so the idempotency read is exact and a racing duplicate cannot rerun.
   * `targets` are the rows the commit is known to touch before its operations
   * are built; a storage with per-statement network cost folds that read-ahead
   * into the admission read and answers the following `getRow` calls from it.
   * Missing support fails closed before an app-row mutation.
   *
   * `outbox`, passed with the first commit of a request that carries an
   * `outboxId`, settles the client's results stored before wire version 4
   * (§9) and runs §6.3.2 steps 1 and 2 under the same lock, before the read
   * of `persisted`. Those writes survive `commitRejectedPushResult`; the
   * caller commits this transaction whatever the commit's outcome, so the
   * settlement runs exactly once per request.
   */
  preparePushApply(
    clientId: string,
    clientCommitId: string,
    runningSchemaVersion: number,
    targets?: readonly {
      readonly table: string;
      readonly rowIds: readonly string[];
    }[],
    outbox?: OutboxSettlement,
  ): Promise<PreparedPushApply>;
  /**
   * Rejection finalization while the push-apply serialization lock is still
   * held: discard every candidate write, persist the rejected idempotency
   * result, and finish the transaction atomically. Returns the persisted
   * canonical outcome, so the caller never re-reads it. Required for every
   * push so a concurrent duplicate cannot rerun operations, validators, or
   * merges.
   */
  commitRejectedPushResult(
    clientId: string,
    clientCommitId: string,
    result: StoredPushResult,
    sequence?: OutboxSequence,
  ): Promise<StoredPushResult>;
  upsertRow(
    table: string,
    row: StoredRow,
    context?: { readonly opIndex: number },
  ): Promise<void>;
  deleteRow(table: string, rowId: string): Promise<void>;
  /** Allocates the next per-partition commitSeq and appends the commit. */
  appendCommit(commit: NewCommit): Promise<number>;
  /**
   * Persist reaction rows in this authoritative transaction. Required when
   * the host configures a reaction planner. Reactions survive commit-log
   * pruning because they live outside the commit/change tables.
   */
  enqueueReactions?(reactions: readonly NewReaction[]): Promise<void>;
  /**
   * Persist an idempotency outcome only when the key is still absent. The
   * first writer wins; callers read the canonical value after commit. A
   * result without `sequence` (no `outboxId`, §6.10, §12.3) is never deleted
   * by a watermark.
   */
  putPushResult(
    clientId: string,
    clientCommitId: string,
    result: StoredPushResult,
    sequence?: OutboxSequence,
  ): Promise<void>;
  /**
   * Advance this partition's checkpoint only while `owner_epoch` still
   * matches, so the owner-epoch CAS rides inside the caller's transaction.
   * The host calls this from `processPushOperationsWithTrace`'s operation
   * builder: the backfill is an ordinary server-authoritative write, and this
   * CAS commits with that write's row versions and commit-log append. False
   * means abort and write nothing, rather than a throw for a superseded owner.
   */
  advanceCheckpoint(
    name: string,
    ownerEpoch: number,
    watermark: number,
    observedRows: number,
    nowMs: number,
  ): Promise<boolean>;
  /**
   * RFC 0007 serve gate on the caller's own connection, for write paths that
   * already hold the partition lock: the gate and the write share one
   * transaction, so a migration cannot interleave between them.
   */
  readServeGate(runningSchemaVersion: number): Promise<ServeGate>;
  /**
   * Blob reference index (§5.9.4) — ADDITIVE, optional. Set the blobIds a
   * row currently references (empty = clear), replacing any prior entries
   * for (table, rowId), inside the same commit transaction (§6.4). A
   * storage backend that omits this does not support blobs; the push layer
   * only calls it for tables with `blob_ref` columns.
   */
  setBlobRefs?(
    table: string,
    rowId: string,
    blobIds: readonly string[],
  ): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

/**
 * The commit readers' batch read: delegate to the transaction's `getRows`
 * when it implements the capability, otherwise issue one `getRow` per id.
 * Both paths read the same candidate state; only the statement count differs.
 */
export async function readCandidateRows(
  tx: StorageTransaction,
  table: string,
  rowIds: readonly string[],
): Promise<ReadonlyMap<string, StoredRow>> {
  const ids = [...new Set(rowIds)];
  if (ids.length === 0) return new Map();
  if (tx.getRows !== undefined) return tx.getRows(table, ids);
  const rows = new Map<string, StoredRow>();
  for (const rowId of ids) {
    const row = await tx.getRow(table, rowId);
    if (row !== undefined) rows.set(rowId, row);
  }
  return rows;
}

export interface ServerStorage {
  /**
   * Create/migrate the relational per-app row tables for `schema`
   * Idempotent and cheap when the
   * stored schema version already matches (one marker read, memoized per
   * instance); on first use it creates the tables, on a version bump it
   * applies the migration subset (CREATE TABLE / ADD COLUMN / CREATE
   * INDEX). The handler calls this before serving; hosts that drive
   * storage directly (tests, admin tooling) call it once up front. Row
   * operations for tables not covered by an `ensureSchema` call throw.
   *
   * This low-level storage seam accepts a `CompiledSchema`. Application hosts
   * should call `ensureSyncServerReady(config)` with their generated schema
   * before binding a public port; protocol handlers still call this method
   * lazily as a defensive backstop.
   */
  ensureSchema(
    schema: CompiledSchema,
    checkpoints?: readonly CheckpointDeclaration[],
  ): Promise<void>;

  /**
   * Create or refresh the authenticated partition registry row (§2.1). A
   * row whose `lastAuthenticatedAtMs` is less than
   * {@link PARTITION_TOUCH_INTERVAL_MS} behind `authenticatedAtMs` is read
   * back without a write, so a request that only reads takes no write lock.
   */
  touchPartition(
    partition: string,
    authenticatedAtMs: number,
    initialLogEpoch: string,
  ): Promise<PartitionRegistryEntry>;
  /**
   * Rotate log continuity after restore and delete the partition's client
   * records. Watermark rows stay (§6.3.2).
   */
  rotatePartitionLogEpoch(
    partition: string,
    logEpoch: string,
    authenticatedAtMs: number,
  ): Promise<PartitionRegistryEntry>;
  /** Registry entries ordered by partition for maintenance loops. */
  listPartitionRegistry(): Promise<PartitionRegistryEntry[]>;

  /** Read continuity without refreshing authenticated activity. */
  getPartitionLogEpoch(partition: string): Promise<string | undefined>;

  /**
   * Open a storage transaction. This is the raw primitive, not a command
   * boundary: it acquires NO partition write lock. In-tree SQLite begins
   * `IMMEDIATE`, so a hand-rolled command on SQLite happens to be serialized
   * against a concurrent push; PostgreSQL's `BEGIN` takes no row lock, so the
   * same command races a push on Postgres and a SQLite-only test conceals it.
   *
   * A trusted command may run through `registerRemoteCommand`, which builds
   * after `preparePushApply` and shares the committed transaction. A
   * host-owned non-push transaction calls `prepareAuthorityTransaction`
   * before its first authority, version, or application-row read. SSP2
   * request handling takes its own push boundary.
   */
  begin(partition: string): Promise<StorageTransaction>;

  getMaxCommitSeq(partition: string): Promise<number>;
  getHorizonSeq(partition: string): Promise<number>;
  /** Monotonic within the current epoch; use atomic pruning for maintenance. */
  setHorizonSeq(partition: string, seq: number): Promise<void>;
  /**
   * Atomically verifies the log epoch, advances the horizon monotonically,
   * and removes log/change/scope records through the effective horizon.
   */
  pruneCommitsThrough(
    partition: string,
    query: CommitPruneQuery,
  ): Promise<CommitPruneResult>;
  /** Newest commitSeq created strictly before the timestamp; 0 if none. */
  getCommitSeqBefore(
    partition: string,
    createdBeforeMs: number,
  ): Promise<number>;

  /** Every declared backfill checkpoint for the partition, ordered by name. */
  readCheckpoints(partition: string): Promise<StoredCheckpoint[]>;
  /**
   * RFC 0007 serve gate: read the published schema version, the partition's
   * log epoch, and every incomplete declared checkpoint at
   * `runningSchemaVersion`. Never memoized; the serve paths call it per
   * request so an already-serving process notices a migration.
   */
  readServeGate(
    partition: string,
    runningSchemaVersion: number,
  ): Promise<ServeGate>;
  /**
   * Atomically take ownership of a declared or backfilling checkpoint. Increments
   * `owner_epoch` and moves `declared` to `backfilling`. Throws
   * `sync.storage.checkpoint_not_declared` when no claimable row exists (absent,
   * or already `activated`).
   */
  claimCheckpoint(
    partition: string,
    name: string,
    schemaVersion: number,
    nowMs: number,
  ): Promise<StoredCheckpoint>;
  /**
   * Advance the watermark only while `owner_epoch` still matches. Returns false
   * for a superseded owner; the stale case never throws.
   */
  advanceCheckpoint(
    partition: string,
    name: string,
    ownerEpoch: number,
    watermark: number,
    observedRows: number,
    nowMs: number,
  ): Promise<boolean>;
  /** Highest commitSeq carrying a change to one of `tables`; 0 when none. */
  sourceCoverageSeq(
    partition: string,
    tables: readonly string[],
  ): Promise<number>;
  /**
   * Whether any source change sits above `seq`. `unverifiable` when the pruning
   * horizon has passed `seq`, so the history that would answer the question is
   * gone; a pruned window is never reported as `clean`.
   */
  hasSourceChangesAbove(
    partition: string,
    tables: readonly string[],
    seq: number,
  ): Promise<'clean' | 'changed' | 'unverifiable'>;
  /**
   * Install the barrier: insert the checkpoint in `declared` and raise
   * `required_writer_version` for the partition in one transaction. The fence
   * is raised at declaration, before any backfill work, so old writers are
   * rejected for the whole backfill window. Idempotent on an existing declared
   * or backfilling row.
   */
  declareCheckpoint(
    partition: string,
    name: string,
    schemaVersion: number,
    nowMs: number,
  ): Promise<StoredCheckpoint>;
  /**
   * Activate a declared checkpoint under the partition write lock. Refuses when
   * the fence is not already raised at the checkpoint's schema version, when a
   * source change sits above `watermark` (`stale`), or when the pruning horizon
   * has passed `watermark` (`unverifiable`). `activated` is terminal.
   */
  activateCheckpoint(
    partition: string,
    name: string,
    ownerEpoch: number,
    watermark: number,
    sources: readonly string[],
    nowMs: number,
  ): Promise<'activated' | 'stale' | 'unverifiable'>;
  getRow(
    partition: string,
    table: string,
    rowId: string,
  ): Promise<StoredRow | undefined>;

  /**
   * Idempotency lookup (§2.3). Throws `SyncError sync.idempotency_cache_miss`
   * when a persisted result exists but cannot be read (§6.3).
   */
  getPushResult(
    partition: string,
    clientId: string,
    clientCommitId: string,
  ): Promise<StoredPushResult | undefined>;

  /**
   * Atomically lease due or expired-lease reactions for one worker. Optional
   * for compatibility with custom storages; reaction runners fail closed when
   * any lifecycle method is absent.
   */
  claimReactions?(
    partition: string,
    query: ReactionClaimQuery,
  ): Promise<StoredReaction[]>;
  /** Acknowledge only while `leaseOwner` still owns the lease. */
  completeReaction?(
    partition: string,
    idempotencyKey: string,
    leaseOwner: string,
    completedAtMs: number,
  ): Promise<boolean>;
  /** Extend only while `leaseOwner` still owns the active lease. */
  extendReactionLease?(
    partition: string,
    idempotencyKey: string,
    leaseOwner: string,
    leaseExpiresAtMs: number,
  ): Promise<boolean>;
  /** Retry or dead-letter only while `leaseOwner` still owns the lease. */
  failReaction?(
    partition: string,
    idempotencyKey: string,
    update: ReactionFailureUpdate,
  ): Promise<boolean>;
  /** Reset a dead-lettered row for an explicit operator retry. */
  retryReaction?(
    partition: string,
    idempotencyKey: string,
    nowMs: number,
  ): Promise<boolean>;
  getReaction?(
    partition: string,
    idempotencyKey: string,
  ): Promise<StoredReaction | undefined>;
  listReactions?(
    partition: string,
    query: ReactionListQuery,
  ): Promise<StoredReaction[]>;
  /** Delete a bounded set of aged terminal rows. Never deletes active work. */
  pruneReactions?(
    partition: string,
    query: ReactionPruneQuery,
  ): Promise<PrunedReactionCounts>;

  /**
   * The §4.5 live section: every commit in `(min afterSeq, throughSeq]`
   * carrying a change that matches a unit of the scan set, oldest first,
   * each with its matching changes once, in change order, across tables.
   * Stops after the commit whose matching changes reach `limitChanges`, or
   * before the commit that would pass `limitBytes` (never splitting a
   * commit). Candidates come from the change-scope key index, one index
   * range per distinct unit key, never from a log scan, and only changes of
   * a covered table carrying a unit key's value are read.
   */
  readLiveWindow(
    partition: string,
    query: LiveWindowQuery,
  ): Promise<LiveWindow>;

  /**
   * Newest commitSeq whose changes to `query.table` carry every value of
   * the unit's scope map in the change-scope index. Every change the unit
   * would receive for the table, and each half of a scope move into or out
   * of it, carries all of those values, so none sits above it. 0 when the
   * index holds none (never written, or pruned). The §4.7 sqlite-lane scope
   * pin reads it; it MUST seek the keys' index ranges (one seek per key per
   * jump between them) and never scan the commits above the result.
   */
  latestScopedChangeSeq(
    partition: string,
    query: { readonly table: string; readonly scopes: UnitScopes },
  ): Promise<number>;

  /** Scope-filtered snapshot scan, ordered by rowId (bootstrap paging). */
  scanRows(partition: string, query: RowScanQuery): Promise<StoredRow[]>;

  /**
   * Optional registered-query capability. The implementation MUST replace
   * every generated app-table relation with a partition-filtered relation and
   * return rows plus maxCommitSeq from one consistent database snapshot.
   *
   * Do not call this method from a hook that runs inside the push
   * transaction (a row validator, the whole-commit validator, or a reaction
   * planner). On a single-connection executor (SQLite, PGlite) the storage
   * serializes this call behind the open transaction, so the hook waits on
   * the transaction it is inside and the push never completes. A pool-backed
   * executor (`pg`, `Bun.sql`) runs the call on a second connection: it reads
   * committed state without the transaction's staged writes, and it waits
   * forever when the push transactions hold every pool connection. Those
   * hooks call the transaction-bound `queryAuthoritative` on
   * `ValidateContext` or on the candidate-state reader instead (§6.7, §6.8).
   * A call from any other context waits for the open transaction on a
   * single-connection executor and runs concurrently on a pool-backed one.
   */
  queryAuthoritative?(
    partition: string,
    query: AuthoritativeQueryRequest,
    checkpoints?: readonly CheckpointDeclaration[],
  ): Promise<AuthoritativeQueryResult>;

  /**
   * Optional trusted-host exact lookup through a declared relational index.
   * This capability is outside client scope/subscription authorization and
   * MUST NOT be re-exported as a client-controlled endpoint.
   */
  scanRowsByIndex?(
    partition: string,
    query: IndexRowScanQuery,
  ): Promise<StoredRow[]>;

  getClientRecord(
    partition: string,
    clientId: string,
  ): Promise<ClientRecord | undefined>;
  /**
   * Write the record for a completed round (§4.5). A record without
   * `registration` keeps the stored list and digest. The round-state fields
   * reset: the stored last round is a success at `lastRoundAtMs` (default
   * `updatedAtMs`) with no failures, unless `keepRoundOutcome` is set, which
   * leaves the reported code and streak in place (the round carried a
   * `ROUND_FAILURE` report, §1.5/§4.5). An `unregistered` answer rewrites the
   * stored record with only `lastRoundAtMs` moved.
   */
  putClientRecord(
    partition: string,
    record: ClientRecord,
    options?: ClientRecordWriteOptions,
  ): Promise<void>;
  /**
   * Record a failed round on an existing record: set `lastRoundAtMs` and
   * `lastErrorCode`, and increment `consecutiveFailures`. Requires a matching
   * actor; a missing record or another actor's record is unchanged, and
   * `updatedAtMs` (the pruning liveness signal) is never touched.
   */
  recordClientRoundFailure(
    partition: string,
    clientId: string,
    actorId: string,
    errorCode: string,
    atMs: number,
  ): Promise<void>;
  /**
   * §8.2 ack: atomically raise an existing record's cursor to `cursor`,
   * capped at the lowest non-negative cursor of its catching-up units, and
   * its activity timestamp, both monotonically. Every other field stays;
   * requires the matching actor and the current log epoch. A missing record
   * or a mismatched identity is unchanged.
   */
  advanceClientCursor(
    partition: string,
    clientId: string,
    actorId: string,
    logEpoch: string,
    cursor: number,
    updatedAtMs: number,
  ): Promise<void>;
  /**
   * Minimum non-negative cursor with updatedAtMs >= cutoff (§4.6); null when
   * none are active. A bootstrapping client (cursor < 0) holds no cursor.
   */
  getActiveClientCursorFloor(
    partition: string,
    cutoffMs: number,
  ): Promise<number | null>;
  /** Cursor records for client listings and administrative counts. */
  listClientCursors(partition: string): Promise<ClientCursorInfo[]>;

  /**
   * Blob reference index reads (§5.9.4) — ADDITIVE, optional (mirrors the
   * optional `StorageTransaction.setBlobRefs`).
   *
   * `listRowsReferencingBlob`: the (table, rowId) rows that reference the
   * blob — the download authorization candidate set (§5.9.5). Each result
   * carries the row's stored scopes so the caller runs the §3.4 scope test
   * without a second read.
   *
   * `listReferencedBlobIds`: every blobId a live row currently references —
   * the orphan sweep's keep-set (§5.9.2).
   */
  listRowsReferencingBlob?(
    partition: string,
    blobId: string,
  ): Promise<BlobReferencingRow[]>;
  listReferencedBlobIds?(partition: string): Promise<string[]>;

  /**
   * §4.6.1 scope-value erasure — ADDITIVE, optional; `eraseScopeValue`
   * requires both.
   *
   * `listScopeValueRows`: up to `limit` rowIds of `table` whose stored scope
   * binds `variable` to `value`, ordered by rowId (the row scope index).
   *
   * `eraseScopeValueHistory`: under the partition write lock, removes up to
   * `limit` upsert change records of `table` at or below `throughSeq` whose
   * scopes bind `variable` to `value`, then up to `limit` change scope index
   * entries of that binding whose commit holds no such change any more,
   * then strips `serverRow` from up to `limit` stored conflict results of
   * `table` whose conflict authorization scopes bind `variable` to `value`.
   * Delete change records stay: clients behind the erasure still need them.
   * Returns the number of records removed or stripped.
   */
  listScopeValueRows?(
    partition: string,
    query: ScopeValueQuery,
  ): Promise<string[]>;
  eraseScopeValueHistory?(
    partition: string,
    query: ScopeValueHistoryQuery,
  ): Promise<number>;

  /**
   * Admin/console read surface (`SyncularAdmin`): ADDITIVE,
   * optional. All read-only, partition-scoped, and JSON-able. A backend
   * that omits these simply cannot serve the console; the sync path never
   * calls them.
   *
   * `listClientRecords`: every stored client record for the partition
   * (cursor, last-seen, registration list): the "who's connected" view.
   * `listCommitMetadata`: the commit log without payloads (metadata +
   * touched tables), the newest-oriented window an operator inspects.
   * `scopeActivity`: the recent commits touching one scope key, via the
   * change scope index (never a log scan).
   * `getCommit`: one retained commit with its changes and payloads;
   * `undefined` when the commit does not exist or was pruned.
   * `listRowChanges`: the retained changes to one row, newest first. It
   * reads the partition's retained log without a dedicated index, so the
   * write path pays nothing for it and its cost is bounded by retention.
   * `listRows`: one table's rows ordered by rowId, without a scope filter.
   * `countRows`: one table's row count.
   * `listPushResults`: every stored idempotency outcome for one
   * clientCommitId across the partition's clients, scanning the retained
   * outcomes without a dedicated index.
   * `listPushWatermarks`: the §6.3.2 watermark rows of every client whose
   * retained commit log carries the clientCommitId; a commit whose result
   * the watermark deleted reads as "expired below sequence `throughSeq`".
   * `listPartitions`: the partition-only compatibility view of
   * `listPartitionRegistry`, sorted.
   */
  listClientRecords?(partition: string): Promise<ClientRecord[]>;
  listCommitMetadata?(
    partition: string,
    query: CommitMetadataQuery,
  ): Promise<CommitMetadata[]>;
  scopeActivity?(
    partition: string,
    query: ScopeActivityQuery,
  ): Promise<ScopeCommitActivity[]>;
  getCommit?(
    partition: string,
    commitSeq: number,
  ): Promise<CommitDetail | undefined>;
  listRowChanges?(
    partition: string,
    query: RowChangesQuery,
  ): Promise<RowChangeRecord[]>;
  listRows?(partition: string, query: RowListQuery): Promise<StoredRow[]>;
  countRows?(partition: string, table: string): Promise<number>;
  listPushResults?(
    partition: string,
    clientCommitId: string,
  ): Promise<ClientPushResult[]>;
  listPushWatermarks?(
    partition: string,
    clientCommitId: string,
  ): Promise<PushWatermark[]>;
  listPartitions(): Promise<string[]>;
}

/** One scope binding of one table, budgeted (§4.6.1). */
export interface ScopeValueQuery {
  readonly table: string;
  readonly variable: string;
  readonly value: string;
  readonly limit: number;
}

export interface ScopeValueHistoryQuery extends ScopeValueQuery {
  readonly throughSeq: number;
}

/** A row referencing a blob, with the scopes needed to authorize download. */
export interface BlobReferencingRow {
  readonly table: string;
  readonly rowId: string;
  readonly scopes: Record<string, string>;
}
