/**
 * Direct segment download with re-authorization (SPEC.md §5.5).
 *
 * A segment reference is not a bearer capability: every download re-runs
 * `resolveScopes`, recomputes the effective scopes from the supplied
 * `X-Syncular-Scopes` requested map, recomputes the scope digest, and
 * requires that digest to be one of the digests the stored content was
 * published under (§5.5). Mismatch, revoked status, or resolution failure
 * ⇒ `sync.forbidden`.
 */
import type { ScopeMap } from '@syncular/core';
import type { SyncRequestContext } from './context';
import {
  clockOf,
  RESOLVER_OUTAGE,
  touchAuthenticatedPartition,
} from './context';
import { SyncError, syncError } from './errors';
import { emitEvent } from './events';
import { compileSchema } from './schema';
import { computeEffective, type ResolvedScopes, scopeDigest } from './scopes';
import { publicationRecord, type SegmentRecord } from './segment-store';

export interface SegmentDownloadRequest {
  readonly segmentId: string;
  /** The `X-Syncular-Scopes` header: canonical JSON of the requested map. */
  readonly scopesHeader: string;
}

export interface SegmentDownloadResult {
  readonly record: SegmentRecord;
  readonly bytes: Uint8Array;
  /** Response headers per §5.5. */
  readonly headers: Record<string, string>;
}

function parseScopesHeader(header: string): ScopeMap {
  let parsed: unknown;
  try {
    parsed = JSON.parse(header);
  } catch {
    throw syncError('sync.invalid_request', 'X-Syncular-Scopes is not JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw syncError('sync.invalid_request', 'X-Syncular-Scopes must be a map');
  }
  const scopes: ScopeMap = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (
      !Array.isArray(value) ||
      value.some((v: unknown) => typeof v !== 'string')
    ) {
      throw syncError(
        'sync.invalid_request',
        'X-Syncular-Scopes values must be string lists (§0)',
      );
    }
    scopes[key] = value as string[];
  }
  return scopes;
}

export async function handleSegmentDownload(
  ctx: SyncRequestContext,
  request: SegmentDownloadRequest,
): Promise<SegmentDownloadResult> {
  const events = ctx.events;
  if (events === undefined) return downloadSegment(ctx, request);
  const clock = clockOf(ctx);
  const startedAtMs = clock();
  try {
    const result = await downloadSegment(ctx, request);
    emitEvent(events, {
      type: 'segment.downloaded',
      atMs: clock(),
      partition: ctx.partition,
      actorId: ctx.actorId,
      segmentId: request.segmentId,
      outcome: 'ok',
      mediaType: result.record.mediaType,
      bytes: result.bytes.length,
      durationMs: clock() - startedAtMs,
    });
    return result;
  } catch (error) {
    emitEvent(events, {
      type: 'segment.downloaded',
      atMs: clock(),
      partition: ctx.partition,
      actorId: ctx.actorId,
      segmentId: request.segmentId,
      outcome: 'error',
      errorCode: error instanceof SyncError ? error.code : 'internal',
      durationMs: clock() - startedAtMs,
    });
    throw error;
  }
}

async function downloadSegment(
  ctx: SyncRequestContext,
  request: SegmentDownloadRequest,
): Promise<SegmentDownloadResult> {
  const registry = await touchAuthenticatedPartition(ctx);
  const entry = await ctx.segments.get(request.segmentId);
  if (entry === undefined) {
    throw syncError('sync.not_found', 'unknown segment (§5.5)');
  }
  // Select the caller's own publication context. A publication under a
  // different partition or a stale log epoch is not this caller's grant, and
  // the entry's existence must not leak across that boundary (§5.5).
  const inContext = entry.record.publications.filter(
    (publication) =>
      publication.partition === ctx.partition &&
      publication.logEpoch === registry.logEpoch,
  );
  if (inContext.length === 0) {
    throw syncError('sync.not_found', 'unknown segment (§5.5)');
  }

  const requested = parseScopesHeader(request.scopesHeader);

  let resolved: ResolvedScopes;
  try {
    const allowed = await ctx.resolveScopes({
      partition: ctx.partition,
      actorId: ctx.actorId,
    });
    // §7.3.3: leases authorize sync rounds, never downloads — an outage
    // signal here denies (re-authorization needs live scopes, §5.5).
    resolved =
      allowed === RESOLVER_OUTAGE ? { ok: false } : { ok: true, allowed };
  } catch (error) {
    const events = ctx.events;
    if (events !== undefined) {
      emitEvent(events, {
        type: 'scopes.resolve_failed',
        atMs: clockOf(ctx)(),
        partition: ctx.partition,
        actorId: ctx.actorId,
        phase: 'segment-download',
        message: error instanceof Error ? error.message : String(error),
      });
    }
    resolved = { ok: false };
  }
  const outcome = computeEffective(requested, resolved);
  if (outcome.status !== 'active') {
    throw syncError('sync.forbidden', 'segment scopes not held (§5.5)');
  }
  const digest = await scopeDigest(outcome.effective);
  // The digest is the grant, but only inside the caller's partition and live
  // epoch: identical bytes published elsewhere never authorize this caller.
  const forDigest = inContext.filter(
    (publication) => publication.scopeDigest === digest,
  );
  if (forDigest.length === 0) {
    throw syncError('sync.forbidden', 'scope digest mismatch (§3.5, §5.5)');
  }
  // TTL is per publication: an unrelated refresh of another publication must
  // not extend this grant, and an expired old pin must not shadow a live one.
  const now = clockOf(ctx)();
  const live = forDigest.filter((publication) => publication.expiresAtMs > now);
  if (live.length === 0) {
    throw syncError(
      'sync.segment_expired',
      'segment TTL elapsed — re-pull to mint fresh descriptors (§5.1)',
    );
  }
  // Choose among the live candidates that the compiled schema serves and that
  // declare every requested scope. A malformed or custom record whose newer
  // publication names another table must not fail the download while an
  // earlier valid publication of the same bytes exists.
  const schema = compileSchema(ctx.schema);
  const candidates = live.filter((publication) => {
    const table = schema.tables.get(publication.table);
    return (
      table !== undefined &&
      Object.entries(requested).every(
        ([key, values]) =>
          table.declaredVariables.has(key) && !values.includes('*'),
      )
    );
  });
  if (candidates.length === 0) {
    const served = live.some((publication) =>
      schema.tables.has(publication.table),
    );
    if (!served) {
      throw syncError('sync.not_found', 'segment table no longer served');
    }
    throw syncError(
      'sync.invalid_subscription',
      'invalid requested scopes (§3.2)',
    );
  }
  const publication = candidates[candidates.length - 1]!;

  // RFC 0007: a descriptor minted before this partition declared a backfill
  // checkpoint is not a complete window once the projection becomes
  // checkpointed. SPEC §9 mints segments per schema version, so refuse and
  // let the client re-pull for a fresh descriptor.
  const checkpoints = await ctx.storage.readCheckpoints(ctx.partition);
  if (
    checkpoints.some(
      (checkpoint) => checkpoint.schemaVersion > publication.schemaVersion,
    )
  ) {
    throw syncError(
      'sync.segment_expired',
      'segment predates the partition backfill checkpoint — re-pull (§5.1)',
    );
  }

  return {
    // The returned record is projected onto the selected publication, so its
    // `scopeDigests`/`publications` compatibility view cannot union a grant
    // from another partition (§5.1).
    record: publicationRecord(entry.record, publication),
    bytes: entry.bytes,
    headers: {
      'Content-Type': 'application/octet-stream',
      ETag: `"${entry.record.segmentId}"`,
      'Cache-Control': 'private, max-age=0',
      // Accept-Encoding: the body may be served compressed (§5.8).
      Vary: 'Authorization, X-Syncular-Scopes, Accept-Encoding',
    },
  };
}
