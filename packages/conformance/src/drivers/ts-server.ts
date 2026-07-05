/**
 * Reference ServerDriver: the TypeScript server library
 * (`@syncular/server`) behind the driver seam. Driven exclusively
 * through bytes (`handleSyncRequest`), the §5.5 download handler, and the
 * realtime hub — the same entry points a framework adapter uses.
 */
import {
  decodeRow,
  type RowColumn,
  type RowValue,
  type ScopeMap,
} from '@syncular/core';
import { yjsCrdtMergers } from '@syncular/crdt-yjs';
import {
  type BlobPresignConfig,
  type BlobStore,
  type BlobUploadPresignConfig,
  createRealtimeHub,
  handleBlobDownload,
  handleBlobUpload,
  handleBlobUploadGrant,
  handleSegmentDownload,
  handleSyncRequest,
  type LeaseConfig,
  MemoryBlobStore,
  MemoryLeaseStore,
  MemorySegmentStore,
  pruneCommitLog,
  RESOLVER_OUTAGE,
  type RealtimeHub,
  type SegmentUrlConfig,
  type ServerSchema,
  type ServerStorage,
  SqliteServerStorage,
  SyncError,
  type SyncRequestContext,
  ValidationRejection,
  type Validator,
  type ValidatorRegistry,
  verifySegmentToken,
} from '@syncular/server';
import type {
  BlobDownloadResult,
  BlobUploadGrantResult,
  BytesResult,
  DriverError,
  DriverRow,
  DriverRowValue,
  DriverSchema,
  DriverScopeMap,
  RealtimeConnectResult,
  RealtimeSink,
  RetentionOptions,
  ServerCreateOptions,
  ServerDriver,
  ServerInstance,
  ServerRowState,
  ValidatorInstallSpec,
} from '../driver';
import { bytesToHex } from '../raw';

function toServerSchema(schema: DriverSchema): ServerSchema {
  return {
    version: schema.version,
    tables: schema.tables.map((table) => ({
      name: table.name,
      columns: table.columns as readonly RowColumn[],
      primaryKey: table.primaryKey,
      scopes: table.scopes.map((scope) =>
        scope.column !== undefined
          ? { pattern: scope.pattern, column: scope.column }
          : scope.pattern,
      ),
    })),
  };
}

function toDriverError(error: SyncError): DriverError {
  return {
    code: error.code,
    message: error.message,
    category: error.category,
    retryable: error.retryable,
    recommendedAction: error.recommendedAction,
  };
}

function toDriverValue(value: RowValue): DriverRowValue {
  if (value instanceof Uint8Array) return { $bytes: bytesToHex(value) };
  return value;
}

/**
 * §6.7: compile one declarative rule spec into a real `Validator`. The
 * interpreter is the driver's translation of the JSON-able seam spec into
 * the host callback the server library actually runs — the same shape a
 * real app author would write by hand.
 */
function compileValidatorRule(spec: ValidatorInstallSpec): Validator {
  const rule = spec.rule;
  if (rule.kind === 'maxLength') {
    return (op) => {
      if (op.row === undefined) return; // deletes carry no row
      const value = op.row[rule.column];
      if (typeof value === 'string' && value.length > rule.max) {
        throw new ValidationRejection(
          rule.code,
          `${rule.column} exceeds ${rule.max} chars (§6.7)`,
        );
      }
    };
  }
  // immutableWhen: an UPDATE that changes `column` is rejected while the
  // STORED row's `guardColumn` equals `guardValue` — reads op.stored.
  return (op) => {
    if (op.row === undefined || op.stored === undefined) return; // insert/delete
    if (op.stored[rule.guardColumn] !== rule.guardValue) return;
    if (op.row[rule.column] !== op.stored[rule.column]) {
      throw new ValidationRejection(
        rule.code,
        `${rule.column} is immutable while ${rule.guardColumn}=${String(rule.guardValue)} (§6.7)`,
      );
    }
  };
}

/** §5.4 native scheme fixtures — the harness plays both signer and CDN. */
const SIGNED_URL_KEY = 'conformance-signing-key';
const SIGNED_URL_BASE = 'https://cdn.conformance.test/segments';
const audienceFor = (partition: string) => `aud:${partition}`;

/**
 * §5.9.3/§5.9.5 blob-presign fixtures — the harness plays object store + CDN.
 * The presigned URL is `blob-cdn://<partition>/<blobId>?exp=<ms>&op=<get|put>`;
 * `fetchBlobUrl`/`putBlobUrl` parse it and serve/store against the blob store,
 * enforcing only the expiry (the token bound blob+aud at issuance, §5.9.5).
 */
const BLOB_CDN_BASE = 'blob-cdn://conformance';
const BLOB_URL_TTL_SECONDS = 900;

function mintBlobUrl(
  partition: string,
  blobId: string,
  op: 'get' | 'put',
  nowMs: number,
  ttlSeconds: number,
): { url: string; urlExpiresAtMs: number } {
  const urlExpiresAtMs = (Math.floor(nowMs / 1000) + ttlSeconds) * 1000;
  const url =
    `${BLOB_CDN_BASE}/${encodeURIComponent(partition)}/${encodeURIComponent(blobId)}` +
    `?op=${op}&exp=${urlExpiresAtMs}`;
  return { url, urlExpiresAtMs };
}

function parseBlobUrl(
  url: string,
): { partition: string; blobId: string; op: string; exp: number } | undefined {
  if (!url.startsWith(`${BLOB_CDN_BASE}/`)) return undefined;
  const rest = url.slice(`${BLOB_CDN_BASE}/`.length);
  const qIndex = rest.indexOf('?');
  const path = qIndex >= 0 ? rest.slice(0, qIndex) : rest;
  const query = new URLSearchParams(qIndex >= 0 ? rest.slice(qIndex + 1) : '');
  const parts = path.split('/');
  if (parts.length !== 2) return undefined;
  return {
    partition: decodeURIComponent(parts[0] ?? ''),
    blobId: decodeURIComponent(parts[1] ?? ''),
    op: query.get('op') ?? '',
    exp: Number(query.get('exp') ?? 0),
  };
}

class TsServerInstance implements ServerInstance {
  readonly #schema: DriverSchema;
  readonly #partition: string;
  readonly #storage: SqliteServerStorage;
  readonly #wrapped: ServerStorage;
  readonly #segments: MemorySegmentStore;
  readonly #blobs: BlobStore = new MemoryBlobStore();
  readonly #hub: RealtimeHub;
  readonly #allowed = new Map<string, ScopeMap>();
  readonly #now: { ms: number };
  readonly #limits: {
    maxOperationsPerRequest: number;
    inlineSegmentMaxBytes: number;
  };
  #resolverFailing = false;
  #resolverOutage = false;
  #failNextIdempotencyLookup = false;
  /** §6.7: installed per-table write validators (absent ⇒ feature off). */
  #validators: ValidatorRegistry | undefined;
  readonly #signedUrls: SegmentUrlConfig | undefined;
  #signedUrlTtlSeconds: number;
  /** §5.9.3/§5.9.5 blob-presign toggle (default off; scenarios flip it). */
  #blobPresign = false;
  readonly #blobDownloadPresign: BlobPresignConfig;
  readonly #blobUploadPresign: BlobUploadPresignConfig;
  /** §7.3: the lease store + config, present iff `leases` was requested. */
  readonly #leases: LeaseConfig | undefined;

  constructor(options: ServerCreateOptions) {
    this.#schema = options.schema;
    this.#partition = options.partition;
    this.#storage = new SqliteServerStorage();
    this.#now = { ms: options.nowMs };
    this.#limits = {
      maxOperationsPerRequest: options.limits?.maxOperationsPerRequest ?? 500,
      inlineSegmentMaxBytes:
        options.limits?.inlineSegmentMaxBytes ?? 256 * 1024,
    };
    this.#segments = new MemorySegmentStore(
      options.limits?.segmentTtlMs !== undefined
        ? { ttlMs: options.limits.segmentTtlMs }
        : {},
    );
    this.#signedUrlTtlSeconds = options.signedUrls?.ttlSeconds ?? 900;
    // Native HMAC issuance (§5.4); ttlSeconds is a live getter so
    // scenarios can flip the TTL between pulls (expiry probes).
    const self = this;
    this.#signedUrls =
      options.signedUrls !== undefined
        ? {
            key: SIGNED_URL_KEY,
            baseUrl: SIGNED_URL_BASE,
            audience: audienceFor,
            get ttlSeconds() {
              return self.#signedUrlTtlSeconds;
            },
          }
        : undefined;
    // §7.3: a memory lease store with a deterministic id factory so
    // scenarios can assert stable leaseIds across refreshes.
    let leaseCounter = 0;
    const nextLeaseId = (): string => {
      leaseCounter += 1;
      return `lease_${leaseCounter}`;
    };
    this.#leases =
      options.leases !== undefined
        ? {
            ttlMs: options.leases.ttlMs,
            store: new MemoryLeaseStore({ leaseId: nextLeaseId }),
          }
        : undefined;
    // §5.9.5 always-issue / §5.9.3 grant: the harness plays object store + CDN.
    // The configs mint `blob-cdn://` urls the download/grant handlers return;
    // `fetchBlobUrl`/`putBlobUrl` serve/store against the blob store. Wired
    // into #ctx only while #blobPresign is on (setBlobPresign flips it).
    this.#blobDownloadPresign = {
      ttlSeconds: BLOB_URL_TTL_SECONDS,
      presign: ({ partition, blobId, ttlSeconds, nowMs }) =>
        mintBlobUrl(partition, blobId, 'get', nowMs, ttlSeconds),
    };
    this.#blobUploadPresign = {
      ttlSeconds: BLOB_URL_TTL_SECONDS,
      presign: ({ partition, blobId, ttlSeconds, nowMs }) =>
        mintBlobUrl(partition, blobId, 'put', nowMs, ttlSeconds),
    };
    this.#wrapped = this.#wrapStorage();
    this.#hub = createRealtimeHub({
      schema: toServerSchema(options.schema),
      storage: this.#wrapped,
      resolveScopes: (args) => this.#resolveScopes(args.actorId),
      clock: () => this.#now.ms,
      // §8.7: socket sync rounds share the HTTP binding's segment store
      // and limits (one handler, two framings).
      segments: this.#segments,
      limits: this.#limits,
      ...(this.#signedUrls !== undefined
        ? { signedUrls: this.#signedUrls }
        : {}),
      ...(this.#leases !== undefined ? { leases: this.#leases } : {}),
      ...(options.limits?.maxDeltaBytes !== undefined
        ? { maxDeltaBytes: options.limits.maxDeltaBytes }
        : {}),
      ...(options.limits?.maxPresenceBytes !== undefined
        ? { maxPresenceBytes: options.limits.maxPresenceBytes }
        : {}),
    });
  }

  #resolveScopes(actorId: string): ScopeMap | typeof RESOLVER_OUTAGE {
    if (this.#resolverFailing) {
      throw new Error('injected: resolveScopes failure');
    }
    // §7.3.3: an injected outage opts the request into lease authorization
    // (a signal, never a throw).
    if (this.#resolverOutage) return RESOLVER_OUTAGE;
    // Unset actors hold nothing — subscriptions revoke, writes deny.
    return this.#allowed.get(actorId) ?? {};
  }

  /** Storage with the optional idempotency-lookup fault (§6.3). */
  #wrapStorage(): ServerStorage {
    const storage = this.#storage;
    return {
      ensureSchema: (s) => storage.ensureSchema(s),
      begin: (p) => storage.begin(p),
      getMaxCommitSeq: (p) => storage.getMaxCommitSeq(p),
      getHorizonSeq: (p) => storage.getHorizonSeq(p),
      setHorizonSeq: (p, s) => storage.setHorizonSeq(p, s),
      pruneCommitsThrough: (p, s) => storage.pruneCommitsThrough(p, s),
      getCommitSeqBefore: (p, t) => storage.getCommitSeqBefore(p, t),
      getRow: (p, t, r) => storage.getRow(p, t, r),
      getPushResult: (p, c, id) => {
        if (this.#failNextIdempotencyLookup) {
          this.#failNextIdempotencyLookup = false;
          throw new SyncError(
            'sync.idempotency_cache_miss',
            'injected: unreadable idempotency record',
          );
        }
        return storage.getPushResult(p, c, id);
      },
      readCommitWindow: (p, q) => storage.readCommitWindow(p, q),
      scanRows: (p, q) => storage.scanRows(p, q),
      getClientRecord: (p, c) => storage.getClientRecord(p, c),
      putClientRecord: (p, r) => storage.putClientRecord(p, r),
      listClientCursors: (p) => storage.listClientCursors(p),
      // §5.9.4 blob reference index reads.
      listRowsReferencingBlob: (p, b) => storage.listRowsReferencingBlob(p, b),
      listReferencedBlobIds: (p) => storage.listReferencedBlobIds(p),
    };
  }

  #ctx(actorId: string): SyncRequestContext {
    return {
      partition: this.#partition,
      actorId,
      schema: toServerSchema(this.#schema),
      storage: this.#wrapped,
      segments: this.#segments,
      blobs: this.#blobs,
      // §5.10.2: the reference yjs-doc merger, kept out of core/server.
      crdtMergers: yjsCrdtMergers,
      resolveScopes: (args) => this.#resolveScopes(args.actorId),
      clock: () => this.#now.ms,
      limits: this.#limits,
      ...(this.#signedUrls !== undefined
        ? { signedUrls: this.#signedUrls }
        : {}),
      // §5.9.5/§5.9.3 blob presign: active only while the toggle is on.
      ...(this.#blobPresign
        ? {
            blobSignedUrls: this.#blobDownloadPresign,
            blobUploadUrls: this.#blobUploadPresign,
          }
        : {}),
      ...(this.#leases !== undefined ? { leases: this.#leases } : {}),
      // §6.7: pass the installed validators (undefined ⇒ feature off).
      ...(this.#validators !== undefined
        ? { validators: this.#validators }
        : {}),
      realtime: this.#hub,
    };
  }

  async handleSyncRequest(
    actorId: string,
    request: Uint8Array,
  ): Promise<BytesResult> {
    try {
      const bytes = await handleSyncRequest(request, this.#ctx(actorId));
      return { ok: true, bytes };
    } catch (error) {
      if (error instanceof SyncError) {
        return { ok: false, error: toDriverError(error) };
      }
      throw error;
    }
  }

  async downloadSegment(
    actorId: string,
    segmentId: string,
    scopesHeaderJson: string,
  ): Promise<BytesResult> {
    try {
      const result = await handleSegmentDownload(this.#ctx(actorId), {
        segmentId,
        scopesHeader: scopesHeaderJson,
      });
      return { ok: true, bytes: result.bytes };
    } catch (error) {
      if (error instanceof SyncError) {
        return { ok: false, error: toDriverError(error) };
      }
      throw error;
    }
  }

  async uploadBlob(
    actorId: string,
    blobId: string,
    bytes: Uint8Array,
    mediaType?: string,
  ): Promise<{ ok: true } | { ok: false; error: DriverError }> {
    try {
      await handleBlobUpload(this.#ctx(actorId), {
        blobId,
        bytes,
        ...(mediaType !== undefined ? { mediaType } : {}),
      });
      return { ok: true };
    } catch (error) {
      if (error instanceof SyncError) {
        return { ok: false, error: toDriverError(error) };
      }
      throw error;
    }
  }

  async downloadBlob(
    actorId: string,
    blobId: string,
  ): Promise<BlobDownloadResult> {
    try {
      const result = await handleBlobDownload(this.#ctx(actorId), blobId);
      if (result.url !== undefined) {
        // §5.9.5 always-issue: the server exited the egress path.
        return {
          ok: true,
          url: result.url,
          ...(result.urlExpiresAtMs !== undefined
            ? { urlExpiresAtMs: result.urlExpiresAtMs }
            : {}),
        };
      }
      return { ok: true, bytes: result.bytes ?? new Uint8Array(0) };
    } catch (error) {
      if (error instanceof SyncError) {
        return { ok: false, error: toDriverError(error) };
      }
      throw error;
    }
  }

  /**
   * §5.9.5 CDN role: serve a presigned blob GET url exactly as the object host
   * would — parse the `blob-cdn://` url, enforce only the expiry (the token
   * bound blob+aud at issuance, §5.9.5), and return the stored bytes. No actor
   * identity, no re-authorization (the url is the entire grant).
   */
  async fetchBlobUrl(url: string): Promise<BytesResult> {
    try {
      const parsed = parseBlobUrl(url);
      if (parsed === undefined || parsed.op !== 'get') {
        throw new SyncError('blob.not_found', 'unknown blob url host (§5.9.5)');
      }
      if (parsed.exp <= this.#now.ms) {
        throw new SyncError('sync.forbidden', 'blob url expired (§5.9.5)');
      }
      const entry = await this.#blobs.get(parsed.partition, parsed.blobId);
      if (entry === undefined) {
        throw new SyncError('blob.not_found', 'unknown blob (§5.9.5)');
      }
      return { ok: true, bytes: entry.bytes };
    } catch (error) {
      if (error instanceof SyncError) {
        return { ok: false, error: toDriverError(error) };
      }
      throw error;
    }
  }

  /** §5.9.3 upload grant — host-auth'd + size-capped; mints a presigned PUT. */
  async uploadBlobGrant(
    actorId: string,
    blobId: string,
    byteLength: number,
    mediaType?: string,
  ): Promise<BlobUploadGrantResult> {
    try {
      const grant = await handleBlobUploadGrant(this.#ctx(actorId), {
        blobId,
        byteLength,
        ...(mediaType !== undefined ? { mediaType } : {}),
      });
      if (grant.url !== undefined) {
        return {
          ok: true,
          grant: {
            kind: 'url',
            url: grant.url,
            ...(grant.urlExpiresAtMs !== undefined
              ? { urlExpiresAtMs: grant.urlExpiresAtMs }
              : {}),
          },
        };
      }
      if (grant.present === true) {
        return { ok: true, grant: { kind: 'present' } };
      }
      return { ok: true, grant: { kind: 'none' } };
    } catch (error) {
      if (error instanceof SyncError) {
        return { ok: false, error: toDriverError(error) };
      }
      throw error;
    }
  }

  /**
   * §5.9.3 object-store PUT role: accept bytes at a presigned PUT url exactly
   * as the object host would — parse the url, enforce the expiry, and store
   * into the blob store so a later §5.9.6 existence check + download resolve.
   * No content-address recompute here (the store does not; integrity is the
   * reference-time check, §5.9.3).
   */
  async putBlobUrl(
    url: string,
    bytes: Uint8Array,
  ): Promise<{ ok: true } | { ok: false; error: DriverError }> {
    try {
      const parsed = parseBlobUrl(url);
      if (parsed === undefined || parsed.op !== 'put') {
        throw new SyncError('blob.not_found', 'unknown blob url host (§5.9.3)');
      }
      if (parsed.exp <= this.#now.ms) {
        throw new SyncError('sync.forbidden', 'blob url expired (§5.9.3)');
      }
      await this.#blobs.put(
        parsed.partition,
        parsed.blobId,
        bytes,
        this.#now.ms,
      );
      return { ok: true };
    } catch (error) {
      if (error instanceof SyncError) {
        return { ok: false, error: toDriverError(error) };
      }
      throw error;
    }
  }

  async setBlobPresign(enabled: boolean): Promise<void> {
    this.#blobPresign = enabled;
  }

  /**
   * The §5.4 CDN role for the native scheme: serve a signed URL exactly
   * as the URL host would — verify the `st` token against the stored
   * segment (MAC, expiry with the native ≤ 60 s skew, seg/sd/aud
   * claims), no actor identity, no scopes header. Content bytes are the
   * stored (uncompressed, content-addressed) object.
   */
  async fetchSegmentUrl(url: string): Promise<BytesResult> {
    try {
      if (this.#signedUrls === undefined) {
        throw new SyncError('sync.not_found', 'signed URLs not configured');
      }
      const parsed = new URL(url);
      if (!url.startsWith(`${SIGNED_URL_BASE}/`)) {
        throw new SyncError('sync.not_found', 'unknown URL host');
      }
      const segmentId = decodeURIComponent(
        parsed.pathname.slice(parsed.pathname.lastIndexOf('/') + 1),
      );
      const token = parsed.searchParams.get('st');
      if (token === null) {
        throw new SyncError('sync.forbidden', 'missing st token');
      }
      const entry = await this.#segments.get(segmentId);
      if (entry === undefined) {
        throw new SyncError('sync.not_found', 'unknown segment (§5.5)');
      }
      await verifySegmentToken(SIGNED_URL_KEY, token, {
        segmentId,
        scopeDigest: entry.record.scopeDigest,
        audience: audienceFor(this.#partition),
        nowMs: this.#now.ms,
      });
      return { ok: true, bytes: entry.bytes };
    } catch (error) {
      if (error instanceof SyncError) {
        return { ok: false, error: toDriverError(error) };
      }
      throw error;
    }
  }

  async setSignedUrlTtlSeconds(ttlSeconds: number): Promise<void> {
    this.#signedUrlTtlSeconds = ttlSeconds;
  }

  async connectRealtime(
    actorId: string,
    clientId: string,
    sink: RealtimeSink,
  ): Promise<RealtimeConnectResult> {
    try {
      const session = await this.#hub.connect({
        partition: this.#partition,
        actorId,
        clientId,
        send: (data) => {
          if (typeof data === 'string') sink.onText(data);
          else sink.onBinary(data);
        },
        closeSocket: () => sink.onClose?.(),
      });
      return {
        ok: true,
        connection: {
          send: (text) => session.handleMessage(text),
          sendBinary: (bytes) => session.handleBinary(bytes),
          close: () => session.close(),
        },
      };
    } catch (error) {
      if (error instanceof SyncError) {
        return { ok: false, error: toDriverError(error) };
      }
      throw error;
    }
  }

  async setAllowedScopes(
    actorId: string,
    allowed: DriverScopeMap,
  ): Promise<void> {
    this.#allowed.set(actorId, allowed as ScopeMap);
  }

  async installValidators(
    specs: readonly ValidatorInstallSpec[],
  ): Promise<void> {
    if (specs.length === 0) {
      this.#validators = undefined;
      return;
    }
    const registry: Record<string, Validator> = {};
    for (const spec of specs) {
      registry[spec.table] = compileValidatorRule(spec);
    }
    this.#validators = registry;
  }

  async setResolverFailing(failing: boolean): Promise<void> {
    this.#resolverFailing = failing;
  }

  async setResolverOutage(outage: boolean): Promise<void> {
    this.#resolverOutage = outage;
  }

  async revokeLease(leaseId: string): Promise<void> {
    if (this.#leases === undefined) {
      throw new Error('revokeLease requires a leases-enabled server');
    }
    await this.#leases.store.revoke(this.#partition, leaseId);
  }

  async advanceClock(ms: number): Promise<void> {
    this.#now.ms += ms;
  }

  async nowMs(): Promise<number> {
    return this.#now.ms;
  }

  async prune(retention?: RetentionOptions): Promise<number> {
    return pruneCommitLog({
      storage: this.#wrapped,
      partition: this.#partition,
      nowMs: this.#now.ms,
      ...(retention !== undefined ? { retention } : {}),
    });
  }

  async getMaxCommitSeq(): Promise<number> {
    return this.#storage.getMaxCommitSeq(this.#partition);
  }

  async getHorizonSeq(): Promise<number> {
    return this.#storage.getHorizonSeq(this.#partition);
  }

  async readRows(table: string): Promise<ServerRowState[]> {
    const schemaTable = this.#schema.tables.find((t) => t.name === table);
    if (schemaTable === undefined) throw new Error(`unknown table ${table}`);
    const columns = schemaTable.columns as readonly RowColumn[];
    const rows = this.#storage.db
      .query<
        {
          row_id: string;
          server_version: number;
          scopes: string;
          payload: Uint8Array;
        },
        [string]
      >(
        `SELECT _sync_row_id AS row_id, _sync_server_version AS server_version,
                _sync_scopes AS scopes, _sync_payload AS payload
         FROM "${table.replaceAll('"', '""')}"
         WHERE _sync_partition=? ORDER BY _sync_row_id`,
      )
      .all(this.#partition);
    return rows.map((row) => {
      const values = decodeRow(columns, new Uint8Array(row.payload));
      const record: Record<string, DriverRowValue> = {};
      columns.forEach((column, index) => {
        record[column.name] = toDriverValue(values[index] ?? null);
      });
      return {
        rowId: row.row_id,
        version: row.server_version,
        values: record as DriverRow,
        scopes: JSON.parse(row.scopes) as Record<string, string>,
      };
    });
  }

  async failNextIdempotencyLookup(): Promise<void> {
    this.#failNextIdempotencyLookup = true;
  }

  async close(): Promise<void> {
    this.#storage.db.close();
  }
}

export const tsServerDriver: ServerDriver = {
  name: 'ts-server',
  capabilities: [
    'idempotency-fault',
    'signed-urls',
    'blobs',
    'blob-presign',
    'crdt',
    'leases',
    'validators',
  ],
  async create(options: ServerCreateOptions): Promise<ServerInstance> {
    return new TsServerInstance(options);
  },
};
