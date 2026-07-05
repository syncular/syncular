/**
 * Client-side blob cache + transport (SPEC.md §5.9.7).
 *
 * Blob bytes are cached content-addressed by `blobId` and refcounted by the
 * local rows whose `blob_ref` columns reference them (B1). The cache is
 * derived from live-row references: after any apply/purge, refcounts are
 * reconciled from the current `blob_ref` column contents, and a body whose
 * only referencing rows were revocation-purged is deleted (B2, evicted ≠
 * revoked). BlobRefs stay resolvable at any time (B3): the `blobId` in the
 * row value is the whole download key. Pending uploads are tracked in the
 * outbox-adjacent uploads table (B4) and flushed before push.
 */
import { type BlobRef, parseBlobRef, serializeBlobRef } from '@syncular/core';
import type { ClientDatabase } from './database';
import type { CompiledClientSchema } from './schema';
import { quoteIdent } from './schema';

/**
 * A blob download result (§5.9.5). The authorized endpoint either serves the
 * bytes inline, or — when the host configured presigned URLs (always-issue) —
 * returns a short-TTL `url` the client MUST fetch directly (no host auth),
 * verify the content address on, and on failure re-request (never fall
 * through). The client core routes on which arm is present.
 */
export type BlobDownloadResponse =
  | { readonly kind: 'bytes'; readonly bytes: Uint8Array }
  | {
      readonly kind: 'url';
      readonly url: string;
      readonly urlExpiresAtMs?: number;
    };

/**
 * A presigned-upload grant (§5.9.3). Either a single PUT `url` the client uses
 * direct-to-storage; or `present` (the blob already exists, skip the PUT); or
 * `none` (no presigned-upload store — the client streams through the direct
 * upload endpoint, a capability choice, not a fallback).
 */
export type BlobUploadGrant =
  | {
      readonly kind: 'url';
      readonly url: string;
      readonly urlExpiresAtMs?: number;
    }
  | { readonly kind: 'present' }
  | { readonly kind: 'none' };

/** The transport seam for blob upload/download (§5.9.3/§5.9.5). */
export interface BlobTransport {
  /** `PUT <mount>/blobs/{blobId}` — host-authenticated direct upload (§5.9.3). */
  upload(blobId: string, bytes: Uint8Array, mediaType?: string): Promise<void>;
  /**
   * `GET <mount>/blobs/{blobId}` — re-authorized (§5.9.5). Returns inline
   * bytes, or a presigned `url` the client core fetches via `fetchUrl`.
   */
  download(blobId: string): Promise<BlobDownloadResponse>;
  /**
   * §5.9.5 presigned-download fetch: a bare GET of the signed `url`. Present
   * iff the transport can consume URLs. MUST attach NO host authentication —
   * the URL is the entire grant (§5.4). Only called when `download` returned
   * a `url` arm.
   */
  fetchUrl?(url: string): Promise<Uint8Array>;
  /**
   * §5.9.3 presigned-upload grant: `POST /blobs/{blobId}/upload-grant` with
   * the declared size. Present iff the transport supports the grant flow;
   * absent ⇒ the client always streams through `upload`. A `url` grant is
   * PUT via `uploadToUrl`.
   */
  uploadGrant?(
    blobId: string,
    byteLength: number,
    mediaType?: string,
  ): Promise<BlobUploadGrant>;
  /**
   * §5.9.3 direct-to-storage PUT of the granted `url`. MUST attach NO host
   * authentication — the presigned URL is the entire grant (§5.4). Only
   * called when `uploadGrant` returned a `url` arm.
   */
  uploadToUrl?(
    url: string,
    bytes: Uint8Array,
    mediaType?: string,
  ): Promise<void>;
}

export interface CachedBlob {
  readonly blobId: string;
  readonly bytes: Uint8Array;
  readonly byteLength: number;
  readonly mediaType?: string;
}

/** `"sha256:" + hex` of the bytes — the content address (§5.9.1). */
export async function computeBlobId(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    bytes.slice().buffer as ArrayBuffer,
  );
  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `sha256:${hex}`;
}

export function ensureBlobSchema(db: ClientDatabase): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _syncular_blobs(
    blob_id TEXT PRIMARY KEY,
    bytes BLOB NOT NULL,
    byte_length INTEGER NOT NULL,
    media_type TEXT,
    refcount INTEGER NOT NULL DEFAULT 0,
    created_at_ms INTEGER NOT NULL,
    last_used_ms INTEGER NOT NULL DEFAULT 0)`);
  // Migrate a cache created before the §5.9.7 B1 LRU column: additive,
  // idempotent (a duplicate-column error on an already-migrated DB is
  // swallowed). last_used_ms drives cap eviction (LRU of zero-ref bodies).
  try {
    db.exec(
      'ALTER TABLE _syncular_blobs ADD COLUMN last_used_ms INTEGER NOT NULL DEFAULT 0',
    );
  } catch {
    // column already exists — the CREATE above included it
  }
  db.exec(`CREATE TABLE IF NOT EXISTS _syncular_blob_uploads(
    blob_id TEXT PRIMARY KEY,
    media_type TEXT,
    created_at_ms INTEGER NOT NULL)`);
}

/** Put bytes into the content-addressed cache (idempotent); touches LRU. */
export function putCachedBlob(
  db: ClientDatabase,
  blobId: string,
  bytes: Uint8Array,
  nowMs: number,
  mediaType?: string,
): void {
  db.exec(
    `INSERT INTO _syncular_blobs(
       blob_id, bytes, byte_length, media_type, refcount, created_at_ms, last_used_ms)
     VALUES (?,?,?,?,0,?,?)
     ON CONFLICT(blob_id) DO UPDATE SET last_used_ms = excluded.last_used_ms`,
    [blobId, bytes, bytes.length, mediaType ?? null, nowMs, nowMs],
  );
}

export function getCachedBlob(
  db: ClientDatabase,
  blobId: string,
  nowMs?: number,
): CachedBlob | undefined {
  const rows = db.query(
    'SELECT bytes, byte_length, media_type FROM _syncular_blobs WHERE blob_id = ?',
    [blobId],
  );
  const row = rows[0];
  if (row === undefined) return undefined;
  // §5.9.7 B1 LRU: a cache-hit read touches "recently used" so a hot image
  // survives a cap trim. Skipped when no clock is supplied (pure read).
  if (nowMs !== undefined) {
    db.exec('UPDATE _syncular_blobs SET last_used_ms = ? WHERE blob_id = ?', [
      nowMs,
      blobId,
    ]);
  }
  return {
    blobId,
    bytes: row.bytes as Uint8Array,
    byteLength: Number(row.byte_length),
    ...(row.media_type !== null ? { mediaType: row.media_type as string } : {}),
  };
}

/**
 * §5.9.7 B1 size cap + LRU eviction. When the sum of cached body sizes exceeds
 * `maxBytes`, evict **zero-ref, non-pinned** bodies in least-recently-used
 * order until back under the cap. NEVER evicts a referenced body (refcount > 0
 * — it must stay resolvable without a re-download) nor a pending-upload-pinned
 * body (its bytes are the only copy until push, B4). If every over-cap body is
 * referenced or pinned, the cache stays over the cap (correctness beats the
 * cap). Evicting a zero-ref body is always safe: B3 re-enables the fetch from
 * any surviving `blob_ref` value. Returns the evicted blobIds.
 */
export function enforceBlobCacheCap(
  db: ClientDatabase,
  maxBytes: number,
): string[] {
  const totalRow = db.query(
    'SELECT COALESCE(SUM(byte_length), 0) AS total FROM _syncular_blobs',
  )[0];
  let total = Number(totalRow?.total ?? 0);
  if (total <= maxBytes) return [];
  // Eviction candidates: zero-ref AND not pinned by a pending upload, oldest
  // (LRU) first, then oldest created as a stable tiebreak.
  const candidates = db.query(
    `SELECT blob_id, byte_length FROM _syncular_blobs
     WHERE refcount = 0
       AND blob_id NOT IN (SELECT blob_id FROM _syncular_blob_uploads)
     ORDER BY last_used_ms ASC, created_at_ms ASC`,
  );
  const evicted: string[] = [];
  db.transaction(() => {
    for (const row of candidates) {
      if (total <= maxBytes) break;
      const blobId = row.blob_id as string;
      db.exec('DELETE FROM _syncular_blobs WHERE blob_id = ?', [blobId]);
      total -= Number(row.byte_length);
      evicted.push(blobId);
    }
  });
  return evicted;
}

/** Record a pending upload (§5.9.7 B4); flushed before the next push. */
export function recordPendingUpload(
  db: ClientDatabase,
  blobId: string,
  nowMs: number,
  mediaType?: string,
): void {
  db.exec(
    `INSERT OR IGNORE INTO _syncular_blob_uploads(blob_id, media_type, created_at_ms)
     VALUES (?,?,?)`,
    [blobId, mediaType ?? null, nowMs],
  );
}

export function listPendingUploads(
  db: ClientDatabase,
): { blobId: string; mediaType?: string }[] {
  return db
    .query(
      'SELECT blob_id, media_type FROM _syncular_blob_uploads ORDER BY created_at_ms',
    )
    .map((row) => ({
      blobId: row.blob_id as string,
      ...(row.media_type !== null
        ? { mediaType: row.media_type as string }
        : {}),
    }));
}

export function clearPendingUpload(db: ClientDatabase, blobId: string): void {
  db.exec('DELETE FROM _syncular_blob_uploads WHERE blob_id = ?', [blobId]);
}

/**
 * All `blob_ref` column names per table (for refcount reconciliation).
 * Blank result ⇒ the schema has no attachments; callers skip reconciliation.
 */
export function blobRefColumnsBySchema(
  schema: CompiledClientSchema,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const table of schema.tables.values()) {
    const cols = table.columns
      .filter((c) => c.type === 'blob_ref')
      .map((c) => c.name);
    if (cols.length > 0) out.set(table.name, cols);
  }
  return out;
}

export function schemaHasBlobs(schema: CompiledClientSchema): boolean {
  for (const table of schema.tables.values()) {
    if (table.columns.some((c) => c.type === 'blob_ref')) return true;
  }
  return false;
}

/**
 * §5.9.7 B1/B2: recompute cache refcounts from the current `blob_ref` column
 * contents across all synced tables, then delete cache bodies that dropped
 * to zero refs *and* have no pending upload (a pending upload pins its body,
 * B4). Called after every apply/purge that may add or remove references.
 *
 * `deleteOrphans` distinguishes the two B2 transitions: revocation purge
 * passes `true` (drop the now-unauthorized body); a benign apply passes
 * `false` (retain zero-ref bodies as LRU cache entries — the shipped
 * default). Bodies pinned by a pending upload are always retained.
 */
export function reconcileBlobRefcounts(
  db: ClientDatabase,
  schema: CompiledClientSchema,
  options?: { readonly deleteOrphans?: boolean },
): void {
  const byTable = blobRefColumnsBySchema(schema);
  if (byTable.size === 0) return;
  // Count references to each blobId across every blob_ref column.
  const counts = new Map<string, number>();
  for (const [tableName, columns] of byTable) {
    for (const column of columns) {
      const rows = db.query(
        `SELECT ${quoteIdent(column)} AS v FROM ${quoteIdent(tableName)}
         WHERE ${quoteIdent(column)} IS NOT NULL`,
      );
      for (const row of rows) {
        const raw = row.v;
        if (typeof raw !== 'string') continue;
        let ref: BlobRef;
        try {
          ref = parseBlobRef(raw);
        } catch {
          continue;
        }
        counts.set(ref.blobId, (counts.get(ref.blobId) ?? 0) + 1);
      }
    }
  }
  db.transaction(() => {
    // Reset all refcounts, then apply the recomputed counts.
    db.exec('UPDATE _syncular_blobs SET refcount = 0');
    for (const [blobId, count] of counts) {
      db.exec('UPDATE _syncular_blobs SET refcount = ? WHERE blob_id = ?', [
        count,
        blobId,
      ]);
    }
    if (options?.deleteOrphans === true) {
      // §5.9.7 B2 revocation side: delete zero-ref bodies not pinned by a
      // pending upload.
      db.exec(
        `DELETE FROM _syncular_blobs
         WHERE refcount = 0
           AND blob_id NOT IN (SELECT blob_id FROM _syncular_blob_uploads)`,
      );
    }
  });
}

export type { BlobRef };
export { parseBlobRef, serializeBlobRef };
