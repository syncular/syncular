/**
 * Client-side blob cache + transport (SPEC.md §5.9.7).
 *
 * Blob bytes are cached by `blobId`. Retention reads live references directly
 * from `blob_ref` columns and keeps explicit pending-commit dependencies.
 * A small upload row queues each staged body for transfer before push.
 */
import { type BlobRef, parseBlobRef, serializeBlobRef } from '@syncular/core';
import type { ClientDatabase } from './database';
import { ClientSyncError } from './errors';
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
  const input =
    bytes.buffer instanceof ArrayBuffer
      ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      : bytes.slice();
  const digest = await crypto.subtle.digest(
    'SHA-256',
    input as Uint8Array<ArrayBuffer>,
  );
  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `sha256:${hex}`;
}

export function ensureBlobSchema(db: ClientDatabase): void {
  const existing = db.query(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_syncular_blobs'",
  );
  if (existing.length > 0) {
    const columns = db
      .query('PRAGMA table_info(_syncular_blobs)')
      .map((row) => row.name)
      .sort();
    const expected = [
      'blob_id',
      'byte_length',
      'bytes',
      'created_at_ms',
      'media_type',
    ].sort();
    if (
      columns.length !== expected.length ||
      columns.some((column, index) => column !== expected[index])
    ) {
      throw new ClientSyncError(
        'sync.schema_mismatch',
        'Local blob schema is incompatible',
      );
    }
  } else {
    db.exec(`CREATE TABLE _syncular_blobs(
      blob_id TEXT PRIMARY KEY,
      bytes BLOB NOT NULL,
      byte_length INTEGER NOT NULL,
      media_type TEXT,
      created_at_ms INTEGER NOT NULL)`);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS _syncular_blob_uploads(
    blob_id TEXT PRIMARY KEY, media_type TEXT, created_at_ms INTEGER NOT NULL)`);
}

/** Put bytes into the content-addressed cache without rewriting an existing body. */
export function putCachedBlob(
  db: ClientDatabase,
  blobId: string,
  bytes: Uint8Array,
  nowMs: number,
  mediaType?: string,
): void {
  db.exec(
    `INSERT INTO _syncular_blobs(
       blob_id, bytes, byte_length, media_type, created_at_ms)
     VALUES (?,?,?,?,?) ON CONFLICT(blob_id) DO NOTHING`,
    [blobId, bytes, bytes.length, mediaType ?? null, nowMs],
  );
}

export function getCachedBlob(
  db: ClientDatabase,
  blobId: string,
): CachedBlob | undefined {
  const rows = db.query(
    'SELECT bytes, byte_length, media_type FROM _syncular_blobs WHERE blob_id = ?',
    [blobId],
  );
  const row = rows[0];
  if (row === undefined) return undefined;
  return {
    blobId,
    bytes: row.bytes as Uint8Array,
    byteLength: Number(row.byte_length),
    ...(row.media_type !== null ? { mediaType: row.media_type as string } : {}),
  };
}

/**
 * §5.9.7 B1 size cap. When the sum of cached body sizes exceeds `maxBytes`,
 * evict unreferenced, non-pinned bodies by creation timestamp, then blob ID,
 * until back under the cap. Returns the evicted blobIds.
 */
export function enforceBlobCacheCap(
  db: ClientDatabase,
  schema: CompiledClientSchema,
  maxBytes: number,
): string[] {
  const totalRow = db.query(
    'SELECT COALESCE(SUM(byte_length), 0) AS total FROM _syncular_blobs',
  )[0];
  let total = Number(totalRow?.total ?? 0);
  if (total <= maxBytes) return [];
  // Oldest eligible body first, with blob ID as a stable tie.
  const candidates = db.query(
    `SELECT blob_id, byte_length FROM _syncular_blobs
     WHERE blob_id NOT IN (SELECT blob_id FROM _syncular_blob_uploads)
       AND blob_id NOT IN (SELECT blob_id FROM _syncular_blob_commit_refs)
       AND blob_id NOT IN (${visibleBlobIdsSql(schema)})
     ORDER BY created_at_ms ASC, blob_id ASC`,
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

export function listPendingUploads(
  db: ClientDatabase,
): { blobId: string; mediaType?: string }[] {
  return db
    .query(
      `SELECT blob_id, media_type FROM (
        SELECT blob_id, media_type, created_at_ms FROM _syncular_blob_uploads
        UNION ALL
        SELECT DISTINCT r.blob_id, b.media_type, 9223372036854775807 AS created_at_ms
        FROM _syncular_blob_commit_refs r LEFT JOIN _syncular_blobs b ON b.blob_id = r.blob_id
        WHERE NOT EXISTS (SELECT 1 FROM _syncular_blob_uploads u WHERE u.blob_id = r.blob_id)
      ) ORDER BY created_at_ms, blob_id`,
    )
    .map((row) => {
      if (
        typeof row.blob_id !== 'string' ||
        (row.media_type !== null && typeof row.media_type !== 'string')
      ) {
        throw new ClientSyncError(
          'sync.local_corrupt',
          'Pending blob upload metadata is invalid',
        );
      }
      return {
        blobId: row.blob_id,
        ...(row.media_type !== null ? { mediaType: row.media_type } : {}),
      };
    });
}

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

export function clearPendingUpload(db: ClientDatabase, blobId: string): void {
  db.exec('DELETE FROM _syncular_blob_uploads WHERE blob_id = ?', [blobId]);
}

/**
 * All `blob_ref` column names per table.
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

function visibleBlobIdsSql(schema: CompiledClientSchema): string {
  const selects: string[] = [];
  for (const [tableName, columns] of blobRefColumnsBySchema(schema)) {
    for (const column of columns) {
      const identifier = quoteIdent(column);
      selects.push(
        `SELECT json_extract(${identifier}, '$.blobId') AS blob_id
         FROM ${quoteIdent(tableName)}
         WHERE typeof(${identifier}) = 'text'
           AND json_valid(${identifier})
           AND json_type(${identifier}, '$.blobId') = 'text'`,
      );
    }
  }
  return selects.length === 0
    ? 'SELECT NULL AS blob_id WHERE 0'
    : selects.join(' UNION ');
}

export function deleteUnreferencedCachedBlobs(
  db: ClientDatabase,
  schema: CompiledClientSchema,
): void {
  db.exec(
    `DELETE FROM _syncular_blobs
     WHERE blob_id NOT IN (SELECT blob_id FROM _syncular_blob_uploads)
       AND blob_id NOT IN (SELECT blob_id FROM _syncular_blob_commit_refs)
       AND blob_id NOT IN (${visibleBlobIdsSql(schema)})`,
  );
}

export type { BlobRef };
export { parseBlobRef, serializeBlobRef };
