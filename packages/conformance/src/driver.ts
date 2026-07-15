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
  | 'bytes'
  | 'blob_ref'
  | 'crdt';

export interface DriverColumn {
  readonly name: string;
  readonly type: DriverColumnType;
  readonly nullable: boolean;
  /** §5.10.1: the merger name for a `crdt` column (default `yjs-doc`). */
  readonly crdtType?: string;
  /** §5.11: this column is encrypted; `type` is `bytes` and `declaredType`
   * is the app-side type. */
  readonly encrypted?: boolean;
  readonly declaredType?: DriverColumnType;
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

/**
 * §5.9.5 blob download result at the driver seam: inline bytes, OR (presign
 * configured, always-issue) a signed `url` the client fetches directly.
 */
export type BlobDownloadResult =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | {
      readonly ok: true;
      readonly url: string;
      readonly urlExpiresAtMs?: number;
    }
  | { readonly ok: false; readonly error: DriverError };

/** §5.9.3 presigned-upload grant at the driver seam. */
export type BlobUploadGrantResult =
  | {
      readonly ok: true;
      readonly grant:
        | {
            readonly kind: 'url';
            readonly url: string;
            readonly urlExpiresAtMs?: number;
          }
        | { readonly kind: 'present' }
        | { readonly kind: 'none' };
    }
  | { readonly ok: false; readonly error: DriverError };

// ---------------------------------------------------------------------------
// ServerDriver
// ---------------------------------------------------------------------------

export interface ServerLimitsOptions {
  readonly maxOperationsPerRequest?: number;
  readonly inlineSegmentMaxBytes?: number;
  readonly maxDeltaBytes?: number;
  readonly segmentTtlMs?: number;
  /** §8.6.2 presence document size cap (bytes). */
  readonly maxPresenceBytes?: number;
}

/** §5.4 signed-URL issuance (native HMAC scheme) for the server under
 * test. The TTL is mutable at runtime via `setSignedUrlTtlSeconds`. */
export interface ServerSignedUrlOptions {
  readonly ttlSeconds?: number;
}

/** §7.3 auth-lease feature for the server under test. */
export interface ServerLeaseOptions {
  /** Lease TTL in ms — the sliding window width (§7.3.3). */
  readonly ttlMs: number;
}

export interface ServerCreateOptions {
  readonly schema: DriverSchema;
  readonly partition: string;
  /** Virtual clock start, epoch ms. The clock only moves via advanceClock. */
  readonly nowMs: number;
  readonly limits?: ServerLimitsOptions;
  readonly signedUrls?: ServerSignedUrlOptions;
  /** §7.3: enable auth leases with this TTL (absent ⇒ feature off). */
  readonly leases?: ServerLeaseOptions;
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
export type ServerCapability =
  | 'idempotency-fault'
  | 'signed-urls'
  | 'blobs'
  | 'blob-presign'
  | 'crdt'
  | 'leases'
  | 'validators';

/**
 * §6.7 declarative write-validation rule (JSON-able so it crosses the
 * driver seam). A server driver interprets these into real per-table
 * validators. The rule kinds are the minimum the catalog exercises; a
 * driver that advertises the `validators` capability MUST implement all of
 * them (an unknown kind is a driver bug, thrown loudly).
 */
export type ValidatorRuleSpec =
  | {
      /** Reject when `column`'s string value exceeds `max` chars. */
      readonly kind: 'maxLength';
      readonly column: string;
      readonly max: number;
      /** The host code the rejection carries (§6.7; non-reserved prefix). */
      readonly code: string;
    }
  | {
      /**
       * Reject an UPDATE (a stored row exists) that changes `column` while
       * the STORED row's `guardColumn` equals `guardValue` — a transition
       * rule that must read the stored row (the §6.7 stored-row proof).
       */
      readonly kind: 'immutableWhen';
      readonly column: string;
      readonly guardColumn: string;
      readonly guardValue: DriverRowValue;
      readonly code: string;
    };

/** §6.7: install (or replace) per-table validators for the server under
 * test. One rule per table; an empty map clears all validators. */
export interface ValidatorInstallSpec {
  readonly table: string;
  readonly rule: ValidatorRuleSpec;
}

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

  /**
   * `blobs`: §5.9.3 upload (host-authenticated, content address verified)
   * and §5.9.5 download (re-authorized against referencing rows). Present
   * only when the server driver advertises the `blobs` capability.
   */
  uploadBlob?(
    actorId: string,
    blobId: string,
    bytes: Uint8Array,
    mediaType?: string,
  ): Promise<
    { readonly ok: true } | { readonly ok: false; readonly error: DriverError }
  >;
  /**
   * §5.9.5 download: bytes inline, OR (presign configured, always-issue) a
   * signed `url` the client fetches directly.
   */
  downloadBlob?(actorId: string, blobId: string): Promise<BlobDownloadResult>;
  /**
   * `blob-presign`: the §5.9.5 CDN role — serve a presigned blob GET url
   * exactly as the object host would (verify the token, no actor identity).
   */
  fetchBlobUrl?(url: string): Promise<BytesResult>;
  /**
   * `blob-presign`: §5.9.3 upload grant — mint a presigned PUT url (or a
   * present marker), host-auth'd + size-capped up front.
   */
  uploadBlobGrant?(
    actorId: string,
    blobId: string,
    byteLength: number,
    mediaType?: string,
  ): Promise<BlobUploadGrantResult>;
  /**
   * `blob-presign`: the §5.9.3 object-store PUT role — accept bytes at a
   * presigned PUT url exactly as the object host would (verify the token, no
   * actor identity), storing them so a later download resolves.
   */
  putBlobUrl?(
    url: string,
    bytes: Uint8Array,
  ): Promise<
    { readonly ok: true } | { readonly ok: false; readonly error: DriverError }
  >;
  /** `blob-presign`: toggle presigned blob download+upload at runtime. */
  setBlobPresign?(enabled: boolean): Promise<void>;

  /**
   * `signed-urls`: the CDN/edge role for the §5.4 native scheme — serve
   * a signed segment URL exactly as the URL host would (verify the `st`
   * token against the stored segment, no actor identity involved).
   */
  fetchSegmentUrl?(url: string): Promise<BytesResult>;

  /** `signed-urls`: change the issuance TTL for subsequently minted URLs
   * (0 ⇒ URLs are born expired — the §5.4 no-fetch-past-expiry probe). */
  setSignedUrlTtlSeconds?(ttlSeconds: number): Promise<void>;

  /** §8.1 realtime attach for (actorId, clientId). */
  connectRealtime(
    actorId: string,
    clientId: string,
    sink: RealtimeSink,
  ): Promise<RealtimeConnectResult>;

  // -- host control ---------------------------------------------------------

  /** Set the actor's allowed scopes (§3.2 step 3). `'*'` = any value. */
  setAllowedScopes(actorId: string, allowed: DriverScopeMap): Promise<void>;

  /**
   * `validators`: install §6.7 per-table write-validation hooks for the
   * server under test (replacing any previously installed). Present only
   * when the server driver advertises the `validators` capability.
   */
  installValidators?(specs: readonly ValidatorInstallSpec[]): Promise<void>;
  /** Make `resolveScopes` throw for every actor (fail-loud paths). */
  setResolverFailing(failing: boolean): Promise<void>;

  /**
   * `leases`: put the resolver into a live-authorization outage (§7.3.3) —
   * `resolveScopes` returns the outage signal so the round authorizes
   * against the stored lease. Distinct from `setResolverFailing` (a throw).
   */
  setResolverOutage?(outage: boolean): Promise<void>;
  /** `leases`: revoke a lease by `leaseId` (§7.3.4). */
  revokeLease?(leaseId: string): Promise<void>;

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
  /** Direct-endpoint segment fetch (§5.5). The §5.4 resolution — which
   * path a descriptor takes, expiry, no fall-through — is the client's. */
  downloadSegment(request: {
    readonly segmentId: string;
    readonly table: string;
    /** Canonical JSON (§11.2) of the requested scope map (§5.5). */
    readonly requestedScopesJson: string;
  }): Promise<Uint8Array>;
  /**
   * Bare URL fetch (§5.4 signed-URL path) — the harness's CDN hop.
   * Presence is the client's bit-3 capability (negotiation, §4.2):
   * drivers advertise accept bit 3 iff this endpoint exists. Nothing but
   * the URL crosses (the URL is the entire grant).
   */
  fetchSegmentUrl?(url: string): Promise<Uint8Array>;
  /**
   * §5.9 blob transport endpoints handed to the client. Presence means the
   * client can upload/download blobs (the harness bridges to the server's
   * `/blobs` routes and counts calls). Rejects on the server's `blob.*`
   * errors (§5.9.3/§5.9.5).
   */
  uploadBlob?(
    blobId: string,
    bytes: Uint8Array,
    mediaType?: string,
  ): Promise<void>;
  /**
   * §5.9.5 download: bytes inline, OR a presigned `url` the client core
   * fetches via `fetchBlobUrl` (always-issue). Mutually exclusive arms.
   */
  downloadBlob?(blobId: string): Promise<
    | { readonly kind: 'bytes'; readonly bytes: Uint8Array }
    | {
        readonly kind: 'url';
        readonly url: string;
        readonly urlExpiresAtMs?: number;
      }
  >;
  /**
   * §5.9.5 presigned-download fetch — the harness CDN hop (counted). No host
   * auth crosses (the url is the entire grant). Present iff the client can
   * consume urls.
   */
  fetchBlobUrl?(url: string): Promise<Uint8Array>;
  /**
   * §5.9.3 presigned-upload grant — the harness mints (or declines) a PUT url.
   * Present iff the client supports the grant flow.
   */
  uploadBlobGrant?(
    blobId: string,
    byteLength: number,
    mediaType?: string,
  ): Promise<
    | {
        readonly kind: 'url';
        readonly url: string;
        readonly urlExpiresAtMs?: number;
      }
    | { readonly kind: 'present' }
    | { readonly kind: 'none' }
  >;
  /**
   * §5.9.3 direct-to-storage PUT — the harness object-store hop (counted). No
   * host auth crosses (the url is the entire grant).
   */
  putBlobUrl?(
    url: string,
    bytes: Uint8Array,
    mediaType?: string,
  ): Promise<void>;
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
  readonly operation?: {
    readonly changedFields?: readonly string[];
  };
}

export interface ClientRejection {
  readonly clientCommitId: string;
  readonly opIndex: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: {
    readonly fieldPaths?: readonly string[];
    readonly reason?: string;
    readonly requiredAction?: string;
    readonly references?: Readonly<Record<string, string>>;
  };
  readonly operation?: {
    readonly changedFields?: readonly string[];
  };
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
  /** §5.9.7 B1 blob-cache size cap (bytes); LRU-evicts zero-ref bodies. */
  readonly blobCacheMaxBytes?: number;
}

/**
 * §5.11 client-side encryption config for a driver client. `keys` maps a
 * key-id to its 32-byte key in the `{ $bytes: hex }` driver form. Both cores
 * install these and encrypt/decrypt columns the schema marks `encrypted`.
 */
export interface DriverEncryptionConfig {
  readonly keys: Readonly<Record<string, { readonly $bytes: string }>>;
}

export interface ClientCreateOptions {
  readonly clientId: string;
  readonly schema: DriverSchema;
  readonly endpoints: ClientEndpoints;
  readonly limits?: ClientLimitsOptions;
  /**
   * Pin the client clock (epoch ms). Scenarios exercising the §5.4
   * `urlExpiresAtMs` check set this to the server's virtual now — a
   * wall-clock client would misjudge virtual-clock expiries.
   */
  readonly nowMs?: number;
  /** §5.11 client-side encryption keys; absent ⇒ E2EE off. */
  readonly encryption?: DriverEncryptionConfig;
}

/** §4.8 window base a scenario windows on: table + variable + fixed scopes. */
export interface DriverWindowBase {
  readonly table: string;
  readonly variable: string;
  readonly fixedScopes?: DriverScopeMap;
  readonly params?: string;
}

/** Exact client-local observation output (RFC 0003). Revisions are decimal
 * strings so the same vectors cross JSON/stdin and JavaScript losslessly. */
export interface DriverChangeBatch {
  readonly revision: string;
  readonly tables: readonly {
    readonly table: string;
    readonly scopeKeys?: readonly string[];
  }[];
  readonly windows: readonly {
    readonly baseKey: string;
    readonly table: string;
    readonly units: readonly string[];
  }[];
  readonly status?: {
    readonly outbox: number;
    readonly upgrading: boolean;
    readonly syncNeeded: boolean;
  };
  readonly conflictsChanged: boolean;
  readonly rejectionsChanged: boolean;
  readonly outcomesChanged: boolean;
}

export type DriverSyncIntent =
  | { readonly kind: 'none' }
  | { readonly kind: 'interactive' }
  | { readonly kind: 'background'; readonly delayMs: number };

export interface ClientInstance {
  subscribe(input: {
    readonly id: string;
    readonly table: string;
    readonly scopes: DriverScopeMap;
    readonly params?: string;
  }): Promise<void>;
  unsubscribe(id: string): Promise<void>;

  /**
   * §4.8 windowed subscriptions: set the live units (scope values) of a
   * window base. Additive — a driver that predates windowing omits it, and
   * scenarios requiring it skip on that driver.
   */
  setWindow?(base: DriverWindowBase, units: readonly string[]): Promise<void>;
  /**
   * §4.8 completeness oracle (I3): the windowed-in units for a base, plus
   * the subset still bootstrap-pending (registered, bootstrap not yet
   * completed — not complete until it lands; zero rows still complete).
   */
  windowState?(base: DriverWindowBase): Promise<{
    readonly units: readonly string[];
    readonly pending: readonly string[];
  }>;

  /** RFC 0003 observation/conformance surface. */
  localRevision?(): Promise<string>;
  statusSnapshot?(): Promise<{
    readonly outbox: number;
    readonly upgrading: boolean;
    readonly syncNeeded: boolean;
  }>;
  querySnapshot?(
    sql: string,
    params?: readonly DriverRowValue[],
    coverage?: readonly {
      readonly base: DriverWindowBase;
      readonly units: readonly string[];
    }[],
  ): Promise<{
    readonly revision: string;
    readonly rows: readonly Record<string, DriverRowValue>[];
    readonly coverage: {
      readonly complete: boolean;
      readonly pending: readonly {
        readonly baseKey: string;
        readonly unit: string;
      }[];
      readonly missing: readonly {
        readonly baseKey: string;
        readonly unit: string;
      }[];
    };
  }>;
  drainChangeBatches?(): Promise<readonly DriverChangeBatch[]>;
  drainSyncIntents?(): Promise<readonly DriverSyncIntent[]>;

  /** Record one atomic local commit (§7.1); returns its clientCommitId. */
  mutate(mutations: readonly ClientMutation[]): Promise<string>;
  patch(
    table: string,
    rowId: string,
    partial: DriverRow,
    baseVersion?: number,
  ): Promise<string>;

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
  /** §7.3.5: the client's opaque auth-lease state, or undefined. */
  leaseState(): Promise<
    | {
        readonly leaseId?: string;
        readonly expiresAtMs?: number;
        readonly errorCode?: string;
      }
    | undefined
  >;
  /** §7.4.5: true while a schema-bump reset + first re-bootstrap is in
   * flight (undefined for a driver that predates the schema-bump rung). */
  upgrading?(): Promise<boolean>;

  /**
   * §7.4.2: the "app ships new code" step — recreate the client core with a
   * NEW generated schema while KEEPING this client's local database
   * (identity, outbox, and existing tables). Models a real upgrade: the
   * boot-time §7.4.1 marker check fires and drives the wipe/re-bootstrap
   * flow. Returns the new instance; the old handle MUST NOT be used after.
   * Present only for client drivers that support keeping the DB (additive).
   */
  recreateWithSchema?(schema: DriverSchema): Promise<ClientInstance>;

  /**
   * §5.9 blob API. `uploadBlob` stages bytes and returns the canonical
   * `blob_ref` string to store in a column (upload flushed before the next
   * push, B4). `fetchBlob` resolves bytes (cache hit or download) as a
   * `{ $bytes }` value. Present iff the client driver supports blobs.
   */
  uploadBlob?(
    bytes: Uint8Array,
    options?: { readonly mediaType?: string; readonly name?: string },
  ): Promise<string>;
  fetchBlob?(blobIdOrRef: string): Promise<{ readonly $bytes: string }>;

  connectRealtime(): Promise<void>;
  disconnectRealtime(): Promise<void>;
  /** §8: a hello/wake-up asked for a pull that has not run yet. */
  syncNeeded(): Promise<boolean>;

  /** §8.6: publish (or clear, `doc: null`) a scope-keyed presence document. */
  setPresence?(
    scopeKey: string,
    doc: Record<string, unknown> | null,
  ): Promise<void>;
  /** §8.6: the peers currently present on a scope key. */
  presence?(scopeKey: string): Promise<readonly ClientPresencePeer[]>;

  /**
   * §5.10.4/§5.10.5 native CRDT convenience: a client that can AUTHOR crdt
   * edits in its own core (the Rust core via its `crdt-yjs` commands, the TS
   * core via `@syncular/crdt-yjs`'s `YjsColumn`). The edit loads the row's
   * current merged `crdt` column bytes, applies the op, and pushes the full
   * state baseVersion-less through `mutate`. Present iff the driver supports
   * native crdt authoring — scenarios requiring it (`requires: ['crdt']` plus
   * a `client.crdtText` presence check) skip on a driver that lacks it. The
   * cross-core proof runs the SAME scenario against the Rust client core and
   * the TS server, and vice versa, asserting byte-identical convergence.
   */
  crdtText?(input: {
    readonly table: string;
    readonly rowId: string;
    readonly column: string;
    readonly name?: string;
  }): Promise<string>;
  crdtInsertText?(input: {
    readonly table: string;
    readonly rowId: string;
    readonly column: string;
    readonly name?: string;
    readonly index: number;
    readonly value: string;
  }): Promise<void>;
  crdtDeleteText?(input: {
    readonly table: string;
    readonly rowId: string;
    readonly column: string;
    readonly name?: string;
    readonly index: number;
    readonly len: number;
  }): Promise<void>;
  crdtApplyUpdate?(input: {
    readonly table: string;
    readonly rowId: string;
    readonly column: string;
    readonly update: Uint8Array;
  }): Promise<void>;

  close(): Promise<void>;
}

/** §8.6 a peer present on a scope key, as the driver surfaces it. */
export interface ClientPresencePeer {
  readonly actorId: string;
  readonly clientId: string;
  readonly doc: Record<string, unknown>;
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
