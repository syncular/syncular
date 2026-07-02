/**
 * Direct segment download with re-authorization (SPEC.md §5.5).
 *
 * A segment reference is not a bearer capability: every download re-runs
 * `resolveScopes`, recomputes the effective scopes from the supplied
 * `X-Syncular-Scopes` requested map, recomputes the scope digest, and
 * compares it with the segment's stored digest. Mismatch, revoked status,
 * or resolution failure ⇒ `sync.forbidden`.
 */
import type { ScopeMap } from '@syncular-v2/core';
import type { SyncRequestContext } from './context';
import { clockOf } from './context';
import { syncError } from './errors';
import { compileSchema } from './schema';
import { computeEffective, type ResolvedScopes, scopeDigest } from './scopes';
import type { SegmentRecord } from './segment-store';

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
  const entry = await ctx.segments.get(request.segmentId);
  if (entry === undefined || entry.record.partition !== ctx.partition) {
    throw syncError('sync.not_found', 'unknown segment (§5.5)');
  }
  if (entry.record.expiresAtMs <= clockOf(ctx)()) {
    throw syncError(
      'sync.segment_expired',
      'segment TTL elapsed — re-pull to mint fresh descriptors (§5.1)',
    );
  }

  const schema = compileSchema(ctx.schema);
  const table = schema.tables.get(entry.record.table);
  if (table === undefined) {
    throw syncError('sync.not_found', 'segment table no longer served');
  }
  const requested = parseScopesHeader(request.scopesHeader);
  for (const [key, values] of Object.entries(requested)) {
    if (!table.declaredVariables.has(key) || values.includes('*')) {
      throw syncError(
        'sync.invalid_subscription',
        'invalid requested scopes (§3.2)',
      );
    }
  }

  let resolved: ResolvedScopes;
  try {
    const allowed = await ctx.resolveScopes({
      partition: ctx.partition,
      actorId: ctx.actorId,
    });
    resolved = { ok: true, allowed };
  } catch {
    resolved = { ok: false };
  }
  const outcome = computeEffective(requested, resolved);
  if (outcome.status !== 'active') {
    throw syncError('sync.forbidden', 'segment scopes not held (§5.5)');
  }
  const digest = await scopeDigest(outcome.effective);
  if (digest !== entry.record.scopeDigest) {
    throw syncError('sync.forbidden', 'scope digest mismatch (§3.5, §5.5)');
  }

  return {
    record: entry.record,
    bytes: entry.bytes,
    headers: {
      'Content-Type': 'application/octet-stream',
      ETag: `"${entry.record.segmentId}"`,
      'Cache-Control': 'private, max-age=0',
      Vary: 'Authorization, X-Syncular-Scopes',
    },
  };
}
