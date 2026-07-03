/**
 * Driver interfaces (REVISE B4): the implementation-agnostic seam between
 * the scenario catalog and any (client, server) pairing.
 *
 * Design rule: NOTHING TypeScript-specific crosses a driver boundary.
 * Every argument and return value is a primitive, a JSON-able value, or
 * raw bytes (`Uint8Array`). All methods are async. A future Rust core
 * implements these behind a subprocess or FFI shim by serializing exactly
 * these shapes; the only inversion is the client's transport endpoints
 * (bytes-in/bytes-out callbacks), which a shim proxies back over its pipe.
 */

// ---------------------------------------------------------------------------
// JSON-able values
// ---------------------------------------------------------------------------

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * A row value crossing the driver boundary. Bytes-typed columns travel as
 * `{ "$bytes": "<lowercase hex>" }`; every other column type is its
 * natural JSON form (`json`-typed columns stay raw strings, §2.4).
 */
export type DriverRowValue =
  | string
  | number
  | boolean
  | null
  | { readonly $bytes: string };

export type DriverRow = Readonly<Record<string, DriverRowValue>>;

/** Scope map (§3.2): variable → list of values. Always lists (§0). */
export type DriverScopeMap = Readonly<Record<string, readonly string[]>>;

// ---------------------------------------------------------------------------
// Schema IR (JSON-able, mirrors the §2.4 schema IR)
// ---------------------------------------------------------------------------

export type DriverColumnType =
  | 'string'
  | 'integer'
  | 'float'
  | 'boolean'
  | 'json'
  | 'bytes';

export interface DriverColumn {
  readonly name: string;
  readonly type: DriverColumnType;
  readonly nullable: boolean;
}

/** `'prefix:{variable}'`; `column` defaults to the variable name (§3.1). */
export interface DriverScopePattern {
  readonly pattern: string;
  readonly column?: string;
}

export interface DriverTable {
  readonly name: string;
  readonly columns: readonly DriverColumn[];
  readonly primaryKey: string;
  readonly scopes: readonly DriverScopePattern[];
}

export interface DriverSchema {
  readonly version: number;
  readonly tables: readonly DriverTable[];
}

// ---------------------------------------------------------------------------
// Shared result shapes
// ---------------------------------------------------------------------------

/** §10.1 error shape as JSON (categories fixed by the catalog). */
export interface DriverError {
  readonly code: string;
  readonly message: string;
  readonly category?: string;
  readonly retryable?: boolean;
  readonly recommendedAction?: string;
}

export type BytesResult =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly error: DriverError };

// ---------------------------------------------------------------------------
// ServerDriver
// ---------------------------------------------------------------------------

export interface ServerLimitsOptions {
  readonly maxOperationsPerRequest?: number;
  readonly inlineSegmentMaxBytes?: number;
  readonly maxDeltaBytes?: number;
  readonly segmentTtlMs?: number;
}

export interface ServerCreateOptions {
  readonly schema: DriverSchema;
  readonly partition: string;
  /** Virtual clock start, epoch ms. The clock only moves via advanceClock. */
  readonly nowMs: number;
  readonly limits?: ServerLimitsOptions;
}

export interface RetentionOptions {
  readonly activeWindowMs?: number;
  readonly ageForceMs?: number;
  readonly minRetainedCommits?: number;
}

/** Server-side row state for convergence assertions. */
export interface ServerRowState {
  readonly rowId: string;
  /** `server_version` (§2.2). */
  readonly version: number;
  readonly values: DriverRow;
  /** Stored scopes (§3.1): variable → single value. */
  readonly scopes: Readonly<Record<string, string>>;
}

/** The two socket directions, bytes/strings only (§8.1/§8.7). Binary
 * payloads are channel-tagged (§8.7): `0x00` = standalone delta message,
 * `0x01` = sync-round byte-stream chunk. */
export interface RealtimeSink {
  onText(text: string): void;
  onBinary(bytes: Uint8Array): void;
  /** Server-initiated close (§8.7 protocol violations). */
  onClose?(): void;
}

export interface RealtimeConnection {
  /** Client → server JSON control message (acks, §8.2). */
  send(text: string): void;
  /** Client → server tagged binary message (round chunks, §8.7). */
  sendBinary(bytes: Uint8Array): void;
  close(): void;
}

export type RealtimeConnectResult =
  | { readonly ok: true; readonly connection: RealtimeConnection }
  | { readonly ok: false; readonly error: DriverError };

/** Optional server capabilities a scenario may require. */
export type ServerCapability = 'idempotency-fault';

export interface ServerInstance {
  /**
   * §1.1 `<mount>/sync` — request bytes in, response bytes out, on behalf
   * of a host-authenticated actor. Request-level validation failures
   * (§1.7, the HTTP-JSON surface) return `{ ok: false }`.
   */
  handleSyncRequest(actorId: string, request: Uint8Array): Promise<BytesResult>;

  /** §5.5 direct segment download with re-authorization. */
  downloadSegment(
    actorId: string,
    segmentId: string,
    scopesHeaderJson: string,
  ): Promise<BytesResult>;

  /** §8.1 realtime attach for (actorId, clientId). */
  connectRealtime(
    actorId: string,
    clientId: string,
    sink: RealtimeSink,
  ): Promise<RealtimeConnectResult>;

  // -- host control ---------------------------------------------------------

  /** Set the actor's allowed scopes (§3.2 step 3). `'*'` = any value. */
  setAllowedScopes(actorId: string, allowed: DriverScopeMap): Promise<void>;
  /** Make `resolveScopes` throw for every actor (fail-loud paths). */
  setResolverFailing(failing: boolean): Promise<void>;

  advanceClock(ms: number): Promise<void>;
  nowMs(): Promise<number>;

  /** Run §4.6 pruning; returns the resulting horizonSeq. */
  prune(retention?: RetentionOptions): Promise<number>;

  // -- introspection (assertion surface) -------------------------------------

  getMaxCommitSeq(): Promise<number>;
  getHorizonSeq(): Promise<number>;
  /** All stored rows of a table, ordered by rowId. */
  readRows(table: string): Promise<ServerRowState[]>;

  // -- optional capabilities --------------------------------------------------

  /**
   * `idempotency-fault`: make the next idempotency lookup fail as an
   * unreadable record (§6.3 `sync.idempotency_cache_miss`).
   */
  failNextIdempotencyLookup?(): Promise<void>;

  close(): Promise<void>;
}

export interface ServerDriver {
  readonly name: string;
  readonly capabilities: readonly ServerCapability[];
  create(options: ServerCreateOptions): Promise<ServerInstance>;
}

// ---------------------------------------------------------------------------
// ClientDriver
// ---------------------------------------------------------------------------

/**
 * The transport seam handed TO the client by the harness. Fault injection
 * lives behind these endpoints — the client under test cannot tell a
 * loopback from a network. Bytes and strings only.
 */
export interface ClientEndpoints {
  /** One combined push+pull round trip. Rejects on transport faults and
   * on request-level server errors (§1.1 HTTP-JSON surface). */
  sync(request: Uint8Array): Promise<Uint8Array>;
  /** Segment fetch (§5.4 resolution order is the client's concern). */
  downloadSegment(request: {
    readonly segmentId: string;
    readonly table: string;
    readonly url?: string;
    readonly urlExpiresAtMs?: number;
    /** Canonical JSON (§11.2) of the requested scope map (§5.5). */
    readonly requestedScopesJson: string;
  }): Promise<Uint8Array>;
  /** Realtime attach; the harness observes both directions. */
  connectRealtime(sink: RealtimeSink): Promise<RealtimeConnection>;
}

export type ClientMutation =
  | {
      readonly op: 'upsert';
      readonly table: string;
      /** Full-row values keyed by column name (§6.1). */
      readonly values: DriverRow;
      readonly baseVersion?: number;
    }
  | {
      readonly op: 'delete';
      readonly table: string;
      readonly rowId: string;
      readonly baseVersion?: number;
    };

export interface ClientSyncReport {
  readonly pushed: number;
  readonly applied: readonly string[];
  readonly rejected: readonly string[];
  readonly retryable: readonly string[];
  readonly conflicts: number;
  readonly commitsApplied: number;
  readonly segmentRowsApplied: number;
  readonly bootstrapping: readonly string[];
  readonly resets: readonly string[];
  readonly revoked: readonly string[];
  readonly failed: readonly string[];
  readonly schemaFloor?: {
    readonly requiredSchemaVersion?: number;
    readonly latestSchemaVersion?: number;
  };
}

export type ClientSyncResult =
  | { readonly ok: true; readonly report: ClientSyncReport }
  | {
      readonly ok: false;
      readonly errorCode: string;
      readonly message: string;
    };

export interface ClientConflict {
  readonly clientCommitId: string;
  readonly opIndex: number;
  readonly table: string;
  readonly rowId: string;
  readonly code: string;
  readonly serverVersion: number;
  readonly serverRow: DriverRow;
}

export interface ClientRejection {
  readonly clientCommitId: string;
  readonly opIndex: number;
  readonly code: string;
  readonly retryable: boolean;
}

export interface ClientRowState {
  readonly rowId: string;
  /** Local synced version (`-1` = optimistic, not yet server-versioned). */
  readonly version: number;
  readonly values: DriverRow;
}

export interface ClientSubscriptionState {
  readonly id: string;
  readonly table: string;
  readonly status: 'active' | 'revoked' | 'failed';
  readonly cursor: number;
  readonly hasResumeToken: boolean;
  readonly effectiveScopes?: DriverScopeMap;
  readonly reasonCode?: string;
}

export interface ClientLimitsOptions {
  readonly limitCommits?: number;
  readonly limitSnapshotRows?: number;
  readonly maxSnapshotPages?: number;
  /** §4.2 accept bitmask. */
  readonly accept?: number;
}

export interface ClientCreateOptions {
  readonly clientId: string;
  readonly schema: DriverSchema;
  readonly endpoints: ClientEndpoints;
  readonly limits?: ClientLimitsOptions;
}

export interface ClientInstance {
  subscribe(input: {
    readonly id: string;
    readonly table: string;
    readonly scopes: DriverScopeMap;
    readonly params?: string;
  }): Promise<void>;
  unsubscribe(id: string): Promise<void>;

  /** Record one atomic local commit (§7.1); returns its clientCommitId. */
  mutate(mutations: readonly ClientMutation[]): Promise<string>;

  /** One combined push+pull round (§1.5, §7.2). Never throws: transport
   * and protocol failures come back as `{ ok: false }`. */
  sync(): Promise<ClientSyncResult>;
  /** Pull until quiescent (bootstrap pages, resets, delivered commits). */
  syncUntilIdle(maxRounds?: number): Promise<ClientSyncResult>;

  /** All local rows of a table, ordered by rowId. */
  readRows(table: string): Promise<ClientRowState[]>;
  conflicts(): Promise<ClientConflict[]>;
  rejections(): Promise<ClientRejection[]>;
  /** Outbox commit ids still pending, FIFO order (§7.1). */
  pendingCommitIds(): Promise<string[]>;
  subscriptionState(id: string): Promise<ClientSubscriptionState | undefined>;
  schemaFloor(): Promise<
    | {
        readonly requiredSchemaVersion?: number;
        readonly latestSchemaVersion?: number;
      }
    | undefined
  >;

  connectRealtime(): Promise<void>;
  disconnectRealtime(): Promise<void>;
  /** §8: a hello/wake-up asked for a pull that has not run yet. */
  syncNeeded(): Promise<boolean>;

  close(): Promise<void>;
}

export interface ClientDriver {
  readonly name: string;
  create(options: ClientCreateOptions): Promise<ClientInstance>;
}

// ---------------------------------------------------------------------------
// CodecDriver — the golden-vector conformance stage (Appendix A)
// ---------------------------------------------------------------------------

export type CodecRoundtrip =
  | {
      readonly ok: true;
      /** Byte-exact re-encode of the decoded value. */
      readonly bytes: Uint8Array;
      /** §11 canonical JSON debug rendering, as a JSON string. */
      readonly renderedJson: string;
    }
  | { readonly ok: false; readonly errorCode: string };

export interface CodecDriver {
  readonly name: string;
  /** Decode an SSP2 message, render it (§11), re-encode it (§9). */
  messageRoundtrip(bytes: Uint8Array): Promise<CodecRoundtrip>;
  /** Same for a standalone SSG2 rows segment (§5.2). */
  segmentRoundtrip(bytes: Uint8Array): Promise<CodecRoundtrip>;
  /** §8.1: is this JSON control text a known server event? */
  realtimeKnown(text: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

export interface Pairing {
  readonly server: ServerDriver;
  readonly client: ClientDriver;
  readonly codec: CodecDriver;
}
