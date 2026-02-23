/**
 * @syncular/server - Database-backed metadata store for snapshot chunks
 *
 * Stores chunk metadata in sync_snapshot_chunks_metadata table,
 * body content in blob storage adapter.
 */

import {
  type BlobStorageAdapter,
  randomId,
  SYNC_SNAPSHOT_CHUNK_COMPRESSION,
  SYNC_SNAPSHOT_CHUNK_ENCODING,
  type SyncSnapshotChunkCompression,
  type SyncSnapshotChunkEncoding,
  type SyncSnapshotChunkRef,
  sha256Hex,
} from '@syncular/core';
import type { Kysely } from 'kysely';
import type { SyncCoreDb } from '../schema';
import type { SnapshotChunkMetadata, SnapshotChunkPageKey } from './types';

export interface DbMetadataSnapshotChunkStorageOptions {
  /** Database instance */
  db: Kysely<SyncCoreDb>;
  /** Blob storage adapter for body content */
  blobAdapter: BlobStorageAdapter;
  /** Optional prefix for chunk IDs */
  chunkIdPrefix?: string;
}

/**
 * Create a snapshot chunk storage that uses:
 * - Database for metadata (scope, commit seq, etc.)
 * - Blob adapter for body content
 */
export function createDbMetadataChunkStorage(
  options: DbMetadataSnapshotChunkStorageOptions
): {
  name: string;
  storeChunk: (
    metadata: Omit<
      SnapshotChunkMetadata,
      'chunkId' | 'byteLength' | 'blobHash'
    > & {
      body: Uint8Array;
    }
  ) => Promise<SyncSnapshotChunkRef>;
  storeChunkStream: (
    metadata: Omit<
      SnapshotChunkMetadata,
      'chunkId' | 'byteLength' | 'blobHash'
    > & {
      bodyStream: ReadableStream<Uint8Array>;
      byteLength?: number;
    }
  ) => Promise<SyncSnapshotChunkRef>;
  readChunk: (chunkId: string) => Promise<Uint8Array | null>;
  readChunkStream: (
    chunkId: string
  ) => Promise<ReadableStream<Uint8Array> | null>;
  findChunk: (
    pageKey: SnapshotChunkPageKey
  ) => Promise<SyncSnapshotChunkRef | null>;
  cleanupExpired: (beforeIso: string) => Promise<number>;
} {
  const { db, blobAdapter, chunkIdPrefix = 'chunk_' } = options;

  // Generate deterministic blob hash from chunk identity metadata.
  async function computeBlobHash(metadata: {
    encoding: SyncSnapshotChunkEncoding;
    compression: SyncSnapshotChunkCompression;
    sha256: string;
  }): Promise<string> {
    const digest = await sha256Hex(
      `${metadata.encoding}:${metadata.compression}:${metadata.sha256}`
    );
    return `sha256:${digest}`;
  }

  function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }

  async function streamToBytes(
    stream: ReadableStream<Uint8Array>
  ): Promise<Uint8Array> {
    const reader = stream.getReader();
    try {
      const chunks: Uint8Array[] = [];
      let total = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        chunks.push(value);
        total += value.length;
      }

      const out = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
      }
      return out;
    } finally {
      reader.releaseLock();
    }
  }

  async function streamByteLength(
    stream: ReadableStream<Uint8Array>
  ): Promise<number> {
    const reader = stream.getReader();
    try {
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.length;
      }
      return total;
    } finally {
      reader.releaseLock();
    }
  }

  // Generate unique chunk ID
  function generateChunkId(): string {
    return `${chunkIdPrefix}${randomId()}`;
  }

  async function readStoredRef(args: {
    partitionId: string;
    scopeKey: string;
    scope: string;
    asOfCommitSeq: number;
    rowCursor: string | null;
    rowLimit: number;
    encoding: SyncSnapshotChunkEncoding;
    compression: SyncSnapshotChunkCompression;
    nowIso?: string;
    includeExpired?: boolean;
  }): Promise<SyncSnapshotChunkRef | null> {
    const nowIso = args.nowIso ?? new Date().toISOString();
    const rowCursorKey = args.rowCursor ?? '';
    const baseQuery = db
      .selectFrom('sync_snapshot_chunks')
      .select(['chunk_id', 'sha256', 'byte_length', 'encoding', 'compression'])
      .where('partition_id', '=', args.partitionId)
      .where('scope_key', '=', args.scopeKey)
      .where('scope', '=', args.scope)
      .where('as_of_commit_seq', '=', args.asOfCommitSeq)
      .where('row_cursor', '=', rowCursorKey)
      .where('row_limit', '=', args.rowLimit)
      .where('encoding', '=', args.encoding)
      .where('compression', '=', args.compression);

    const row = await (args.includeExpired
      ? baseQuery.executeTakeFirst()
      : baseQuery.where('expires_at', '>', nowIso).executeTakeFirst());

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

  async function readBlobHash(chunkId: string): Promise<string | null> {
    const row = await db
      .selectFrom('sync_snapshot_chunks')
      .select(['blob_hash'])
      .where('chunk_id', '=', chunkId)
      .executeTakeFirst();
    return row?.blob_hash ?? null;
  }

  async function upsertChunkMetadata(
    metadata: Omit<
      SnapshotChunkMetadata,
      'chunkId' | 'byteLength' | 'blobHash'
    >,
    args: { blobHash: string; byteLength: number }
  ): Promise<void> {
    const chunkId = generateChunkId();
    const now = new Date().toISOString();

    await db
      .insertInto('sync_snapshot_chunks')
      .values({
        chunk_id: chunkId,
        partition_id: metadata.partitionId,
        scope_key: metadata.scopeKey,
        scope: metadata.scope,
        as_of_commit_seq: metadata.asOfCommitSeq,
        row_cursor: metadata.rowCursor ?? '',
        row_limit: metadata.rowLimit,
        encoding: metadata.encoding,
        compression: metadata.compression,
        sha256: metadata.sha256,
        byte_length: args.byteLength,
        blob_hash: args.blobHash,
        expires_at: metadata.expiresAt,
        created_at: now,
      })
      .onConflict((oc) =>
        oc
          .columns([
            'partition_id',
            'scope_key',
            'scope',
            'as_of_commit_seq',
            'row_cursor',
            'row_limit',
            'encoding',
            'compression',
          ])
          .doUpdateSet({
            expires_at: metadata.expiresAt,
            blob_hash: args.blobHash,
            sha256: metadata.sha256,
            byte_length: args.byteLength,
            row_cursor: metadata.rowCursor ?? '',
          })
      )
      .execute();
  }

  async function readChunkStreamById(
    chunkId: string
  ): Promise<ReadableStream<Uint8Array> | null> {
    const blobHash = await readBlobHash(chunkId);
    if (!blobHash) return null;

    if (blobAdapter.getStream) {
      return blobAdapter.getStream(blobHash);
    }

    if (blobAdapter.get) {
      const bytes = await blobAdapter.get(blobHash);
      return bytes ? bytesToStream(bytes) : null;
    }

    throw new Error(
      `Blob adapter ${blobAdapter.name} does not support direct get() for snapshot chunks`
    );
  }

  return {
    name: `db-metadata+${blobAdapter.name}`,

    async storeChunk(
      metadata: Omit<
        SnapshotChunkMetadata,
        'chunkId' | 'byteLength' | 'blobHash'
      > & {
        body: Uint8Array;
      }
    ): Promise<SyncSnapshotChunkRef> {
      const { body, ...metaWithoutBody } = metadata;
      const blobHash = await computeBlobHash(metaWithoutBody);

      // Check if blob already exists (content-addressed dedup)
      const blobExists = await blobAdapter.exists(blobHash);

      if (!blobExists) {
        // Store body in blob adapter
        if (blobAdapter.put) {
          await blobAdapter.put(blobHash, body, {
            disableChecksum: true,
            byteLength: body.length,
            contentLength: body.length,
          });
        } else if (blobAdapter.putStream) {
          await blobAdapter.putStream(blobHash, bytesToStream(body), {
            disableChecksum: true,
            byteLength: body.length,
            contentLength: body.length,
          });
        } else {
          throw new Error(
            `Blob adapter ${blobAdapter.name} does not support direct put() for snapshot chunks`
          );
        }
      }

      await upsertChunkMetadata(metaWithoutBody, {
        blobHash,
        byteLength: body.length,
      });

      const storedRef = await readStoredRef({
        partitionId: metaWithoutBody.partitionId,
        scopeKey: metaWithoutBody.scopeKey,
        scope: metaWithoutBody.scope,
        asOfCommitSeq: metaWithoutBody.asOfCommitSeq,
        rowCursor: metaWithoutBody.rowCursor,
        rowLimit: metaWithoutBody.rowLimit,
        encoding: metaWithoutBody.encoding,
        compression: metaWithoutBody.compression,
        includeExpired: true,
      });

      if (!storedRef) {
        throw new Error('Failed to read stored snapshot chunk reference');
      }

      return storedRef;
    },

    async storeChunkStream(
      metadata: Omit<
        SnapshotChunkMetadata,
        'chunkId' | 'byteLength' | 'blobHash'
      > & {
        bodyStream: ReadableStream<Uint8Array>;
        byteLength?: number;
      }
    ): Promise<SyncSnapshotChunkRef> {
      const { bodyStream, byteLength, ...metaWithoutBody } = metadata;
      const blobHash = await computeBlobHash(metaWithoutBody);

      const blobExists = await blobAdapter.exists(blobHash);
      let observedByteLength: number;

      if (!blobExists) {
        if (blobAdapter.putStream) {
          const [uploadStream, countStream] = bodyStream.tee();
          const uploadPromise =
            typeof byteLength === 'number'
              ? blobAdapter.putStream(blobHash, uploadStream, {
                  disableChecksum: true,
                  byteLength,
                  contentLength: byteLength,
                })
              : blobAdapter.putStream(blobHash, uploadStream, {
                  disableChecksum: true,
                });
          const countPromise = streamByteLength(countStream);

          const [, countedByteLength] = await Promise.all([
            uploadPromise,
            countPromise,
          ]);
          observedByteLength = countedByteLength;
        } else if (blobAdapter.put) {
          const body = await streamToBytes(bodyStream);
          await blobAdapter.put(blobHash, body);
          observedByteLength = body.length;
        } else {
          throw new Error(
            `Blob adapter ${blobAdapter.name} does not support direct put() for snapshot chunks`
          );
        }
      } else if (typeof byteLength === 'number') {
        observedByteLength = byteLength;
        await bodyStream.cancel();
      } else if (blobAdapter.getMetadata) {
        const metadata = await blobAdapter.getMetadata(blobHash);
        if (!metadata) {
          throw new Error(
            `Blob metadata missing for existing chunk ${blobHash}`
          );
        }
        observedByteLength = metadata.size;
        await bodyStream.cancel();
      } else {
        observedByteLength = await streamByteLength(bodyStream);
      }

      if (
        typeof byteLength === 'number' &&
        Number.isFinite(byteLength) &&
        observedByteLength !== byteLength
      ) {
        throw new Error(
          `Snapshot chunk byte length mismatch: expected ${byteLength}, got ${observedByteLength}`
        );
      }

      await upsertChunkMetadata(metaWithoutBody, {
        blobHash,
        byteLength: observedByteLength,
      });

      const storedRef = await readStoredRef({
        partitionId: metaWithoutBody.partitionId,
        scopeKey: metaWithoutBody.scopeKey,
        scope: metaWithoutBody.scope,
        asOfCommitSeq: metaWithoutBody.asOfCommitSeq,
        rowCursor: metaWithoutBody.rowCursor,
        rowLimit: metaWithoutBody.rowLimit,
        encoding: metaWithoutBody.encoding,
        compression: metaWithoutBody.compression,
        includeExpired: true,
      });

      if (!storedRef) {
        throw new Error('Failed to read stored snapshot chunk reference');
      }

      return storedRef;
    },

    async readChunk(chunkId: string): Promise<Uint8Array | null> {
      const stream = await readChunkStreamById(chunkId);
      if (!stream) return null;
      return streamToBytes(stream);
    },

    async readChunkStream(
      chunkId: string
    ): Promise<ReadableStream<Uint8Array> | null> {
      return readChunkStreamById(chunkId);
    },

    async findChunk(
      pageKey: SnapshotChunkPageKey
    ): Promise<SyncSnapshotChunkRef | null> {
      return readStoredRef(pageKey);
    },

    async cleanupExpired(beforeIso: string): Promise<number> {
      // Find expired chunks
      const expiredRows = await db
        .selectFrom('sync_snapshot_chunks')
        .select(['chunk_id', 'blob_hash'])
        .where('expires_at', '<=', beforeIso)
        .execute();

      if (expiredRows.length === 0) return 0;

      // Delete from blob storage (best effort)
      for (const row of expiredRows) {
        try {
          await blobAdapter.delete(row.blob_hash);
        } catch {
          // Ignore deletion errors - blob may be shared or already deleted
          // Log for observability but don't fail the cleanup
          console.warn(
            `Failed to delete blob ${row.blob_hash} for chunk ${row.chunk_id}, may be already deleted or shared`
          );
        }
      }

      // Delete metadata from database
      const result = await db
        .deleteFrom('sync_snapshot_chunks')
        .where('expires_at', '<=', beforeIso)
        .executeTakeFirst();

      return Number(result.numDeletedRows ?? 0);
    },
  };
}
