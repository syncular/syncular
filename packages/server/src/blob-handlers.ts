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
import { issueBlobUploadUrl, issueBlobUrl } from './signed-url';

const DEFAULT_MAX_BLOB_BYTES = 64 * 1024 * 1024;

export interface BlobUploadRequest {
  readonly blobId: string;
  readonly bytes: Uint8Array;
  /** Advisory MIME type from the upload `Content-Type`, if any. */
  readonly mediaType?: string;
}

export interface BlobDownloadResult {
  /**
   * The blob bytes, when served inline. **Absent** when the host configured
   * `blobSignedUrls` and a `url` was issued: the sync server exits the egress
   * path and the client fetches `url` directly (§5.9.5 always-issue).
   */
  readonly bytes?: Uint8Array;
  readonly headers: Record<string, string>;
  /**
   * §5.9.5 delegated presign (always-issue): a provider-signed GET URL for
   * the bytes, issued only after the row-derived authorization check passed.
   * Present iff the host configured `blobSignedUrls`; when present, `bytes` is
   * absent and the client MUST fetch the URL directly (no host auth), verify
   * the content address, and on failure re-request this endpoint — never fall
   * through (§5.9.5 recovery rule).
   */
  readonly url?: string;
  readonly urlExpiresAtMs?: number;
}

/** `POST <mount>/blobs/{blobId}/upload-grant` request body (§5.9.3). */
export interface BlobUploadGrantRequest {
  readonly blobId: string;
  /** Declared uncompressed size — the size-cap check runs against this. */
  readonly byteLength: number;
  /** Advisory MIME type, if any. */
  readonly mediaType?: string;
}

/**
 * `POST <mount>/blobs/{blobId}/upload-grant` result (§5.9.3). Exactly one of:
 * `{url, urlExpiresAtMs}` — a presigned PUT the client uses direct-to-storage;
 * or `{present: true}` — the blob already exists (idempotent §5.9.3), so the
 * client skips the PUT; or `{}` (no fields) — the host has no presigned-upload
 * store configured, so the client streams through the direct PUT endpoint
 * (§5.9.3 capability, not fallback).
 */
export interface BlobUploadGrantResult {
  readonly url?: string;
  readonly urlExpiresAtMs?: number;
  readonly present?: boolean;
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
      // Presigned delivery carries no inline bytes (§5.9.5 always-issue); the
      // byte count is unknown to the sync server, which exited the egress path.
      bytes: result.bytes?.length ?? 0,
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
  // §5.9.5 always-issue: when presign is configured the server exits the
  // egress path — it only needs to know the object EXISTS (a HEAD/`has`), not
  // the bytes. Inline delivery loads the bytes; presigned delivery does not.
  const presignConfigured = ctx.blobSignedUrls !== undefined;
  let entry: { record: { mediaType?: string }; bytes: Uint8Array } | undefined;
  let mediaType: string | undefined;
  if (presignConfigured) {
    if (!(await store.has(ctx.partition, blobId))) {
      throw syncError('blob.not_found', 'unknown blob (§5.9.5)');
    }
  } else {
    entry = await store.get(ctx.partition, blobId);
    if (entry === undefined) {
      throw syncError('blob.not_found', 'unknown blob (§5.9.5)');
    }
    mediaType = entry.record.mediaType;
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

  // §5.9.5 delegated presign (always-issue): authorization has passed above,
  // so a signed URL is now a short-TTL bearer grant to exactly these immutable
  // bytes. When configured, issue it and return NO bytes — the client fetches
  // the URL directly. Never before the check, never a capability from the id.
  if (ctx.blobSignedUrls !== undefined) {
    const issued = await issueBlobUrl(ctx.blobSignedUrls, {
      partition: ctx.partition,
      blobId,
      nowMs: clockOf(ctx)(),
    });
    return {
      headers: {
        ETag: `"${blobId}"`,
        'Cache-Control': 'private, max-age=0',
        Vary: 'Authorization, Accept-Encoding',
      },
      url: issued.url,
      urlExpiresAtMs: issued.urlExpiresAtMs,
    };
  }

  // Inline delivery (no presign store configured): the bytes were loaded.
  const bytes = entry?.bytes;
  if (bytes === undefined) {
    // Unreachable: presign not configured ⇒ `entry` was loaded above.
    throw syncError('blob.not_found', 'blob bytes unavailable (§5.9.5)');
  }
  return {
    bytes,
    headers: {
      'Content-Type': mediaType ?? 'application/octet-stream',
      ETag: `"${blobId}"`,
      'Cache-Control': 'private, max-age=0',
      Vary: 'Authorization, Accept-Encoding',
    },
  };
}

/**
 * `POST <mount>/blobs/{blobId}/upload-grant` (§5.9.3 presigned upload). Host
 * auth is the adapter's job — uploading is host-auth-only, not scope-bearing,
 * so any authenticated actor may obtain a grant within the size cap (§5.9.3).
 *
 * The size cap is enforced HERE, up front, against the declared `byteLength`
 * (the object-store hop cannot re-check the streamed byte count). Integrity is
 * NOT checked here: the object store places bytes at the content-addressed key,
 * and the address is verified at reference time (§5.9.6 push existence) and on
 * every download (§5.9.5/§5.1). Returns a presigned single PUT, or a
 * `present` marker if the blob already exists (idempotent §5.9.3), or an empty
 * result when no presigned-upload store is configured (client streams direct).
 */
export async function handleBlobUploadGrant(
  ctx: SyncRequestContext,
  request: BlobUploadGrantRequest,
): Promise<BlobUploadGrantResult> {
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
  if (
    !Number.isInteger(request.byteLength) ||
    request.byteLength < 0 ||
    request.byteLength > maxBytes
  ) {
    // §5.9.3: cap enforced at grant issuance, before any URL is minted.
    throw syncError(
      'blob.too_large',
      `blob byteLength exceeds the ${maxBytes}-byte cap (§5.9.3)`,
    );
  }
  // §5.9.3 no presigned-upload store: report no grant; the client streams
  // through the direct PUT endpoint (capability, not fallback).
  if (ctx.blobUploadUrls === undefined) return {};
  // Idempotent §5.9.3: an already-present blob needs no PUT.
  if (await store.has(ctx.partition, request.blobId)) {
    return { present: true };
  }
  const issued = await issueBlobUploadUrl(ctx.blobUploadUrls, {
    partition: ctx.partition,
    blobId: request.blobId,
    byteLength: request.byteLength,
    nowMs: clockOf(ctx)(),
  });
  return { url: issued.url, urlExpiresAtMs: issued.urlExpiresAtMs };
}
