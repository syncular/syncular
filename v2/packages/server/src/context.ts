/**
 * The host context for `handleSyncRequest` (REVISE B2): storage, the
 * `resolveScopes` host callback (runs in the host process — the moat),
 * clock, and a segment store. Framework-free; adapters supply `partition`
 * and `actorId` from host authentication (§1.1).
 */
import type { ScopeMap } from '@syncular-v2/core';
import type { BlobStore } from './blob-store';
import type { CrdtMergerRegistry } from './crdt-merger';
import type { SyncularServerEvents } from './events';
import type { LeaseStore } from './lease-store';
import type { ServerSchema } from './schema';
import type { SegmentStore } from './segment-store';
import type { SegmentUrlConfig } from './signed-url';
import type { SqliteImageBuilder } from './sqlite-image';
import type { ServerStorage, StoredCommit } from './storage';

/** SSP2 body content type (§1.1). */
export const SSP2_CONTENT_TYPE = 'application/vnd.syncular.sync.v2';

export interface ResolveScopesArgs {
  readonly partition: string;
  readonly actorId: string;
  /**
   * The requesting client (§1.5). Present on sync rounds (the lease key,
   * §7.3.3); absent on segment/blob downloads, which re-authorize by
   * actor + scopes only (§5.5, §5.9.5) and never consult a lease.
   */
  readonly clientId?: string;
}

/**
 * Sentinel a resolver returns to signal a **live-authorization outage**
 * (§7.3.3): the live authority is unreachable, so the server SHOULD
 * authorize this request against the actor's stored lease instead of
 * throwing. Distinct from throwing (§3.2 rule 5, which still fails loud
 * and revokes). Only meaningful when `leases` is configured; without a
 * lease store an outage degrades to `sync.auth_lease_required`.
 */
export const RESOLVER_OUTAGE = Symbol.for('syncular.resolver_outage');
export type ResolverOutage = typeof RESOLVER_OUTAGE;

/**
 * Host callback: actor → allowed scopes (§3.2 step 3). Resolved at most
 * once per request and memoized (§3.4 step 1). `'*'` means "any value for
 * this variable". A throwing resolver revokes subscriptions and rejects
 * writes with `sync.forbidden` — fail loud, never leak. Returning
 * `RESOLVER_OUTAGE` instead opts the request into lease authorization
 * (§7.3.3) — a deliberate outage signal, not a failure.
 */
export type ResolveScopes = (
  args: ResolveScopesArgs,
) => ScopeMap | ResolverOutage | Promise<ScopeMap | ResolverOutage>;

/** §7.3: auth-lease feature config. Absent ⇒ leases off (zero cost). */
export interface LeaseConfig {
  /** Lease TTL in ms — the sliding window width (§7.3.3). */
  readonly ttlMs: number;
  /** The lease store (§7.3.1); host-owned, optional like blobs. */
  readonly store: LeaseStore;
}

export interface ServerLimits {
  /** Operation cap per request (§6.1 `sync.too_many_operations`). */
  readonly maxOperationsPerRequest: number;
  /** Inline rows segments up to this size (§5.7 SHOULD: 256 KiB). */
  readonly inlineSegmentMaxBytes: number;
}

export const DEFAULT_LIMITS: ServerLimits = {
  maxOperationsPerRequest: 500,
  inlineSegmentMaxBytes: 256 * 1024,
};

/** Receives applied commits for realtime fanout (§8.2). */
export interface RealtimeNotifier {
  notifyCommit(partition: string, commit: StoredCommit): void | Promise<void>;
}

export interface SyncServerConfig {
  readonly schema: ServerSchema;
  readonly storage: ServerStorage;
  readonly segments: SegmentStore;
  /**
   * Blob store (§5.9). Absent ⇒ blobs unsupported: a table with a
   * `blob_ref` column may still sync (the ref is just a string), but the
   * push existence check (§6.6) and the `/blobs` endpoints require it.
   */
  readonly blobs?: BlobStore;
  /** Max upload size for `/blobs` (§5.9.3 `blob.too_large`); default 64 MiB. */
  readonly maxBlobBytes?: number;
  /**
   * CRDT merger registry (§5.10.2), `crdtType` → merge fn. Absent ⇒ no
   * column can CRDT-merge: a push touching a `crdt` column then fails
   * `sync.crdt_merge_failed` (§5.10.6). Kept out of core — the reference
   * `yjs-doc` merger ships in `@syncular-v2/crdt-yjs` (the blob-store rule).
   */
  readonly crdtMergers?: CrdtMergerRegistry;
  readonly resolveScopes: ResolveScopes;
  /**
   * §7.3 auth leases. Absent ⇒ the feature is off: no `LEASE` frame is
   * ever emitted and a `RESOLVER_OUTAGE` signal degrades to
   * `sync.auth_lease_required`. Present ⇒ successful authorized rounds
   * issue/refresh a lease and outages authorize against it.
   */
  readonly leases?: LeaseConfig;
  /** Epoch-ms clock; defaults to `Date.now`. */
  readonly clock?: () => number;
  readonly limits?: Partial<ServerLimits>;
  /** §5.4 signed-URL delivery: native HMAC tokens or delegated presign. */
  readonly signedUrls?: SegmentUrlConfig;
  /**
   * §5.3 sqlite-image builder (TODO §4.2), injected so the pull path never
   * statically imports `bun:sqlite`. Absent ⇒ the sqlite-image lane is off
   * (bit-2 clients are served the rows lane) — the Workers/edge posture. A
   * Bun/Node host wires `buildSqliteImage` from `@syncular-v2/server`.
   */
  readonly sqliteImageBuilder?: SqliteImageBuilder;
  readonly realtime?: RealtimeNotifier;
  /**
   * Optional structured-events sink (ops seam). Absent ⇒ zero cost: no
   * event objects are built. A throwing sink never affects processing.
   */
  readonly events?: SyncularServerEvents;
}

/** Per-request context: the config plus host-authenticated identity. */
export interface SyncRequestContext extends SyncServerConfig {
  readonly partition: string;
  readonly actorId: string;
}

export function clockOf(ctx: SyncServerConfig): () => number {
  return ctx.clock ?? Date.now;
}

export function limitsOf(ctx: SyncServerConfig): ServerLimits {
  return { ...DEFAULT_LIMITS, ...ctx.limits };
}
