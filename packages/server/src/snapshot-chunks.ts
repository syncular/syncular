/**
 * @syncular/server - Encoded snapshot chunk cache (server-side)
 *
 * Used for efficiently serving large bootstrap snapshots (e.g. catalogs)
 * without embedding huge JSON payloads into pull responses.
 */

import {
  SYNC_SNAPSHOT_CHUNK_COMPRESSION,
  SYNC_SNAPSHOT_CHUNK_ENCODING,
  type SyncSnapshotChunkCompression,
  type SyncSnapshotChunkEncoding,
  type SyncSnapshotChunkRef,
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

export interface SnapshotChunkRow {
  chunkId: string;
  partitionId: string;
  scopeKey: string;
  scope: string;
  asOfCommitSeq: number;
  rowCursor: string;
  rowLimit: number;
  encoding: SyncSnapshotChunkEncoding;
  compression: SyncSnapshotChunkCompression;
  sha256: string;
  byteLength: number;
  body: Uint8Array | ReadableStream<Uint8Array>;
  expiresAt: string;
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
  args: SnapshotChunkPageKey & { nowIso?: string }
): Promise<SyncSnapshotChunkRef | null> {
  const nowIso = args.nowIso ?? new Date().toISOString();
  const rowCursorKey = args.rowCursor ?? '';

  const rowResult = await sql<{
    chunk_id: string;
    sha256: string;
    byte_length: number;
    encoding: string;
    compression: string;
  }>`
    select chunk_id, sha256, byte_length, encoding, compression
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

  if (row.encoding !== SYNC_SNAPSHOT_CHUNK_ENCODING) {
    throw new Error(
      `Unexpected snapshot chunk encoding: ${String(row.encoding)}`
    );
  }
  if (row.compression !== SYNC_SNAPSHOT_CHUNK_COMPRESSION) {
    throw new Error(
      `Unexpected snapshot chunk compression: ${String(row.compression)}`
    );
  }

  return {
    id: row.chunk_id,
    sha256: row.sha256,
    byteLength: Number(row.byte_length ?? 0),
    encoding: row.encoding,
    compression: row.compression,
  };
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
    encoding: SyncSnapshotChunkEncoding;
    compression: SyncSnapshotChunkCompression;
    sha256: string;
    body: Uint8Array;
    expiresAt: string;
  }
): Promise<SyncSnapshotChunkRef> {
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
  const rowResult = await sql<{
    chunk_id: string;
    partition_id: string;
    scope_key: string;
    scope: string;
    as_of_commit_seq: number;
    row_cursor: string;
    row_limit: number;
    encoding: string;
    compression: string;
    sha256: string;
    byte_length: number;
    blob_hash: string;
    body: unknown;
    expires_at: unknown;
  }>`
    select
      chunk_id,
      partition_id,
      scope_key,
      scope,
      as_of_commit_seq,
      row_cursor,
      row_limit,
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
  `.execute(db);
  const row = rowResult.rows[0];

  if (!row) return null;

  if (row.encoding !== SYNC_SNAPSHOT_CHUNK_ENCODING) {
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
        } else if (row.body) {
          body = coerceChunkRow(row.body);
        } else {
          throw new Error(`Snapshot chunk body missing for chunk ${chunkId}`);
        }
      }
    } else {
      const externalBody = await options.chunkStorage.readChunk(chunkId);
      if (externalBody) {
        body = externalBody;
      } else if (row.body) {
        body = coerceChunkRow(row.body);
      } else {
        throw new Error(`Snapshot chunk body missing for chunk ${chunkId}`);
      }
    }
  } else {
    body = coerceChunkRow(row.body);
  }

  return {
    chunkId: row.chunk_id,
    partitionId: row.partition_id,
    scopeKey: row.scope_key,
    scope: row.scope,
    asOfCommitSeq: Number(row.as_of_commit_seq ?? 0),
    rowCursor: row.row_cursor,
    rowLimit: Number(row.row_limit ?? 0),
    encoding: row.encoding,
    compression: row.compression,
    sha256: row.sha256,
    byteLength: Number(row.byte_length ?? 0),
    body,
    expiresAt: coerceIsoString(row.expires_at),
  };
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
