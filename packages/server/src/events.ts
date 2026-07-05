/**
 * Structured server events — the one operational seam (host surface, not
 * wire protocol; SPEC.md is untouched by this module).
 *
 * Design rules:
 * - Every event is a flat, JSON-able object with a stable `type` string:
 *   the same shapes feed one-line JSON logs, metrics pipelines, and error
 *   trackers alike. No logger dependency, no formatting — emission only.
 * - Emission is fire-and-forget: a throwing handler MUST NOT affect
 *   request processing (`emitEvent` swallows), and when no sink is
 *   configured the hot path pays only an `undefined` check — call sites
 *   never build event objects behind a disabled check.
 * - Timestamps and durations come from the ctx clock where one exists, so
 *   the conformance virtual-clock discipline stays intact.
 */
import type { WakeReason } from '@syncular/core';

/** One `POST /sync` request, emitted once per request after the response
 * bytes are fully produced (or the request was rejected up front). */
export interface RequestHandledEvent {
  readonly type: 'request.handled';
  readonly kind: 'sync';
  readonly atMs: number;
  readonly partition: string;
  readonly actorId: string;
  readonly durationMs: number;
  readonly bytesIn: number;
  readonly bytesOut: number;
  /**
   * `ok` — response streamed to END;
   * `schema_floor` — §2.4 required-schema answer;
   * `rejected` — request validation failed before any bytes (§1.7);
   * `error` — in-band ERROR frame (§1.6) or a thrown host failure.
   */
  readonly outcome: 'ok' | 'schema_floor' | 'rejected' | 'error';
  /** §10.2 code for `rejected`/`error`; `"internal"` for non-SyncErrors. */
  readonly errorCode?: string;
  readonly pushCommits: number;
  readonly pulled: boolean;
  readonly subscriptions: number;
}

interface PushEventBase {
  readonly atMs: number;
  readonly partition: string;
  readonly actorId: string;
  readonly clientId: string;
  readonly clientCommitId: string;
  /** Operations carried by the PUSH_COMMIT frame. */
  readonly operations: number;
}

/** A push commit applied (or replayed from the idempotency cache, §2.3). */
export interface PushAppliedEvent extends PushEventBase {
  readonly type: 'push.applied';
  readonly commitSeq?: number;
  /** True when the result came from the idempotency cache (`cached`). */
  readonly replay: boolean;
}

/** A push commit rejected (§6.3) — the terminating operation's code. */
export interface PushRejectedEvent extends PushEventBase {
  readonly type: 'push.rejected';
  readonly code: string;
  readonly opIndex: number;
}

/** A push commit terminated by a version conflict (§6.2). */
export interface PushConflictedEvent extends PushEventBase {
  readonly type: 'push.conflicted';
  readonly opIndex: number;
}

/** One emitted segment within a pull subscription section. */
export interface PullSegmentSummary {
  readonly mediaType: 'rows' | 'sqlite';
  readonly delivery: 'inline' | 'ref';
  /** `reused` — served from the §5.3 reuse key without rebuilding. */
  readonly origin: 'built' | 'reused';
  readonly bytes: number;
  readonly rows: number;
}

/** One subscription section of a served pull (§1.6). */
export interface PullSubscriptionSummary {
  readonly id: string;
  readonly table: string;
  readonly status: 'active' | 'revoked' | 'reset';
  /** `none` for revoked/reset sections (no data half was produced). */
  readonly mode: 'bootstrap' | 'incremental' | 'none';
  readonly fromCursor: number;
  readonly nextCursor: number;
  readonly commits: number;
  readonly changes: number;
  readonly segments: readonly PullSegmentSummary[];
}

/** The pull half of a request, emitted once after all sections streamed. */
export interface PullServedEvent {
  readonly type: 'pull.served';
  readonly atMs: number;
  readonly partition: string;
  readonly actorId: string;
  readonly clientId: string;
  readonly subscriptions: readonly PullSubscriptionSummary[];
}

/** A direct segment download (§5.5), success or failure. */
export interface SegmentDownloadedEvent {
  readonly type: 'segment.downloaded';
  readonly atMs: number;
  readonly partition: string;
  readonly actorId: string;
  readonly segmentId: string;
  readonly outcome: 'ok' | 'error';
  readonly errorCode?: string;
  readonly mediaType?: 'rows' | 'sqlite';
  readonly bytes?: number;
  readonly durationMs: number;
}

/** A blob upload accepted (§5.9.3, content address verified). */
export interface BlobUploadedEvent {
  readonly type: 'blob.uploaded';
  readonly atMs: number;
  readonly partition: string;
  readonly actorId: string;
  readonly blobId: string;
  readonly bytes: number;
}

/** A blob download (§5.9.5), success or failure. */
export interface BlobDownloadedEvent {
  readonly type: 'blob.downloaded';
  readonly atMs: number;
  readonly partition: string;
  readonly actorId: string;
  readonly blobId: string;
  readonly outcome: 'ok' | 'error';
  readonly errorCode?: string;
  readonly bytes?: number;
  readonly durationMs: number;
}

/** A §5.9.2 orphan-blob sweep pass finished (host-scheduled GC). */
export interface BlobSweptEvent {
  readonly type: 'blob.swept';
  readonly atMs: number;
  readonly partition: string;
  /** Blobs deleted this pass (unreferenced and older than the grace period). */
  readonly swept: number;
  /** Size of the live keep-set consulted (§5.9.4 reference index). */
  readonly referenced: number;
  /** The grace period applied (ms) — the upload→push race protection. */
  readonly graceMs: number;
}

interface RealtimeEventBase {
  readonly atMs: number;
  readonly partition: string;
  readonly actorId: string;
  readonly clientId: string;
  readonly sessionId: string;
}

/** A realtime session registered and greeted (§8.1). */
export interface RealtimeOpenedEvent extends RealtimeEventBase {
  readonly type: 'realtime.opened';
  readonly registrations: number;
  readonly cursor: number;
  readonly latestSeq: number;
}

/** A realtime session left the hub. */
export interface RealtimeClosedEvent extends RealtimeEventBase {
  readonly type: 'realtime.closed';
  readonly durationMs: number;
}

/** A delta message pushed over the socket (§8.2). */
export interface RealtimeDeltaEvent extends RealtimeEventBase {
  readonly type: 'realtime.delta';
  readonly commitSeq: number;
  readonly bytes: number;
  readonly changes: number;
}

/** A `sync` wake-up sent instead of (or in addition to) deltas (§8.3). */
export interface RealtimeWakeEvent extends RealtimeEventBase {
  readonly type: 'realtime.wake';
  readonly reason: WakeReason;
}

/** A §4.6 prune pass finished (whether or not the horizon moved). */
export interface PruneCompletedEvent {
  readonly type: 'prune.completed';
  readonly atMs: number;
  readonly partition: string;
  readonly previousHorizonSeq: number;
  readonly horizonSeq: number;
  readonly advanced: boolean;
  readonly removedCommits: number;
}

/** The host `resolveScopes` callback threw — the §3.2/§3.4 fail-loud
 * path (subscriptions revoke, writes reject, downloads deny). */
export interface ScopesResolveFailedEvent {
  readonly type: 'scopes.resolve_failed';
  readonly atMs: number;
  readonly partition: string;
  readonly actorId: string;
  readonly phase: 'request' | 'realtime' | 'segment-download' | 'blob-download';
  readonly message: string;
}

/** §7.3.3: a lease was issued or refreshed (sliding window) on an
 * authorized round and a `LEASE` frame emitted. */
export interface LeaseIssuedEvent {
  readonly type: 'lease.issued';
  readonly atMs: number;
  readonly partition: string;
  readonly actorId: string;
  readonly clientId: string;
  readonly leaseId: string;
  readonly expiresAtMs: number;
}

/** §7.3.4: a lease was revoked by the host (out-of-band control call). */
export interface LeaseRevokedEvent {
  readonly type: 'lease.revoked';
  readonly atMs: number;
  readonly partition: string;
  readonly leaseId: string;
}

export type SyncularServerEvent =
  | RequestHandledEvent
  | PushAppliedEvent
  | PushRejectedEvent
  | PushConflictedEvent
  | PullServedEvent
  | SegmentDownloadedEvent
  | BlobUploadedEvent
  | BlobDownloadedEvent
  | BlobSweptEvent
  | RealtimeOpenedEvent
  | RealtimeClosedEvent
  | RealtimeDeltaEvent
  | RealtimeWakeEvent
  | PruneCompletedEvent
  | ScopesResolveFailedEvent
  | LeaseIssuedEvent
  | LeaseRevokedEvent;

/**
 * The seam. Optional on the server config — when absent, no event object
 * is ever built. Implementations receive every event synchronously and
 * MUST NOT rely on throwing to influence processing: exceptions are
 * swallowed at the emission point.
 */
export interface SyncularServerEvents {
  emit(event: SyncularServerEvent): void;
}

/** Guarded emission: a throwing sink never affects request processing. */
export function emitEvent(
  sink: SyncularServerEvents,
  event: SyncularServerEvent,
): void {
  try {
    sink.emit(event);
  } catch {
    // fire-and-forget by contract
  }
}

/**
 * Reference sink: one line of JSON per event (stdout by default).
 * Suitable for piping into any log collector.
 */
export function consoleJsonEvents(
  write: (line: string) => void = (line) => {
    console.log(line);
  },
): SyncularServerEvents {
  return {
    emit(event) {
      write(JSON.stringify(event));
    },
  };
}
