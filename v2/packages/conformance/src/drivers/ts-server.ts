/**
 * Reference ServerDriver: the TypeScript server library
 * (`@syncular-v2/server`) behind the driver seam. Driven exclusively
 * through bytes (`handleSyncRequest`), the §5.5 download handler, and the
 * realtime hub — the same entry points a framework adapter uses.
 */
import {
  decodeRow,
  type RowColumn,
  type RowValue,
  type ScopeMap,
} from '@syncular-v2/core';
import { yjsCrdtMergers } from '@syncular-v2/crdt-yjs';
import {
  type BlobStore,
  createRealtimeHub,
  handleBlobDownload,
  handleBlobUpload,
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
  verifySegmentToken,
} from '@syncular-v2/server';
import type {
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

/** §5.4 native scheme fixtures — the harness plays both signer and CDN. */
const SIGNED_URL_KEY = 'conformance-signing-key';
const SIGNED_URL_BASE = 'https://cdn.conformance.test/segments';
const audienceFor = (partition: string) => `aud:${partition}`;

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
  readonly #signedUrls: SegmentUrlConfig | undefined;
  #signedUrlTtlSeconds: number;
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
      ...(this.#leases !== undefined ? { leases: this.#leases } : {}),
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

  async downloadBlob(actorId: string, blobId: string): Promise<BytesResult> {
    try {
      const result = await handleBlobDownload(this.#ctx(actorId), blobId);
      return { ok: true, bytes: result.bytes };
    } catch (error) {
      if (error instanceof SyncError) {
        return { ok: false, error: toDriverError(error) };
      }
      throw error;
    }
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
        [string, string]
      >(
        `SELECT row_id, server_version, scopes, payload FROM sync_rows
         WHERE partition=? AND tbl=? ORDER BY row_id`,
      )
      .all(this.#partition, table);
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
  capabilities: ['idempotency-fault', 'signed-urls', 'blobs', 'crdt', 'leases'],
  async create(options: ServerCreateOptions): Promise<ServerInstance> {
    return new TsServerInstance(options);
  },
};
