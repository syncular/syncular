/**
 * The host context for `handleSyncRequest` (REVISE B2): storage, the
 * `resolveScopes` host callback (runs in the host process — the moat),
 * clock, and a segment store. Framework-free; adapters supply `partition`
 * and `actorId` from host authentication (§1.1).
 */
import type { ScopeMap } from '@syncular-v2/core';
import type { ServerSchema } from './schema';
import type { SegmentStore } from './segment-store';
import type { SignedUrlConfig } from './signed-url';
import type { ServerStorage, StoredCommit } from './storage';

/** SSP2 body content type (§1.1). */
export const SSP2_CONTENT_TYPE = 'application/vnd.syncular.sync.v2';

export interface ResolveScopesArgs {
  readonly partition: string;
  readonly actorId: string;
}

/**
 * Host callback: actor → allowed scopes (§3.2 step 3). Resolved at most
 * once per request and memoized (§3.4 step 1). `'*'` means "any value for
 * this variable". A throwing resolver revokes subscriptions and rejects
 * writes with `sync.forbidden` — fail loud, never leak.
 */
export type ResolveScopes = (
  args: ResolveScopesArgs,
) => ScopeMap | Promise<ScopeMap>;

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
  readonly resolveScopes: ResolveScopes;
  /** Epoch-ms clock; defaults to `Date.now`. */
  readonly clock?: () => number;
  readonly limits?: Partial<ServerLimits>;
  readonly signedUrls?: SignedUrlConfig;
  readonly realtime?: RealtimeNotifier;
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
