/**
 * SyncClient — the B3 client protocol core (SPEC.md §§3–8 client side).
 *
 * A plain library running on whatever thread it is constructed on
 * (worker-OPTIONAL, REVISE B3): storage behind `ClientDatabase`, network
 * behind `SyncTransport`/`SegmentDownloader`/`RealtimeConnector`, multi-tab
 * ownership behind `LeaderLock`. One combined push+pull request per
 * `sync()` round (§7.2); local reads go straight to the database.
 */
import {
  type CommitFrame,
  canonicalScopeJson,
  decodeMessage,
  decodeRow,
  decodeRowsSegment,
  encodeMessage,
  MessageStreamScanner,
  PROTOCOL_WIRE_VERSION,
  type PushResultFrame,
  parseRealtimeServerEvent,
  REALTIME_TAG_DELTA,
  REALTIME_TAG_ROUND,
  type RequestFrame,
  type ResponseMessage,
  type RowValue,
  type ScopeMap,
  type SegmentRefFrame,
  type SubStartFrame,
  type WakeReason,
} from '@syncular-v2/core';
import {
  applyCommitFrame,
  applyRowsSegment,
  applySqliteSegment,
  deleteLocalRow,
  deleteScopedRows,
  upsertLocalRow,
} from './apply';
import {
  type BlobRef,
  type BlobTransport,
  type CachedBlob,
  clearPendingUpload,
  computeBlobId,
  ensureBlobSchema,
  getCachedBlob,
  listPendingUploads,
  parseBlobRef,
  putCachedBlob,
  reconcileBlobRefcounts,
  recordPendingUpload,
  schemaHasBlobs,
  serializeBlobRef,
} from './blob';
import type { ClientDatabase, SqlRow, SqlValue } from './database';
import { ClientSyncError } from './errors';
import {
  type LeaderLease,
  type LeaderLock,
  singleOwnerLock,
} from './leader-lock';
import {
  appendOutboxCommit,
  deleteOutboxCommit,
  dropOutboxCommitsInScope,
  encodeOutboxCommit,
  listOutbox,
  type OutboxCommit,
  type OutboxOperation,
} from './outbox';
import {
  type ClientSchema,
  type CompiledClientSchema,
  type CompiledClientTable,
  compileClientSchema,
  ensureLocalSchema,
  jsonToRowValue,
  OPTIMISTIC_VERSION,
  quoteIdent,
  recordToRowValues,
  rowValueToJson,
  SYNC_VERSION_COLUMN,
} from './schema';
import {
  deleteSubscription,
  getMeta,
  getSubscription,
  loadSubscriptions,
  type SubscriptionRecord,
  saveSubscription,
  setMeta,
} from './state';
import type {
  RealtimeConnector,
  RealtimeSocket,
  SegmentDownloader,
  SyncTransport,
} from './transport';

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export type MutationInput =
  | {
      readonly table: string;
      readonly op: 'upsert';
      /** Full-row values keyed by column name (§6.1: full row payloads). */
      readonly values: Readonly<Record<string, unknown>>;
      readonly baseVersion?: number;
    }
  | {
      readonly table: string;
      readonly op: 'delete';
      readonly rowId: string;
      readonly baseVersion?: number;
    };

/** A §6.3 conflict result, surfaced to the app — never auto-resolved. */
export interface ConflictRecord {
  readonly clientCommitId: string;
  readonly opIndex: number;
  readonly table: string;
  readonly rowId: string;
  readonly code: string;
  readonly message: string;
  readonly serverVersion: number;
  /** The current server row, decoded — resolve without a round-trip. */
  readonly serverRow: Readonly<Record<string, RowValue>>;
  /** The losing local operation (absent only for malformed op indexes). */
  readonly operation?: OutboxOperation;
}

/** A non-conflict `error` result from a rejected commit (§6.3). */
export interface RejectionRecord {
  readonly clientCommitId: string;
  readonly opIndex: number;
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly operation?: OutboxOperation;
}

export interface SchemaFloor {
  readonly requiredSchemaVersion?: number;
  readonly latestSchemaVersion?: number;
}

/**
 * §7.3.5: the client's view of its current auth lease — opaque state, the
 * mirror of `schemaFloor`. `leaseId`/`expiresAtMs` come from the last
 * `LEASE` frame; `errorCode` is set (and syncing stops on the lease) when
 * the server rejects a round with a request-level lease code (§7.3.4).
 * The lease is never cryptographically verified by the client (§7.3
 * non-goal 1), and lease errors never purge local data (§7.3.4).
 */
export interface LeaseState {
  readonly leaseId?: string;
  readonly expiresAtMs?: number;
  /** `sync.auth_lease_required` | `sync.auth_lease_revoked` when stopped. */
  readonly errorCode?: string;
}

export interface SyncSummary {
  /** Commits sent in this round's push half. */
  readonly pushed: number;
  /** clientCommitIds drained (`applied` or `cached`, §6.3). */
  readonly applied: readonly string[];
  /** clientCommitIds rejected and dropped from the outbox. */
  readonly rejected: readonly string[];
  /** clientCommitIds kept for retry (`sync.idempotency_cache_miss`). */
  readonly retryable: readonly string[];
  /** New conflict records surfaced this round. */
  readonly conflicts: readonly ConflictRecord[];
  /** `COMMIT` frames applied locally. */
  readonly commitsApplied: number;
  /** Snapshot rows applied from segments. */
  readonly segmentRowsApplied: number;
  /** Subscriptions still mid-bootstrap (resume token pending). */
  readonly bootstrapping: readonly string[];
  /** Subscriptions reset via `sync.cursor_expired` (re-pull needed). */
  readonly resets: readonly string[];
  /** Subscriptions revoked this round (§3.3 purge ran). */
  readonly revoked: readonly string[];
  /** Subscriptions stopped by a fatal configuration error (§3.3/§5.6
   * fail-closed: no local scope-column mapping). */
  readonly failed: readonly string[];
  /** Present when the server declared a schema floor — syncing stopped. */
  readonly schemaFloor?: SchemaFloor;
}

export interface SyncClientLimits {
  readonly limitCommits?: number;
  readonly limitSnapshotRows?: number;
  readonly maxSnapshotPages?: number;
  /**
   * §4.2 accept bitmask; defaults to inline + external rows (0b0011)
   * plus sqlite images (bit 2) when the database backend implements
   * `withSqliteImage` and a segment downloader is configured (§5.3).
   */
  readonly accept?: number;
}

export interface SyncClientConfig {
  readonly database: ClientDatabase;
  readonly schema: ClientSchema;
  readonly transport: SyncTransport;
  readonly segments?: SegmentDownloader;
  /** Blob upload/download (§5.9). Required to use `uploadBlob`/`fetchBlob`. */
  readonly blobs?: BlobTransport;
  readonly realtime?: RealtimeConnector;
  /** Stable per-device id (§1.5); defaults to a persisted random UUID. */
  readonly clientId?: string;
  readonly leaderLock?: LeaderLock;
  readonly lockName?: string;
  readonly limits?: SyncClientLimits;
  readonly now?: () => number;
  /** §8: hello `requiresSync` or a wake-up — run a pull soon. */
  readonly onSyncNeeded?: (reason: 'hello' | WakeReason) => void;
  readonly onConflict?: (conflict: ConflictRecord) => void;
}

export interface SubscribeInput {
  readonly id: string;
  readonly table: string;
  readonly scopes: ScopeMap;
  readonly params?: string;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** §4.2 accept bits the client cares about. */
const ACCEPT_ROWS_BASELINE = 0b0011;
const ACCEPT_SQLITE = 1 << 2;
const ACCEPT_SIGNED_URLS = 1 << 3;

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    bytes.slice().buffer as ArrayBuffer,
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

interface OpenSection {
  readonly start: SubStartFrame;
  readonly sub: SubscriptionRecord | undefined;
  /** Fresh bootstrap (§5.6): request had cursor < 0 and no resume token. */
  readonly fresh: boolean;
  /** Skip application entirely (unknown sub, delta during bootstrap, …). */
  skip: boolean;
  cleared: boolean;
}

/** §8.7 client side: one in-flight socket round's response assembly. */
interface PendingRound {
  readonly scanner: MessageStreamScanner;
  readonly resolve: (bytes: Uint8Array) => void;
  readonly reject: (error: ClientSyncError) => void;
}

interface MutableSummary {
  pushed: number;
  applied: string[];
  rejected: string[];
  retryable: string[];
  conflicts: ConflictRecord[];
  commitsApplied: number;
  segmentRowsApplied: number;
  resets: string[];
  revoked: string[];
  failed: string[];
}

function emptySummary(pushed: number): MutableSummary {
  return {
    pushed,
    applied: [],
    rejected: [],
    retryable: [],
    conflicts: [],
    commitsApplied: 0,
    segmentRowsApplied: 0,
    resets: [],
    revoked: [],
    failed: [],
  };
}

export class SyncClient {
  readonly #config: SyncClientConfig;
  readonly #db: ClientDatabase;
  readonly #schema: CompiledClientSchema;
  readonly #now: () => number;
  #started = false;
  #lease: LeaderLease | undefined;
  #clientId = '';
  #schemaFloor: SchemaFloor | undefined;
  #leaseState: LeaseState | undefined;
  #conflicts: ConflictRecord[] = [];
  #rejections: RejectionRecord[] = [];
  #socket: RealtimeSocket | undefined;
  #pendingRound: PendingRound | undefined;
  #needsPull = false;
  #syncing = false;
  readonly #hasBlobs: boolean;

  constructor(config: SyncClientConfig) {
    this.#config = config;
    this.#db = config.database;
    this.#schema = compileClientSchema(config.schema);
    this.#now = config.now ?? Date.now;
    this.#hasBlobs = schemaHasBlobs(this.#schema);
  }

  // -- lifecycle ------------------------------------------------------------

  /** Acquire leadership, create local tables, resolve the clientId. */
  async start(): Promise<void> {
    if (this.#started) return;
    const lock = this.#config.leaderLock ?? singleOwnerLock();
    this.#lease = await lock.acquire(
      this.#config.lockName ?? 'syncular-leader',
    );
    ensureLocalSchema(this.#db, this.#schema);
    if (this.#hasBlobs) ensureBlobSchema(this.#db);
    const persisted = getMeta(this.#db, 'clientId');
    this.#clientId = this.#config.clientId ?? persisted ?? crypto.randomUUID();
    if (persisted !== this.#clientId) {
      setMeta(this.#db, 'clientId', this.#clientId);
    }
    // §7.3.5: restore the persisted lease so leaseState survives restart.
    const leaseJson = getMeta(this.#db, 'leaseState');
    if (leaseJson !== undefined) {
      this.#leaseState = JSON.parse(leaseJson) as LeaseState;
    }
    this.#started = true;
  }

  async close(): Promise<void> {
    this.#socket?.close();
    this.#socket = undefined;
    this.#abortPendingRound('client closed mid-round');
    await this.#lease?.release();
    this.#lease = undefined;
    this.#started = false;
  }

  // -- accessors ------------------------------------------------------------

  get clientId(): string {
    return this.#clientId;
  }

  /** The underlying database — raw SQL is the local query API (B3). */
  get database(): ClientDatabase {
    return this.#db;
  }

  query(sql: string, params?: readonly SqlValue[]): SqlRow[] {
    return this.#db.query(sql, params);
  }

  // -- blobs (§5.9) ---------------------------------------------------------

  /**
   * Stage a blob for attachment (§5.9.7): hash the bytes into the content
   * address, cache them locally, and queue the upload (flushed before the
   * next push — B4). Returns the canonical `BlobRef` **string** to store in
   * a `blob_ref` column of a mutation. The referencing row MUST be written
   * (via `mutate`) after this call so upload-before-push holds (§5.9.3).
   */
  async uploadBlob(
    bytes: Uint8Array,
    options?: { readonly mediaType?: string; readonly name?: string },
  ): Promise<BlobRef> {
    if (this.#config.blobs === undefined) {
      throw new ClientSyncError(
        'sync.invalid_request',
        'uploadBlob requires a blob transport (SyncClientConfig.blobs, §5.9)',
      );
    }
    const blobId = await computeBlobId(bytes);
    this.#db.transaction(() => {
      putCachedBlob(this.#db, blobId, bytes, this.#now(), options?.mediaType);
      recordPendingUpload(this.#db, blobId, this.#now(), options?.mediaType);
    });
    return {
      blobId,
      byteLength: bytes.length,
      ...(options?.mediaType !== undefined
        ? { mediaType: options.mediaType }
        : {}),
      ...(options?.name !== undefined ? { name: options.name } : {}),
    };
  }

  /** Serialize a BlobRef to the canonical string a `blob_ref` column holds. */
  blobRefString(ref: BlobRef): string {
    return serializeBlobRef(ref);
  }

  /**
   * Resolve blob bytes for a `blobId` (§5.9.7): a content-addressed cache
   * hit serves without a network fetch (B1); a miss downloads via the blob
   * transport (§5.9.5), verifies the content address, caches, and returns.
   * Accepts a raw `blob_ref` column string or a bare `blobId`.
   */
  async fetchBlob(blobIdOrRef: string): Promise<CachedBlob> {
    const blobId = blobIdOrRef.startsWith('sha256:')
      ? blobIdOrRef
      : parseBlobRef(blobIdOrRef).blobId;
    const cached = getCachedBlob(this.#db, blobId);
    if (cached !== undefined) return cached;
    if (this.#config.blobs === undefined) {
      throw new ClientSyncError(
        'sync.invalid_request',
        'fetchBlob requires a blob transport (SyncClientConfig.blobs, §5.9)',
      );
    }
    const bytes = await this.#config.blobs.download(blobId);
    const computed = await computeBlobId(bytes);
    if (computed !== blobId) {
      // §5.9.5 inherits §5.1: verify the content address, reject on mismatch.
      throw new ClientSyncError(
        'sync.invalid_request',
        `blob content address mismatch for ${blobId} (§5.9.5)`,
      );
    }
    putCachedBlob(this.#db, blobId, bytes, this.#now());
    const stored = getCachedBlob(this.#db, blobId);
    if (stored === undefined) {
      throw new ClientSyncError(
        'sync.invalid_request',
        'blob cache write failed',
      );
    }
    return stored;
  }

  /** Flush any queued blob uploads (§5.9.7 B4); safe to call standalone. */
  async flushBlobUploads(): Promise<void> {
    const transport = this.#config.blobs;
    if (transport === undefined || !this.#hasBlobs) return;
    for (const pending of listPendingUploads(this.#db)) {
      const cached = getCachedBlob(this.#db, pending.blobId);
      if (cached === undefined) {
        // The bytes are gone (never happens for a well-behaved client);
        // drop the upload so it does not wedge the queue.
        clearPendingUpload(this.#db, pending.blobId);
        continue;
      }
      await transport.upload(pending.blobId, cached.bytes, pending.mediaType);
      clearPendingUpload(this.#db, pending.blobId);
    }
  }

  get conflicts(): readonly ConflictRecord[] {
    return this.#conflicts;
  }

  get rejections(): readonly RejectionRecord[] {
    return this.#rejections;
  }

  /** Non-undefined once the server declared a schema floor (§1.6). */
  get schemaFloor(): SchemaFloor | undefined {
    return this.#schemaFloor;
  }

  /**
   * §7.3.5: the current auth-lease state (opaque). Undefined until a
   * `LEASE` frame arrives. `errorCode` is set when a round was rejected
   * with a request-level lease code — syncing on the lease has stopped.
   */
  get leaseState(): LeaseState | undefined {
    return this.#leaseState;
  }

  /** §7.3.5: remaining lease validity in ms (`expiresAtMs − now`), or
   * `undefined` if no lease is held. Negative once expired. */
  leaseRemainingMs(now: number = this.#now()): number | undefined {
    const expiresAtMs = this.#leaseState?.expiresAtMs;
    return expiresAtMs === undefined ? undefined : expiresAtMs - now;
  }

  /** True when syncing is stopped pending a client upgrade. */
  get stopped(): boolean {
    return this.#schemaFloor !== undefined;
  }

  /** §8: a hello/wake-up asked for a pull that has not run yet. */
  get syncNeeded(): boolean {
    return this.#needsPull;
  }

  /**
   * §4.2 accept mask: the configured override, or the rows baseline plus
   * bit 2 when the backend can import sqlite images (§5.3) and a segment
   * downloader exists (sqlite segments are never inline, §5.7), plus
   * bit 3 when the downloader exposes a direct URL fetch (§5.4
   * capability negotiation).
   */
  #acceptMask(): number {
    const configured = this.#config.limits?.accept;
    if (configured !== undefined) return configured;
    const segments = this.#config.segments;
    const sqliteCapable =
      typeof this.#db.withSqliteImage === 'function' && segments !== undefined;
    const urlCapable = typeof segments?.fetchUrl === 'function';
    return (
      ACCEPT_ROWS_BASELINE |
      (sqliteCapable ? ACCEPT_SQLITE : 0) |
      (urlCapable ? ACCEPT_SIGNED_URLS : 0)
    );
  }

  subscriptions(): SubscriptionRecord[] {
    this.#requireStarted();
    return loadSubscriptions(this.#db);
  }

  subscription(id: string): SubscriptionRecord | undefined {
    this.#requireStarted();
    return getSubscription(this.#db, id);
  }

  pendingCommits(): OutboxCommit[] {
    this.#requireStarted();
    return listOutbox(this.#db);
  }

  // -- subscriptions ----------------------------------------------------------

  subscribe(input: SubscribeInput): void {
    this.#requireStarted();
    if (!this.#schema.tables.has(input.table)) {
      throw new ClientSyncError(
        'sync.unknown_table',
        `subscribe: unknown local table ${JSON.stringify(input.table)}`,
      );
    }
    const existing = getSubscription(this.#db, input.id);
    if (existing !== undefined) {
      saveSubscription(this.#db, {
        ...existing,
        table: input.table,
        scopes: input.scopes,
        ...(input.params !== undefined ? { params: input.params } : {}),
      });
      return;
    }
    saveSubscription(this.#db, {
      id: input.id,
      table: input.table,
      scopes: input.scopes,
      ...(input.params !== undefined ? { params: input.params } : {}),
      cursor: -1,
      status: 'active',
    });
  }

  unsubscribe(id: string): void {
    this.#requireStarted();
    deleteSubscription(this.#db, id);
  }

  // -- local mutations --------------------------------------------------------

  /**
   * Record one atomic local commit (§7.1): appended to the outbox in
   * schema-agnostic form and applied optimistically to the local mirror.
   * Returns the generated `clientCommitId`.
   */
  mutate(mutations: readonly MutationInput[]): string {
    this.#requireStarted();
    const clientCommitId = crypto.randomUUID();
    const operations: OutboxOperation[] = mutations.map((mutation) => {
      const table = this.#table(mutation.table);
      if (mutation.op === 'delete') {
        return {
          table: mutation.table,
          rowId: mutation.rowId,
          op: 'delete',
          ...(mutation.baseVersion !== undefined
            ? { baseVersion: mutation.baseVersion }
            : {}),
        };
      }
      const values = recordToRowValues(table, mutation.values);
      const pkValue = values[table.primaryKeyIndex];
      if (typeof pkValue !== 'string' || pkValue.length === 0) {
        throw new ClientSyncError(
          'sync.invalid_request',
          `table ${table.name}: upsert requires a non-empty string primary key`,
        );
      }
      const json: Record<string, ReturnType<typeof rowValueToJson>> = {};
      table.columns.forEach((column, index) => {
        json[column.name] = rowValueToJson(values[index] ?? null);
      });
      return {
        table: mutation.table,
        rowId: pkValue,
        op: 'upsert',
        ...(mutation.baseVersion !== undefined
          ? { baseVersion: mutation.baseVersion }
          : {}),
        values: json,
      };
    });
    this.#db.transaction(() => {
      appendOutboxCommit(this.#db, clientCommitId, operations, this.#now());
      this.#applyOperationsLocally(operations);
    });
    return clientCommitId;
  }

  // -- lease state (§7.3.5) ---------------------------------------------------

  /** Merge and persist the lease state (opaque, §7.3.5). */
  #setLeaseState(next: LeaseState): void {
    this.#leaseState = next;
    setMeta(this.#db, 'leaseState', JSON.stringify(next));
  }

  /** The request-level lease error codes (§7.3.4): stop-and-surface. */
  #isLeaseErrorCode(code: string): boolean {
    return (
      code === 'sync.auth_lease_required' || code === 'sync.auth_lease_revoked'
    );
  }

  // -- sync -------------------------------------------------------------------

  /** One combined push+pull round (§1.5, §7.2). */
  async sync(): Promise<SyncSummary> {
    this.#requireStarted();
    if (this.#syncing) {
      throw new ClientSyncError(
        'sync.invalid_request',
        'sync() is already running — the core owns one loop (coalesce wake-ups)',
      );
    }
    if (this.#schemaFloor !== undefined) {
      return {
        ...emptySummary(0),
        bootstrapping: [],
        schemaFloor: this.#schemaFloor,
      };
    }
    this.#syncing = true;
    // Cleared before the round, not after: a wake-up (or a delta dropped
    // because this pull is mid-flight) that lands during the round must
    // survive it — the reference server keeps no replay buffer (§8.2).
    this.#needsPull = false;
    try {
      // §5.9.7 B4: upload pending blobs BEFORE pushing rows that reference
      // them, so the server-side existence check (§6.6) passes.
      if (this.#hasBlobs && this.#config.blobs !== undefined) {
        await this.flushBlobUploads();
      }
      const outbox = listOutbox(this.#db);
      const subs = loadSubscriptions(this.#db).filter(
        (sub) => sub.status === 'active',
      );
      const limits = this.#config.limits;
      const frames: RequestFrame[] = [
        {
          type: 'REQ_HEADER',
          clientId: this.#clientId,
          schemaVersion: this.#schema.version,
        },
        ...outbox.map((commit) => encodeOutboxCommit(this.#schema, commit)),
        {
          type: 'PULL_HEADER',
          limitCommits: limits?.limitCommits ?? 0,
          limitSnapshotRows: limits?.limitSnapshotRows ?? 0,
          maxSnapshotPages: limits?.maxSnapshotPages ?? 0,
          accept: this.#acceptMask(),
        },
        ...subs.map(
          (sub): RequestFrame => ({
            type: 'SUBSCRIPTION',
            id: sub.id,
            table: sub.table,
            scopes: sub.scopes,
            ...(sub.params !== undefined ? { params: sub.params } : {}),
            cursor: sub.cursor,
            ...(sub.bootstrapState !== undefined
              ? { bootstrapState: sub.bootstrapState }
              : {}),
          }),
        ),
      ];
      const requestBytes = encodeMessage({
        wireVersion: PROTOCOL_WIRE_VERSION,
        msgKind: 'request',
        frames,
      });
      const responseBytes = await this.#roundTrip(requestBytes);
      const message = decodeMessage(responseBytes);
      if (message.msgKind !== 'response') {
        throw new ClientSyncError(
          'sync.invalid_request',
          'transport returned a non-response message',
        );
      }
      return await this.#processResponse(message, outbox, subs, 'pull');
    } catch (error) {
      // §7.3.5: a request-level lease code stops-and-surfaces — record it
      // in leaseState (no local-data purge, §7.3.4) and re-throw. Not a
      // silent retry: the app drives recovery to a live resolver. The
      // error may arrive as a ClientSyncError or as a transport error
      // carrying the server's `.code` (HTTP-JSON / loopback surface, §1.1).
      const code = (error as { code?: unknown }).code;
      if (typeof code === 'string' && this.#isLeaseErrorCode(code)) {
        this.#setLeaseState({
          ...(this.#leaseState ?? {}),
          errorCode: code,
        });
      }
      throw error;
    } finally {
      this.#syncing = false;
    }
  }

  /**
   * Pull repeatedly until quiescent: no commits delivered, no bootstrap
   * pages pending, no resets to recover (§4.5 "pull again" SHOULD).
   */
  async syncUntilIdle(maxRounds = 20): Promise<SyncSummary> {
    let last: SyncSummary | undefined;
    for (let round = 0; round < maxRounds; round++) {
      last = await this.sync();
      if (last.schemaFloor !== undefined) return last;
      if (
        last.commitsApplied === 0 &&
        last.segmentRowsApplied === 0 &&
        last.bootstrapping.length === 0 &&
        last.resets.length === 0
      ) {
        return last;
      }
    }
    throw new ClientSyncError(
      'sync.invalid_request',
      `sync did not reach idle within ${maxRounds} rounds`,
    );
  }

  /**
   * One request/response round trip (§8.7): over the socket whenever it
   * is connected (Direction decision 1 — the socket IS the sync-round
   * transport, not a fallback pair), otherwise through the configured
   * `SyncTransport` seam (loopback/conformance hosts, HTTP-only
   * producers).
   */
  #roundTrip(request: Uint8Array): Promise<Uint8Array> {
    const socket = this.#socket;
    if (socket === undefined) return this.#config.transport(request);
    return new Promise<Uint8Array>((resolve, reject) => {
      // sync() already enforces one round in flight (§8.7).
      this.#pendingRound = {
        scanner: new MessageStreamScanner(),
        resolve,
        reject,
      };
      const tagged = new Uint8Array(request.length + 1);
      tagged[0] = REALTIME_TAG_ROUND;
      tagged.set(request, 1);
      try {
        socket.sendBytes(tagged);
      } catch (error) {
        this.#pendingRound = undefined;
        reject(
          new ClientSyncError(
            'sync.transport_failed',
            `socket round send failed: ${error instanceof Error ? error.message : String(error)}`,
            true,
          ),
        );
      }
    });
  }

  /** Abort the in-flight socket round (socket closed or disconnected). */
  #abortPendingRound(reason: string): void {
    const round = this.#pendingRound;
    if (round === undefined) return;
    this.#pendingRound = undefined;
    round.reject(new ClientSyncError('sync.transport_failed', reason, true));
  }

  // -- realtime (§8 client side) ----------------------------------------------

  async connectRealtime(): Promise<void> {
    this.#requireStarted();
    const connector = this.#config.realtime;
    if (connector === undefined) {
      throw new ClientSyncError(
        'sync.invalid_request',
        'no realtime connector configured',
      );
    }
    this.#socket = await connector({
      onText: (text) => this.#handleRealtimeText(text),
      onBinary: (bytes) => this.#routeRealtimeBinary(bytes),
      onClose: () => {
        this.#socket = undefined;
        this.#abortPendingRound('realtime socket closed mid-round (§8.7)');
      },
    });
  }

  disconnectRealtime(): void {
    this.#socket?.close();
    this.#socket = undefined;
    this.#abortPendingRound('realtime socket disconnected mid-round (§8.7)');
  }

  /**
   * §8.7 channel-tag routing (synchronous, so chunk order is preserved):
   * `0x01` chunks feed the in-flight round's assembler; `0x00` messages
   * are standalone deltas; unknown tags are ignored (forward compat).
   */
  #routeRealtimeBinary(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    const tag = bytes[0];
    const body = bytes.subarray(1);
    if (tag === REALTIME_TAG_ROUND) {
      const round = this.#pendingRound;
      if (round === undefined) return; // stale chunk after an abort
      let done: ReturnType<MessageStreamScanner['push']>;
      try {
        done = round.scanner.push(body);
      } catch (error) {
        this.#pendingRound = undefined;
        round.reject(
          new ClientSyncError(
            'sync.invalid_request',
            `malformed round response stream (§8.7): ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        return;
      }
      if (done === undefined) return;
      this.#pendingRound = undefined;
      if (done.excess > 0) {
        round.reject(
          new ClientSyncError(
            'sync.invalid_request',
            'response bytes past END of the round stream (§8.7)',
          ),
        );
        return;
      }
      round.resolve(done.message.slice());
      return;
    }
    if (tag === REALTIME_TAG_DELTA) {
      void this.#handleRealtimeBinary(body);
    }
    // Unknown tag: tolerated and ignored (§8.7 closed registry).
  }

  #handleRealtimeText(text: string): void {
    let parsed: ReturnType<typeof parseRealtimeServerEvent>;
    try {
      parsed = parseRealtimeServerEvent(text);
    } catch {
      return; // §8.1: tolerate garbled/unknown control messages
    }
    if (!parsed.known) return;
    const event = parsed.event;
    if (event.event === 'hello') {
      if (event.data.requiresSync) {
        this.#needsPull = true;
        this.#config.onSyncNeeded?.('hello');
      }
      return;
    }
    if (event.event === 'sync') {
      // §8.3: any wake-up means "run a pull soon", never data.
      this.#needsPull = true;
      this.#config.onSyncNeeded?.(event.data.reason);
    }
  }

  async #handleRealtimeBinary(bytes: Uint8Array): Promise<void> {
    if (this.#syncing) {
      // A pull is mid-flight; let it win and recover the gap itself —
      // re-pulling is idempotent, interleaved application is not worth it.
      this.#needsPull = true;
      return;
    }
    try {
      const message = decodeMessage(bytes);
      if (message.msgKind !== 'response') return;
      // §8.2: deltas apply like pull responses; ack after apply.
      await this.#processResponse(message, [], undefined, 'delta');
    } catch {
      // A delta that cannot be applied is recovered by a pull (§8.3).
      this.#needsPull = true;
      this.#config.onSyncNeeded?.('catchup-required');
    }
  }

  #sendAck(cursor: number): void {
    this.#socket?.send(JSON.stringify({ type: 'ack', cursor }));
  }

  /** Ack the highest cursor that is contiguously applied for every sub. */
  #ackAfterPull(): void {
    if (this.#socket === undefined) return;
    const cursors = loadSubscriptions(this.#db)
      .filter(
        (sub) => sub.status === 'active' && sub.bootstrapState === undefined,
      )
      .map((sub) => sub.cursor)
      .filter((cursor) => cursor >= 0);
    if (cursors.length === 0) return;
    this.#sendAck(Math.min(...cursors));
  }

  // -- response processing ------------------------------------------------------

  async #processResponse(
    message: ResponseMessage,
    sentCommits: readonly OutboxCommit[],
    sentSubs: readonly SubscriptionRecord[] | undefined,
    mode: 'pull' | 'delta',
  ): Promise<SyncSummary> {
    const summary = emptySummary(sentCommits.length);
    const commitsById = new Map(
      sentCommits.map((commit) => [commit.clientCommitId, commit]),
    );
    const subsById = new Map(
      (sentSubs ?? loadSubscriptions(this.#db)).map((sub) => [sub.id, sub]),
    );

    const header = message.frames[0];
    if (header?.type !== 'RESP_HEADER') {
      throw new ClientSyncError('sync.invalid_request', 'missing RESP_HEADER');
    }
    if (header.requiredSchemaVersion !== undefined) {
      // §1.6 schema floor: nothing else was processed — stop syncing and
      // surface the upgrade requirement.
      this.#schemaFloor = {
        requiredSchemaVersion: header.requiredSchemaVersion,
        ...(header.latestSchemaVersion !== undefined
          ? { latestSchemaVersion: header.latestSchemaVersion }
          : {}),
      };
      return {
        ...summary,
        bootstrapping: [],
        schemaFloor: this.#schemaFloor,
      };
    }

    let section: OpenSection | undefined;
    let errorFrame: ClientSyncError | undefined;
    let deltaCursor = -1;

    try {
      for (const frame of message.frames.slice(1)) {
        switch (frame.type) {
          case 'RESP_HEADER':
            break;
          case 'LEASE':
            // §7.3.5: persist the opaque lease and clear any prior lease
            // error — a fresh lease means the outage/revocation is over.
            this.#setLeaseState({
              leaseId: frame.leaseId,
              expiresAtMs: frame.expiresAtMs,
            });
            break;
          case 'PUSH_RESULT':
            this.#handlePushResult(frame, commitsById, summary);
            break;
          case 'SUB_START': {
            const sub = subsById.get(frame.id);
            const fresh =
              sub !== undefined &&
              sub.cursor < 0 &&
              sub.bootstrapState === undefined &&
              frame.bootstrap;
            const skip =
              sub === undefined ||
              (mode === 'delta' &&
                (sub.status !== 'active' || sub.bootstrapState !== undefined));
            section = { start: frame, sub, fresh, skip, cleared: false };
            break;
          }
          case 'COMMIT':
            if (section !== undefined && !section.skip) {
              this.#applyCommit(frame, summary);
            }
            break;
          case 'SEGMENT_INLINE': {
            if (
              section === undefined ||
              section.skip ||
              section.sub === undefined
            ) {
              break;
            }
            const segment = decodeRowsSegment(frame.payload);
            this.#applySegmentOrFail(
              section,
              summary,
              (table, clearFirst, effective) =>
                applyRowsSegment(this.#db, this.#schema, table, segment, {
                  clearFirst,
                  effective,
                }),
              section.fresh && !section.cleared,
            );
            break;
          }
          case 'SEGMENT_REF': {
            if (
              section === undefined ||
              section.skip ||
              section.sub === undefined
            ) {
              break;
            }
            // §4.2: a descriptor whose mediaType was not advertised is a
            // broken server — fail loud, never skip or guess.
            if (
              frame.mediaType === 'sqlite' &&
              (this.#acceptMask() & ACCEPT_SQLITE) === 0
            ) {
              throw new ClientSyncError(
                'sync.invalid_request',
                'SEGMENT_REF mediaType sqlite was not advertised in accept (§4.2)',
              );
            }
            const bytes = await this.#downloadSegment(frame, section.sub);
            if (frame.mediaType === 'sqlite') {
              // §5.3: images are whole-table — a paged descriptor is
              // invalid, and the image is always its table's first page.
              if (
                frame.rowCursor !== undefined ||
                frame.nextRowCursor !== undefined
              ) {
                throw new ClientSyncError(
                  'sync.invalid_request',
                  'sqlite segments are whole-table: rowCursor/nextRowCursor must be absent (§5.3)',
                );
              }
              this.#applySegmentOrFail(
                section,
                summary,
                (table, clearFirst, effective) =>
                  applySqliteSegment(
                    this.#db,
                    this.#schema,
                    table,
                    bytes,
                    {
                      table: frame.table,
                      rowCount: frame.rowCount,
                      asOfCommitSeq: frame.asOfCommitSeq,
                      scopeDigest: frame.scopeDigest,
                    },
                    { clearFirst, effective },
                  ),
                section.fresh && !section.cleared,
              );
            } else {
              const segment = decodeRowsSegment(bytes);
              this.#applySegmentOrFail(
                section,
                summary,
                (table, clearFirst, effective) =>
                  applyRowsSegment(this.#db, this.#schema, table, segment, {
                    clearFirst,
                    effective,
                  }),
                section.fresh &&
                  !section.cleared &&
                  frame.rowCursor === undefined,
              );
            }
            break;
          }
          case 'SUB_END': {
            if (
              section !== undefined &&
              !section.skip &&
              section.sub !== undefined
            ) {
              const applied = this.#finishSection(
                section.sub,
                section.start,
                frame.nextCursor,
                frame.bootstrapState,
                summary,
              );
              if (mode === 'delta' && applied) {
                deltaCursor = Math.max(deltaCursor, frame.nextCursor);
              }
            }
            section = undefined;
            break;
          }
          case 'ERROR':
            // §1.4 rule 5 / §1.6: the request failed; the open
            // subscription's SUB_END values are never persisted.
            errorFrame = new ClientSyncError(
              frame.code,
              frame.message,
              frame.retryable,
            );
            section = undefined;
            break;
          case 'UNKNOWN':
            break; // §1.2 rule 2: skipped, never interpreted
        }
        if (errorFrame !== undefined) break;
      }
    } finally {
      // §7.1: local reads see outbox state applied optimistically — replay
      // the still-pending commits on top of the freshly applied server
      // state (the simple reconciliation mandated for B3).
      this.#replayOutbox();
      // §5.9.7 B1: after every apply/replay, refcounts follow the live rows.
      // A benign apply retains zero-ref bodies (LRU default); the revocation
      // purge below deletes orphaned bodies with deleteOrphans (B2).
      this.#reconcileBlobs(false);
    }

    if (errorFrame !== undefined) throw errorFrame;

    if (mode === 'delta') {
      if (deltaCursor >= 0) this.#sendAck(deltaCursor);
    } else {
      this.#ackAfterPull();
    }

    const bootstrapping = loadSubscriptions(this.#db)
      .filter(
        (sub) => sub.status === 'active' && sub.bootstrapState !== undefined,
      )
      .map((sub) => sub.id);
    return { ...summary, bootstrapping };
  }

  #handlePushResult(
    frame: PushResultFrame,
    commitsById: ReadonlyMap<string, OutboxCommit>,
    summary: MutableSummary,
  ): void {
    const commit = commitsById.get(frame.clientCommitId);
    if (commit === undefined) return;
    if (frame.status === 'applied' || frame.status === 'cached') {
      // §6.3: applied and cached both drain the outbox — cached means
      // "already applied, you may have missed the ack".
      deleteOutboxCommit(this.#db, frame.clientCommitId);
      summary.applied.push(frame.clientCommitId);
      return;
    }
    // rejected
    const cacheMiss = frame.results.some(
      (result) =>
        result.status === 'error' &&
        result.code === 'sync.idempotency_cache_miss' &&
        result.retryable,
    );
    if (cacheMiss) {
      // §6.3: a serving failure, not the commit's outcome — keep the
      // commit queued and retry the identical push later.
      summary.retryable.push(frame.clientCommitId);
      return;
    }
    for (const result of frame.results) {
      const operation = commit.operations[result.opIndex];
      if (result.status === 'conflict') {
        const conflict: ConflictRecord = {
          clientCommitId: frame.clientCommitId,
          opIndex: result.opIndex,
          table: operation?.table ?? '',
          rowId: operation?.rowId ?? '',
          code: result.code,
          message: result.message,
          serverVersion: result.serverVersion,
          serverRow: this.#decodeServerRow(operation?.table, result.serverRow),
          ...(operation !== undefined ? { operation } : {}),
        };
        this.#conflicts.push(conflict);
        summary.conflicts.push(conflict);
        this.#config.onConflict?.(conflict);
      } else if (result.status === 'error') {
        this.#rejections.push({
          clientCommitId: frame.clientCommitId,
          opIndex: result.opIndex,
          code: result.code,
          message: result.message,
          retryable: result.retryable,
          ...(operation !== undefined ? { operation } : {}),
        });
      }
    }
    // §7.2: stop optimistic display and decide about dependents — the
    // commit leaves the outbox; rows it created that the server never
    // confirmed are undone here, rows it overwrote reconcile via the pull
    // half (the conflict record carries the server row for the app).
    this.#db.transaction(() => {
      deleteOutboxCommit(this.#db, frame.clientCommitId);
      for (const operation of commit.operations) {
        if (operation.op !== 'upsert') continue;
        const table = this.#schema.tables.get(operation.table);
        if (table === undefined) continue;
        const row = this.#db.query(
          `SELECT ${quoteIdent(SYNC_VERSION_COLUMN)} AS v FROM ${quoteIdent(table.name)} WHERE ${quoteIdent(table.primaryKey)} = ?`,
          [operation.rowId],
        )[0];
        if (row !== undefined && row.v === OPTIMISTIC_VERSION) {
          deleteLocalRow(this.#db, table, operation.rowId);
        }
      }
    });
    summary.rejected.push(frame.clientCommitId);
  }

  #decodeServerRow(
    tableName: string | undefined,
    payload: Uint8Array,
  ): Record<string, RowValue> {
    if (tableName === undefined) return {};
    const table = this.#schema.tables.get(tableName);
    if (table === undefined) return {};
    const values = decodeRow(table.columns, payload);
    const record: Record<string, RowValue> = {};
    table.columns.forEach((column, index) => {
      record[column.name] = values[index] ?? null;
    });
    return record;
  }

  #applyCommit(frame: CommitFrame, summary: MutableSummary): void {
    applyCommitFrame(this.#db, this.#schema, frame);
    summary.commitsApplied += 1;
  }

  /**
   * Apply a segment (rows or sqlite image); a §5.6/§3.3 fail-closed error
   * (no local scope-column mapping) marks the subscription `failed` and
   * stops syncing the table without failing the whole request.
   */
  #applySegmentOrFail(
    section: OpenSection,
    summary: MutableSummary,
    apply: (
      table: CompiledClientTable,
      clearFirst: boolean,
      effective: ScopeMap,
    ) => number,
    clearFirst: boolean,
  ): void {
    const sub = section.sub;
    if (sub === undefined) return;
    const table = this.#table(sub.table);
    try {
      summary.segmentRowsApplied += apply(
        table,
        clearFirst,
        section.start.effectiveScopes,
      );
      section.cleared = true;
    } catch (error) {
      if (
        error instanceof ClientSyncError &&
        error.code === 'sync.scope_revoked'
      ) {
        saveSubscription(this.#db, {
          id: sub.id,
          table: sub.table,
          scopes: sub.scopes,
          ...(sub.params !== undefined ? { params: sub.params } : {}),
          cursor: sub.cursor,
          ...(sub.effectiveScopes !== undefined
            ? { effectiveScopes: sub.effectiveScopes }
            : {}),
          status: 'failed',
          reasonCode: 'sync.scope_revoked',
        });
        summary.failed.push(sub.id);
        section.skip = true;
        return;
      }
      throw error;
    }
  }

  async #downloadSegment(
    frame: SegmentRefFrame,
    sub: SubscriptionRecord,
  ): Promise<Uint8Array> {
    const downloader = this.#config.segments;
    if (downloader === undefined) {
      throw new ClientSyncError(
        'sync.invalid_request',
        'received SEGMENT_REF but no segment downloader is configured',
      );
    }
    let bytes: Uint8Array;
    if (frame.url !== undefined) {
      // §5.4: a url-carrying descriptor MUST be fetched from that URL —
      // no fall-through to the direct endpoint; any failure invalidates
      // the descriptor and re-pulling recovers (§1.4 rule 5 keeps the
      // cursor/resume token unpersisted).
      const fetchUrl = downloader.fetchUrl;
      if (
        fetchUrl === undefined ||
        (this.#acceptMask() & ACCEPT_SIGNED_URLS) === 0
      ) {
        throw new ClientSyncError(
          'sync.invalid_request',
          'SEGMENT_REF carries a url but accept bit 3 was not advertised (§5.4)',
        );
      }
      if (
        frame.urlExpiresAtMs !== undefined &&
        frame.urlExpiresAtMs <= this.#now()
      ) {
        // §5.4: MUST NOT start a fetch at/past expiry.
        throw new ClientSyncError(
          'sync.segment_expired',
          `signed URL for segment ${frame.segmentId} expired before fetch — re-pull mints fresh descriptors (§5.4)`,
          true,
        );
      }
      bytes = await fetchUrl(frame.url);
    } else {
      bytes = await downloader({
        segmentId: frame.segmentId,
        table: frame.table,
        requestedScopesJson: canonicalScopeJson(sub.scopes),
      });
    }
    // §5.1: verify the content address before applying; on mismatch the
    // segment is discarded and the cursor/resume token stay unpersisted,
    // so the next pull re-delivers.
    const hash = await sha256Hex(bytes);
    if (`sha256:${hash}` !== frame.segmentId) {
      throw new ClientSyncError(
        'sync.invalid_request',
        `segment ${frame.segmentId} failed content-address verification (§5.1)`,
        true,
      );
    }
    return bytes;
  }

  /** Returns whether SUB_END state was persisted (section applied). */
  #finishSection(
    sub: SubscriptionRecord,
    start: SubStartFrame,
    nextCursor: number,
    bootstrapState: string | undefined,
    summary: MutableSummary,
  ): boolean {
    if (start.status === 'active') {
      // §1.4 rule 4: durable cursor/resume state persists only at SUB_END;
      // §3.3: the effective-scope echo is persisted for the purge contract.
      // An absent bootstrapState clears any previous resume token (§4.4:
      // absent = bootstrap complete, or not bootstrapping).
      saveSubscription(this.#db, {
        id: sub.id,
        table: sub.table,
        scopes: sub.scopes,
        ...(sub.params !== undefined ? { params: sub.params } : {}),
        cursor: nextCursor,
        ...(bootstrapState !== undefined ? { bootstrapState } : {}),
        effectiveScopes: start.effectiveScopes,
        status: 'active',
      });
      return true;
    }

    if (start.status === 'reset') {
      // §4.6: discard cursor + resume token, keep local rows, re-bootstrap
      // with cursor = -1 on the next pull. Staleness, not a purge.
      saveSubscription(this.#db, {
        id: sub.id,
        table: sub.table,
        scopes: sub.scopes,
        ...(sub.params !== undefined ? { params: sub.params } : {}),
        cursor: -1,
        ...(sub.effectiveScopes !== undefined
          ? { effectiveScopes: sub.effectiveScopes }
          : {}),
        status: 'active',
        reasonCode: start.reasonCode,
      });
      summary.resets.push(sub.id);
      return false;
    }

    // revoked (§3.3): purge rows matching the LAST-echoed effective scopes
    // (never the requested map), drop doomed outbox commits, stop pulling.
    const table = this.#table(sub.table);
    const lastEffective = sub.effectiveScopes;
    let failed = false;
    if (lastEffective !== undefined && Object.keys(lastEffective).length > 0) {
      try {
        this.#db.transaction(() => {
          deleteScopedRows(this.#db, table, lastEffective);
        });
        dropOutboxCommitsInScope(this.#db, table, lastEffective);
        // §5.9.7 B2: revocation deletes now-unauthorized blob bodies —
        // reconcile with deleteOrphans (evicted ≠ revoked).
        this.#reconcileBlobs(true);
      } catch (error) {
        if (
          error instanceof ClientSyncError &&
          error.code === 'sync.scope_revoked'
        ) {
          // Fail closed: no local mapping — surface a fatal configuration
          // error and stop syncing the table without clearing anything.
          failed = true;
        } else {
          throw error;
        }
      }
    }
    saveSubscription(this.#db, {
      id: sub.id,
      table: sub.table,
      scopes: sub.scopes,
      ...(sub.params !== undefined ? { params: sub.params } : {}),
      cursor: nextCursor,
      ...(lastEffective !== undefined
        ? { effectiveScopes: lastEffective }
        : {}),
      status: failed ? 'failed' : 'revoked',
      reasonCode: start.reasonCode,
    });
    summary.revoked.push(sub.id);
    if (failed) summary.failed.push(sub.id);
    return false;
  }

  // -- optimistic state ----------------------------------------------------------

  #applyOperationsLocally(operations: readonly OutboxOperation[]): void {
    for (const op of operations) {
      const table = this.#table(op.table);
      if (op.op === 'delete') {
        deleteLocalRow(this.#db, table, op.rowId);
        continue;
      }
      const values = table.columns.map((column) => {
        const value = op.values?.[column.name];
        return value === undefined ? null : jsonToRowValue(value);
      });
      const existing = this.#db.query(
        `SELECT ${quoteIdent(SYNC_VERSION_COLUMN)} AS v FROM ${quoteIdent(table.name)} WHERE ${quoteIdent(table.primaryKey)} = ?`,
        [op.rowId],
      )[0];
      const version =
        existing === undefined ? OPTIMISTIC_VERSION : (existing.v as number);
      upsertLocalRow(this.#db, table, values, version);
    }
  }

  /** Re-apply every pending outbox commit on top of server state (§7.1). */
  #replayOutbox(): void {
    const pending = listOutbox(this.#db);
    if (pending.length === 0) return;
    this.#db.transaction(() => {
      for (const commit of pending) {
        this.#applyOperationsLocally(commit.operations);
      }
    });
  }

  /**
   * §5.9.7 B1/B2: recompute blob-cache refcounts from live `blob_ref`
   * columns. No-op unless the schema has blob columns. `deleteOrphans`
   * triggers the revocation-side body deletion (B2).
   */
  #reconcileBlobs(deleteOrphans: boolean): void {
    if (!this.#hasBlobs) return;
    reconcileBlobRefcounts(this.#db, this.#schema, { deleteOrphans });
  }

  // -- helpers -----------------------------------------------------------------

  #table(name: string): CompiledClientTable {
    const table = this.#schema.tables.get(name);
    if (table === undefined) {
      throw new ClientSyncError(
        'sync.unknown_table',
        `unknown local table ${JSON.stringify(name)}`,
      );
    }
    return table;
  }

  #requireStarted(): void {
    if (!this.#started) {
      throw new ClientSyncError(
        'sync.invalid_request',
        'SyncClient.start() has not completed',
      );
    }
  }
}
