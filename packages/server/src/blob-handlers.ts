/**
 * Blob upload + download handlers (SPEC.md §5.9.3, §5.9.5).
 *
 * Upload verifies the content address (§5.9.3); download re-authorizes on
 * every request against the rows that reference the blob (§5.9.5) — a
 * `blobId` is never a bearer capability. Framework-free; the hono/runtime
 * adapters map these onto `PUT/GET <mount>/blobs/{blobId}`.
 */
import { blobIdFor, isBlobId } from './blob-store';
import type { SyncRequestContext } from './context';
import { clockOf, RESOLVER_OUTAGE } from './context';
import { SyncError, syncError } from './errors';
import { emitEvent } from './events';
import { compileSchema } from './schema';
import { authorizeWrite, type ResolvedScopes } from './scopes';

const DEFAULT_MAX_BLOB_BYTES = 64 * 1024 * 1024;

export interface BlobUploadRequest {
  readonly blobId: string;
  readonly bytes: Uint8Array;
  /** Advisory MIME type from the upload `Content-Type`, if any. */
  readonly mediaType?: string;
}

export interface BlobDownloadResult {
  readonly bytes: Uint8Array;
  readonly headers: Record<string, string>;
}

/** `PUT <mount>/blobs/{blobId}` (§5.9.3). Host auth is the adapter's job. */
export async function handleBlobUpload(
  ctx: SyncRequestContext,
  request: BlobUploadRequest,
): Promise<void> {
  const store = ctx.blobs;
  if (store === undefined) {
    throw syncError('blob.not_found', 'this server has no blob store (§5.9)');
  }
  if (!isBlobId(request.blobId)) {
    throw syncError(
      'blob.hash_mismatch',
      'blobId path is not "sha256:<64 hex>" (§5.9.1)',
    );
  }
  const maxBytes = ctx.maxBlobBytes ?? DEFAULT_MAX_BLOB_BYTES;
  if (request.bytes.length > maxBytes) {
    throw syncError(
      'blob.too_large',
      `blob exceeds the ${maxBytes}-byte cap (§5.9.3)`,
    );
  }
  const computed = await blobIdFor(request.bytes);
  if (computed !== request.blobId) {
    throw syncError(
      'blob.hash_mismatch',
      'uploaded bytes do not hash to the blobId path (§5.9.3)',
    );
  }
  const clock = clockOf(ctx);
  await store.put(
    ctx.partition,
    request.blobId,
    request.bytes,
    clock(),
    request.mediaType,
  );
  if (ctx.events !== undefined) {
    emitEvent(ctx.events, {
      type: 'blob.uploaded',
      atMs: clock(),
      partition: ctx.partition,
      actorId: ctx.actorId,
      blobId: request.blobId,
      bytes: request.bytes.length,
    });
  }
}

/**
 * `GET <mount>/blobs/{blobId}` (§5.9.5). Authorization derives from the
 * referencing rows: the actor may download iff at least one row in the
 * reference index passes the §3.4 scope check for the actor.
 */
export async function handleBlobDownload(
  ctx: SyncRequestContext,
  blobId: string,
): Promise<BlobDownloadResult> {
  const events = ctx.events;
  if (events === undefined) return downloadBlob(ctx, blobId);
  const clock = clockOf(ctx);
  const startedAtMs = clock();
  try {
    const result = await downloadBlob(ctx, blobId);
    emitEvent(events, {
      type: 'blob.downloaded',
      atMs: clock(),
      partition: ctx.partition,
      actorId: ctx.actorId,
      blobId,
      outcome: 'ok',
      bytes: result.bytes.length,
      durationMs: clock() - startedAtMs,
    });
    return result;
  } catch (error) {
    emitEvent(events, {
      type: 'blob.downloaded',
      atMs: clock(),
      partition: ctx.partition,
      actorId: ctx.actorId,
      blobId,
      outcome: 'error',
      errorCode: error instanceof SyncError ? error.code : 'internal',
      durationMs: clock() - startedAtMs,
    });
    throw error;
  }
}

async function downloadBlob(
  ctx: SyncRequestContext,
  blobId: string,
): Promise<BlobDownloadResult> {
  const store = ctx.blobs;
  if (store === undefined) {
    throw syncError('blob.not_found', 'this server has no blob store (§5.9)');
  }
  if (!isBlobId(blobId)) {
    throw syncError('blob.not_found', 'malformed blobId (§5.9.1)');
  }
  const entry = await store.get(ctx.partition, blobId);
  if (entry === undefined) {
    throw syncError('blob.not_found', 'unknown blob (§5.9.5)');
  }

  // §5.9.5 authorization: resolve once, then test referencing rows.
  const listRows = ctx.storage.listRowsReferencingBlob;
  if (listRows === undefined) {
    // Storage without the reference index cannot authorize a download —
    // fail closed (never serve bytes we cannot authorize).
    throw syncError(
      'blob.forbidden',
      'storage has no blob reference index (§5.9.4)',
    );
  }
  let resolved: ResolvedScopes;
  try {
    const allowed = await ctx.resolveScopes({
      partition: ctx.partition,
      actorId: ctx.actorId,
    });
    // §7.3.3: leases never authorize a blob download — an outage denies.
    resolved =
      allowed === RESOLVER_OUTAGE ? { ok: false } : { ok: true, allowed };
  } catch (error) {
    if (ctx.events !== undefined) {
      emitEvent(ctx.events, {
        type: 'scopes.resolve_failed',
        atMs: clockOf(ctx)(),
        partition: ctx.partition,
        actorId: ctx.actorId,
        phase: 'blob-download',
        message: error instanceof Error ? error.message : String(error),
      });
    }
    resolved = { ok: false };
  }
  if (!resolved.ok) {
    throw syncError('blob.forbidden', 'scope resolution failed (§5.9.5)');
  }

  const schema = compileSchema(ctx.schema);
  const rows = await listRows.call(ctx.storage, ctx.partition, blobId);
  let authorized = false;
  for (const row of rows) {
    const table = schema.tables.get(row.table);
    if (table === undefined) continue;
    if (authorizeWrite(table, row.scopes, resolved)) {
      authorized = true;
      break;
    }
  }
  if (!authorized) {
    // Never 404 here: existence-vs-authorization must not leak (§5.9.5).
    throw syncError(
      'blob.forbidden',
      'no referencing row authorizes this actor (§5.9.5)',
    );
  }

  return {
    bytes: entry.bytes,
    headers: {
      'Content-Type': entry.record.mediaType ?? 'application/octet-stream',
      ETag: `"${blobId}"`,
      'Cache-Control': 'private, max-age=0',
      Vary: 'Authorization, Accept-Encoding',
    },
  };
}
