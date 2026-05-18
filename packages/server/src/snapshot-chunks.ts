/**
 * @syncular/server - Encoded snapshot chunk cache (server-side)
 *
 * Used for efficiently serving large bootstrap snapshots (e.g. catalogs)
 * without embedding huge JSON payloads into pull responses.
 */

import {
  isSyncSnapshotChunkEncoding,
  type ScopeValues,
  SYNC_SNAPSHOT_CHUNK_COMPRESSION,
  type SyncSnapshotChunkCompression,
  type SyncSnapshotChunkEncoding,
  type SyncSnapshotChunkRef,
  sha256Hex,
} from '@syncular/core';
import { type Kysely, sql } from 'kysely';
import type { SyncCoreDb } from './schema';

export interface SnapshotChunkPageKey {
  partitionId: string;
  scopeKey: string;
  scope: string;
  asOfCommitSeq: number;
  rowCursor: string | null;
  rowLimit: number;
  encoding: SyncSnapshotChunkEncoding;
  compression: SyncSnapshotChunkCompression;
}

export interface SnapshotChunkScopeCacheKeyInput {
  partitionId: string;
  scopes: ScopeValues;
  schemaVersion?: number | string | null;
  encoding: SyncSnapshotChunkEncoding;
  compression: SyncSnapshotChunkCompression;
  gzipLevel: number;
  features?: readonly string[];
}

export type SnapshotChunkRefWithContinuation = SyncSnapshotChunkRef & {
  nextRowCursor: string | null;
  isLastPage: boolean;
  body?: Uint8Array;
};

export interface SnapshotChunkRow {
  chunkId: string;
  partitionId: string;
  scopeKey: string;
  scope: string;
  asOfCommitSeq: number;
  rowCursor: string;
  rowLimit: number;
  nextRowCursor: string | null;
  isLastPage: boolean;
  encoding: SyncSnapshotChunkEncoding;
  compression: SyncSnapshotChunkCompression;
  sha256: string;
  byteLength: number;
  body: Uint8Array | ReadableStream<Uint8Array>;
  expiresAt: string;
}

type SnapshotChunkDbRow = {
  chunk_id: string;
  partition_id: string;
  scope_key: string;
  scope: string;
  as_of_commit_seq: number;
  row_cursor: string;
  row_limit: number;
  next_row_cursor: unknown;
  is_last_page: unknown;
  encoding: string;
  compression: string;
  sha256: string;
  byte_length: number;
  blob_hash: string;
  body?: unknown;
  expires_at: unknown;
};

function coerceOptionalString(value: unknown): string | null {
  if (value == null) return null;
  return String(value);
}

function coerceFlag(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

/**
 * Generate a stable cache key for snapshot chunks from effective scopes.
 */
export async function scopesToSnapshotChunkScopeKey(
  scopes: ScopeValues
): Promise<string> {
  const sorted = Object.entries(scopes)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => {
      const values = Array.isArray(value) ? [...value].sort() : [value];
      return `${key}:${values.join(',')}`;
    })
    .join('|');
  return sha256Hex(sorted);
}

/**
 * Generate the full server-side snapshot chunk cache key.
 *
 * The database page key also stores table, as-of commit, row cursor, row
 * limit, encoding, and compression as indexed columns. This scope key carries
 * the remaining semantic dimensions that otherwise invalidate all pages for a
 * subscription scope.
 */
export async function createSnapshotChunkScopeCacheKey(
  input: SnapshotChunkScopeCacheKeyInput
): Promise<string> {
  const scopeDigest = await scopesToSnapshotChunkScopeKey(input.scopes);
  const features = [...(input.features ?? [])].sort();
  const digest = await sha256Hex(
    JSON.stringify({
      version: 2,
      partitionId: input.partitionId,
      schemaVersion:
        input.schemaVersion === null || input.schemaVersion === undefined
          ? 'unversioned'
          : String(input.schemaVersion),
      encoding: input.encoding,
      compression: input.compression,
      gzipLevel: input.gzipLevel,
      features,
      scopeDigest,
    })
  );
  return `snapshot-v2:${digest}:scope:${scopeDigest}`;
}

function coerceChunkRow(value: unknown): Uint8Array {
  // pg returns Buffer (subclass of Uint8Array); sqlite returns Uint8Array
  if (value instanceof Uint8Array) return value;
  if (typeof Buffer !== 'undefined' && value instanceof Buffer) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value) && value.every((v) => typeof v === 'number')) {
    return new Uint8Array(value);
  }
  throw new Error(
    `Unexpected snapshot chunk body type: ${Object.prototype.toString.call(value)}`
  );
}

function coerceIsoString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export async function readSnapshotChunkRefByPageKey<DB extends SyncCoreDb>(
  db: Kysely<DB>,
  args: SnapshotChunkPageKey & { nowIso?: string; includeBody?: boolean }
): Promise<SnapshotChunkRefWithContinuation | null> {
  const nowIso = args.nowIso ?? new Date().toISOString();
  const rowCursorKey = args.rowCursor ?? '';

  type PageKeyRow = {
    chunk_id: string;
    sha256: string;
    byte_length: number;
    next_row_cursor: unknown;
    is_last_page: unknown;
    encoding: string;
    compression: string;
    body?: unknown;
  };

  const rowResult = args.includeBody
    ? await sql<PageKeyRow>`
        select
          chunk_id,
          sha256,
          byte_length,
          next_row_cursor,
          is_last_page,
          encoding,
          compression,
          body
        from ${sql.table('sync_snapshot_chunks')}
        where
          partition_id = ${args.partitionId}
          and scope_key = ${args.scopeKey}
          and scope = ${args.scope}
          and as_of_commit_seq = ${args.asOfCommitSeq}
          and row_cursor = ${rowCursorKey}
          and row_limit = ${args.rowLimit}
          and encoding = ${args.encoding}
          and compression = ${args.compression}
          and expires_at > ${nowIso}
        limit 1
      `.execute(db)
    : await sql<PageKeyRow>`
        select
          chunk_id,
          sha256,
          byte_length,
          next_row_cursor,
          is_last_page,
          encoding,
          compression
        from ${sql.table('sync_snapshot_chunks')}
        where
          partition_id = ${args.partitionId}
          and scope_key = ${args.scopeKey}
          and scope = ${args.scope}
          and as_of_commit_seq = ${args.asOfCommitSeq}
          and row_cursor = ${rowCursorKey}
          and row_limit = ${args.rowLimit}
          and encoding = ${args.encoding}
          and compression = ${args.compression}
          and expires_at > ${nowIso}
        limit 1
      `.execute(db);
  const row = rowResult.rows[0];

  if (!row) return null;

  if (row.encoding !== args.encoding) {
    throw new Error(
      `Unexpected snapshot chunk encoding: ${String(row.encoding)}`
    );
  }
  if (row.compression !== SYNC_SNAPSHOT_CHUNK_COMPRESSION) {
    throw new Error(
      `Unexpected snapshot chunk compression: ${String(row.compression)}`
    );
  }

  const ref: SnapshotChunkRefWithContinuation = {
    id: row.chunk_id,
    sha256: row.sha256,
    byteLength: Number(row.byte_length ?? 0),
    nextRowCursor: coerceOptionalString(row.next_row_cursor),
    isLastPage: coerceFlag(row.is_last_page),
    encoding: args.encoding,
    compression: row.compression,
  };
  if (args.includeBody && row.body) {
    ref.body = coerceChunkRow(row.body);
  }
  return ref;
}

export async function insertSnapshotChunk<DB extends SyncCoreDb>(
  db: Kysely<DB>,
  args: {
    chunkId: string;
    partitionId: string;
    scopeKey: string;
    scope: string;
    asOfCommitSeq: number;
    rowCursor: string | null;
    rowLimit: number;
    nextRowCursor?: string | null;
    isLastPage?: boolean;
    encoding: SyncSnapshotChunkEncoding;
    compression: SyncSnapshotChunkCompression;
    sha256: string;
    body: Uint8Array;
    expiresAt: string;
  }
): Promise<SnapshotChunkRefWithContinuation> {
  const now = new Date().toISOString();
  const rowCursorKey = args.rowCursor ?? '';

  // Use content hash as blob_hash for legacy storage in DB
  const blobHash = `sha256:${args.sha256}`;

  await sql`
    insert into ${sql.table('sync_snapshot_chunks')} (
      chunk_id,
      partition_id,
      scope_key,
      scope,
      as_of_commit_seq,
      row_cursor,
      row_limit,
      next_row_cursor,
      is_last_page,
      encoding,
      compression,
      sha256,
      byte_length,
      blob_hash,
      body,
      created_at,
      expires_at
    )
    values (
      ${args.chunkId},
      ${args.partitionId},
      ${args.scopeKey},
      ${args.scope},
      ${args.asOfCommitSeq},
      ${rowCursorKey},
      ${args.rowLimit},
      ${args.nextRowCursor ?? null},
      ${args.isLastPage ? 1 : 0},
      ${args.encoding},
      ${args.compression},
      ${args.sha256},
      ${args.body.length},
      ${blobHash},
      ${args.body},
      ${now},
      ${args.expiresAt}
    )
    on conflict (
      partition_id,
      scope_key,
      scope,
      as_of_commit_seq,
      row_cursor,
      row_limit,
      encoding,
      compression
    )
    do update set
      expires_at = ${args.expiresAt},
      next_row_cursor = ${args.nextRowCursor ?? null},
      is_last_page = ${args.isLastPage ? 1 : 0},
      blob_hash = ${blobHash}
  `.execute(db);

  const ref = await readSnapshotChunkRefByPageKey(db, {
    partitionId: args.partitionId,
    scopeKey: args.scopeKey,
    scope: args.scope,
    asOfCommitSeq: args.asOfCommitSeq,
    rowCursor: args.rowCursor,
    rowLimit: args.rowLimit,
    encoding: args.encoding,
    compression: args.compression,
    includeBody: true,
  });

  if (!ref) {
    throw new Error('Failed to read inserted snapshot chunk');
  }

  return ref;
}

export async function readSnapshotChunk<DB extends SyncCoreDb>(
  db: Kysely<DB>,
  chunkId: string,
  options?: {
    /** External chunk storage for reading from S3/R2/etc */
    chunkStorage?: {
      readChunk(chunkId: string): Promise<Uint8Array | null>;
      readChunkStream?(
        chunkId: string
      ): Promise<ReadableStream<Uint8Array> | null>;
    };
  }
): Promise<SnapshotChunkRow | null> {
  const includeBody = !options?.chunkStorage;
  const rowResult = includeBody
    ? await sql<SnapshotChunkDbRow>`
        select
          chunk_id,
          partition_id,
          scope_key,
          scope,
          as_of_commit_seq,
          row_cursor,
          row_limit,
          next_row_cursor,
          is_last_page,
          encoding,
          compression,
          sha256,
          byte_length,
          blob_hash,
          body,
          expires_at
        from ${sql.table('sync_snapshot_chunks')}
        where chunk_id = ${chunkId}
        limit 1
      `.execute(db)
    : await sql<SnapshotChunkDbRow>`
        select
          chunk_id,
          partition_id,
          scope_key,
          scope,
          as_of_commit_seq,
          row_cursor,
          row_limit,
          next_row_cursor,
          is_last_page,
          encoding,
          compression,
          sha256,
          byte_length,
          blob_hash,
          expires_at
        from ${sql.table('sync_snapshot_chunks')}
        where chunk_id = ${chunkId}
        limit 1
      `.execute(db);
  const row = rowResult.rows[0];

  if (!row) return null;

  if (!isSyncSnapshotChunkEncoding(row.encoding)) {
    throw new Error(
      `Unexpected snapshot chunk encoding: ${String(row.encoding)}`
    );
  }
  if (row.compression !== SYNC_SNAPSHOT_CHUNK_COMPRESSION) {
    throw new Error(
      `Unexpected snapshot chunk compression: ${String(row.compression)}`
    );
  }

  // Read body from external storage if available, otherwise use inline body
  let body: Uint8Array | ReadableStream<Uint8Array>;
  if (options?.chunkStorage) {
    if (options.chunkStorage.readChunkStream) {
      const externalBodyStream =
        await options.chunkStorage.readChunkStream(chunkId);
      if (externalBodyStream) {
        body = externalBodyStream;
      } else {
        const externalBody = await options.chunkStorage.readChunk(chunkId);
        if (externalBody) {
          body = externalBody;
        } else {
          const legacyBody = await readLegacySnapshotChunkBody(db, chunkId);
          if (!legacyBody) {
            throw new Error(`Snapshot chunk body missing for chunk ${chunkId}`);
          }
          body = legacyBody;
        }
      }
    } else {
      const externalBody = await options.chunkStorage.readChunk(chunkId);
      if (externalBody) {
        body = externalBody;
      } else {
        const legacyBody = await readLegacySnapshotChunkBody(db, chunkId);
        if (!legacyBody) {
          throw new Error(`Snapshot chunk body missing for chunk ${chunkId}`);
        }
        body = legacyBody;
      }
    }
  } else {
    if (row.body) {
      body = coerceChunkRow(row.body);
    } else {
      const legacyBody = await readLegacySnapshotChunkBody(db, chunkId);
      if (legacyBody) {
        body = legacyBody;
      } else {
        throw new Error(`Snapshot chunk body missing for chunk ${chunkId}`);
      }
    }
  }

  return {
    chunkId: row.chunk_id,
    partitionId: row.partition_id,
    scopeKey: row.scope_key,
    scope: row.scope,
    asOfCommitSeq: Number(row.as_of_commit_seq ?? 0),
    rowCursor: row.row_cursor,
    rowLimit: Number(row.row_limit ?? 0),
    nextRowCursor: coerceOptionalString(row.next_row_cursor),
    isLastPage: coerceFlag(row.is_last_page),
    encoding: row.encoding,
    compression: row.compression,
    sha256: row.sha256,
    byteLength: Number(row.byte_length ?? 0),
    body,
    expiresAt: coerceIsoString(row.expires_at),
  };
}

async function readLegacySnapshotChunkBody<DB extends SyncCoreDb>(
  db: Kysely<DB>,
  chunkId: string
): Promise<Uint8Array | null> {
  const rowResult = await sql<{ body: unknown }>`
    select body
    from ${sql.table('sync_snapshot_chunks')}
    where chunk_id = ${chunkId}
    limit 1
  `.execute(db);
  const body = rowResult.rows[0]?.body;
  return body ? coerceChunkRow(body) : null;
}

export async function deleteExpiredSnapshotChunks<DB extends SyncCoreDb>(
  db: Kysely<DB>,
  nowIso = new Date().toISOString()
): Promise<number> {
  const res = await sql`
    delete from ${sql.table('sync_snapshot_chunks')}
    where expires_at <= ${nowIso}
  `.execute(db);

  return Number(res.numAffectedRows ?? 0);
}
