/**
 * Tests for DbMetadataSnapshotChunkStorage
 *
 * Covers:
 * - storeChunk: stores metadata in DB, body in blob adapter
 * - readChunk: reads from blob adapter using hash from metadata
 * - findChunk: finds by page key (scope, commit seq, etc.)
 * - cleanupExpired: removes expired chunks and their blobs
 * - Content deduplication: same content = same blob, different metadata
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import type { BlobStorageAdapter } from '@syncular/core';
import { createDatabase } from '@syncular/core';
import { createBunSqliteDialect } from '@syncular/dialect-bun-sqlite';
import { ensureSyncSchema, type SyncCoreDb } from '@syncular/server';
import { createDbMetadataChunkStorage } from '@syncular/server/snapshot-chunks';
import { createSqliteServerDialect } from '@syncular/server-dialect-sqlite';
import type { Kysely } from 'kysely';

function expectedBlobHash(args: {
  encoding: string;
  compression: string;
  sha256: string;
}): string {
  const digest = createHash('sha256')
    .update(`${args.encoding}:${args.compression}:${args.sha256}`)
    .digest('hex');
  return `sha256:${digest}`;
}

describe('DbMetadataSnapshotChunkStorage', () => {
  let db: Kysely<SyncCoreDb>;
  let dialect: ReturnType<typeof createSqliteServerDialect>;
  let mockBlobAdapter: BlobStorageAdapter & {
    put: (hash: string, data: Uint8Array) => Promise<void>;
    putStream: (
      hash: string,
      stream: ReadableStream<Uint8Array>
    ) => Promise<void>;
    get: (hash: string) => Promise<Uint8Array | null>;
    getStream: (hash: string) => Promise<ReadableStream<Uint8Array> | null>;
    _storage: Map<string, Uint8Array>;
  };

  beforeEach(async () => {
    db = createDatabase<SyncCoreDb>({
      dialect: createBunSqliteDialect({ path: ':memory:' }),
      family: 'sqlite',
    });
    dialect = createSqliteServerDialect();
    await ensureSyncSchema(db, dialect);

    // Create in-memory mock blob adapter
    const storage = new Map<string, Uint8Array>();
    mockBlobAdapter = {
      name: 'mock',
      _storage: storage,
      async signUpload() {
        return { url: 'http://mock/upload', method: 'PUT' };
      },
      async signDownload() {
        return 'http://mock/download';
      },
      async exists(hash: string) {
        return storage.has(hash);
      },
      async delete(hash: string) {
        storage.delete(hash);
      },
      async put(hash: string, data: Uint8Array) {
        storage.set(hash, new Uint8Array(data));
      },
      async putStream(hash: string, stream: ReadableStream<Uint8Array>) {
        const reader = stream.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;
            chunks.push(value);
            total += value.length;
          }
        } finally {
          reader.releaseLock();
        }

        const out = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          out.set(chunk, offset);
          offset += chunk.length;
        }

        storage.set(hash, out);
      },
      async get(hash: string) {
        const data = storage.get(hash);
        return data ? new Uint8Array(data) : null;
      },
      async getStream(hash: string) {
        const data = storage.get(hash);
        if (!data) return null;
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(data));
            controller.close();
          },
        });
      },
    };
  });

  afterEach(async () => {
    await db.destroy();
  });

  describe('storeChunk', () => {
    it('stores chunk metadata in DB and body in blob adapter', async () => {
      const storage = createDbMetadataChunkStorage({
        db,
        blobAdapter: mockBlobAdapter,
      });

      const body = new TextEncoder().encode('test chunk data');
      const sha256 = 'abc123'; // In real usage, would be actual hash

      const ref = await storage.storeChunk({
        partitionId: 'test',
        scopeKey: 'user:123',
        scope: 'tasks',
        asOfCommitSeq: 100,
        rowCursor: 'cursor1',
        rowLimit: 1000,
        encoding: 'json-row-frame-v1',
        compression: 'gzip',
        sha256,
        body,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      });

      // Verify ref returned
      expect(ref.id).toBeTruthy();
      expect(ref.sha256).toBe(sha256);
      expect(ref.byteLength).toBe(body.length);
      expect(ref.encoding).toBe('json-row-frame-v1');
      expect(ref.compression).toBe('gzip');

      // Verify body stored in blob adapter (hash derived from chunk metadata)
      const computedHash = expectedBlobHash({
        encoding: 'json-row-frame-v1',
        compression: 'gzip',
        sha256,
      });
      const storedBody = await mockBlobAdapter.get(computedHash);
      expect(storedBody).not.toBeNull();
      expect(new TextDecoder().decode(storedBody!)).toBe('test chunk data');
    });

    it('deduplicates blobs with same content', async () => {
      const storage = createDbMetadataChunkStorage({
        db,
        blobAdapter: mockBlobAdapter,
      });

      const body = new TextEncoder().encode('duplicate content');
      const sha256 = 'dedup123';

      // Store first chunk
      const ref1 = await storage.storeChunk({
        partitionId: 'test',
        scopeKey: 'user:123',
        scope: 'tasks',
        asOfCommitSeq: 100,
        rowCursor: 'cursor1',
        rowLimit: 1000,
        encoding: 'json-row-frame-v1',
        compression: 'gzip',
        sha256,
        body,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      });

      // Store second chunk with same body (different metadata)
      const ref2 = await storage.storeChunk({
        partitionId: 'test',
        scopeKey: 'user:456', // Different scope
        scope: 'tasks',
        asOfCommitSeq: 200, // Different commit seq
        rowCursor: 'cursor2',
        rowLimit: 1000,
        encoding: 'json-row-frame-v1',
        compression: 'gzip',
        sha256, // Same content hash
        body,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      });

      // Should have different IDs
      expect(ref1.id).not.toBe(ref2.id);

      // But blob should only be stored once (deterministic metadata hash)
      const computedHash = expectedBlobHash({
        encoding: 'json-row-frame-v1',
        compression: 'gzip',
        sha256,
      });
      const stored = mockBlobAdapter._storage.get(computedHash);
      expect(stored).not.toBeUndefined();
    });

    it('updates existing chunk on conflict (same page key)', async () => {
      const storage = createDbMetadataChunkStorage({
        db,
        blobAdapter: mockBlobAdapter,
      });

      const body1 = new TextEncoder().encode('original content');
      const sha256_1 = 'orig123';
      const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000);

      await storage.storeChunk({
        partitionId: 'test',
        scopeKey: 'user:123',
        scope: 'tasks',
        asOfCommitSeq: 100,
        rowCursor: 'cursor1',
        rowLimit: 1000,
        encoding: 'json-row-frame-v1',
        compression: 'gzip',
        sha256: sha256_1,
        body: body1,
        expiresAt: futureDate.toISOString(),
      });

      // Store with same page key but different content
      const body2 = new TextEncoder().encode('updated content');
      const sha256_2 = 'updated456';
      const laterDate = new Date(Date.now() + 48 * 60 * 60 * 1000);

      const ref2 = await storage.storeChunk({
        partitionId: 'test', // Same
        scopeKey: 'user:123', // Same
        scope: 'tasks', // Same
        asOfCommitSeq: 100, // Same
        rowCursor: 'cursor1', // Same
        rowLimit: 1000, // Same
        encoding: 'json-row-frame-v1', // Same
        compression: 'gzip', // Same
        sha256: sha256_2,
        body: body2,
        expiresAt: laterDate.toISOString(),
      });

      // Should update the same chunk (different SHA256 but same ID concept)
      // Actually, the ID will be different but the DB row gets updated
      expect(ref2.sha256).toBe(sha256_2);

      // Old blob should still exist (no orphan cleanup on update)
      const oldBlobHash = expectedBlobHash({
        encoding: 'json-row-frame-v1',
        compression: 'gzip',
        sha256: sha256_1,
      });
      const oldBlob = await mockBlobAdapter.get(oldBlobHash);
      expect(oldBlob).not.toBeNull();

      // New blob should exist (computed from new chunk metadata)
      const newBlobHash = expectedBlobHash({
        encoding: 'json-row-frame-v1',
        compression: 'gzip',
        sha256: sha256_2,
      });
      const newBlob = await mockBlobAdapter.get(newBlobHash);
      expect(newBlob).not.toBeNull();
    });

    it('storeChunkStream uses metadata-derived blob key', async () => {
      const storage = createDbMetadataChunkStorage({
        db,
        blobAdapter: mockBlobAdapter,
      });

      const compressedBody = new TextEncoder().encode('compressed-bytes');
      const chunkSha = 'row-frame-hash-value';

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(compressedBody);
          controller.close();
        },
      });

      const ref = await storage.storeChunkStream({
        partitionId: 'test',
        scopeKey: 'user:123',
        scope: 'tasks',
        asOfCommitSeq: 123,
        rowCursor: 'cursor-stream',
        rowLimit: 1000,
        encoding: 'json-row-frame-v1',
        compression: 'gzip',
        sha256: chunkSha,
        bodyStream: stream,
        byteLength: compressedBody.length,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      });

      expect(ref.sha256).toBe(chunkSha);

      const expectedHash = expectedBlobHash({
        encoding: 'json-row-frame-v1',
        compression: 'gzip',
        sha256: chunkSha,
      });
      expect(mockBlobAdapter._storage.has(expectedHash)).toBe(true);
    });

    it('storeChunkStream works without byteLength', async () => {
      const storage = createDbMetadataChunkStorage({
        db,
        blobAdapter: mockBlobAdapter,
      });

      const compressedBody = new TextEncoder().encode('stream-without-length');
      const chunkSha = 'row-frame-hash-no-length';

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(compressedBody);
          controller.close();
        },
      });

      const ref = await storage.storeChunkStream({
        partitionId: 'test',
        scopeKey: 'user:789',
        scope: 'tasks',
        asOfCommitSeq: 124,
        rowCursor: 'cursor-stream-2',
        rowLimit: 1000,
        encoding: 'json-row-frame-v1',
        compression: 'gzip',
        sha256: chunkSha,
        bodyStream: stream,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      });

      expect(ref.sha256).toBe(chunkSha);
      expect(ref.byteLength).toBe(compressedBody.length);

      const expectedHash = expectedBlobHash({
        encoding: 'json-row-frame-v1',
        compression: 'gzip',
        sha256: chunkSha,
      });
      expect(mockBlobAdapter._storage.has(expectedHash)).toBe(true);
    });
  });

  describe('readChunk', () => {
    it('reads chunk body from blob adapter', async () => {
      const storage = createDbMetadataChunkStorage({
        db,
        blobAdapter: mockBlobAdapter,
      });

      const body = new TextEncoder().encode('readable content');
      const sha256 = 'read123';

      const ref = await storage.storeChunk({
        partitionId: 'test',
        scopeKey: 'user:123',
        scope: 'tasks',
        asOfCommitSeq: 100,
        rowCursor: 'cursor1',
        rowLimit: 1000,
        encoding: 'json-row-frame-v1',
        compression: 'gzip',
        sha256,
        body,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      });

      const readBody = await storage.readChunk(ref.id);
      expect(readBody).not.toBeNull();
      expect(new TextDecoder().decode(readBody!)).toBe('readable content');
    });

    it('returns null for non-existent chunk', async () => {
      const storage = createDbMetadataChunkStorage({
        db,
        blobAdapter: mockBlobAdapter,
      });

      const result = await storage.readChunk('non-existent-id');
      expect(result).toBeNull();
    });
  });

  describe('findChunk', () => {
    it('finds chunk by page key', async () => {
      const storage = createDbMetadataChunkStorage({
        db,
        blobAdapter: mockBlobAdapter,
      });

      const body = new TextEncoder().encode('findable content');
      const sha256 = 'find123';

      await storage.storeChunk({
        partitionId: 'test',
        scopeKey: 'user:123',
        scope: 'tasks',
        asOfCommitSeq: 100,
        rowCursor: 'cursor1',
        rowLimit: 1000,
        encoding: 'json-row-frame-v1',
        compression: 'gzip',
        sha256,
        body,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      });

      const found = await storage.findChunk({
        partitionId: 'test',
        scopeKey: 'user:123',
        scope: 'tasks',
        asOfCommitSeq: 100,
        rowCursor: 'cursor1',
        rowLimit: 1000,
        encoding: 'json-row-frame-v1',
        compression: 'gzip',
      });

      expect(found).not.toBeNull();
      expect(found!.sha256).toBe(sha256);
    });

    it('returns null for expired chunk', async () => {
      const storage = createDbMetadataChunkStorage({
        db,
        blobAdapter: mockBlobAdapter,
      });

      const body = new TextEncoder().encode('expired content');

      await storage.storeChunk({
        partitionId: 'test',
        scopeKey: 'user:123',
        scope: 'tasks',
        asOfCommitSeq: 100,
        rowCursor: 'cursor1',
        rowLimit: 1000,
        encoding: 'json-row-frame-v1',
        compression: 'gzip',
        sha256: 'expired123',
        body,
        expiresAt: new Date(Date.now() - 1000).toISOString(), // Past
      });

      const found = await storage.findChunk({
        partitionId: 'test',
        scopeKey: 'user:123',
        scope: 'tasks',
        asOfCommitSeq: 100,
        rowCursor: 'cursor1',
        rowLimit: 1000,
        encoding: 'json-row-frame-v1',
        compression: 'gzip',
      });

      expect(found).toBeNull();
    });

    it('returns null for non-matching page key', async () => {
      const storage = createDbMetadataChunkStorage({
        db,
        blobAdapter: mockBlobAdapter,
      });

      const body = new TextEncoder().encode('content');

      await storage.storeChunk({
        partitionId: 'test',
        scopeKey: 'user:123',
        scope: 'tasks',
        asOfCommitSeq: 100,
        rowCursor: 'cursor1',
        rowLimit: 1000,
        encoding: 'json-row-frame-v1',
        compression: 'gzip',
        sha256: 'nomatch123',
        body,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      });

      // Different scope key
      const found = await storage.findChunk({
        partitionId: 'test',
        scopeKey: 'user:999', // Different
        scope: 'tasks',
        asOfCommitSeq: 100,
        rowCursor: 'cursor1',
        rowLimit: 1000,
        encoding: 'json-row-frame-v1',
        compression: 'gzip',
      });

      expect(found).toBeNull();
    });
  });

  describe('cleanupExpired', () => {
    it('removes expired chunks and their blobs', async () => {
      const storage = createDbMetadataChunkStorage({
        db,
        blobAdapter: mockBlobAdapter,
      });

      // Store expired chunk
      const expiredBody = new TextEncoder().encode('expired');
      const expiredRef = await storage.storeChunk({
        partitionId: 'test',
        scopeKey: 'user:123',
        scope: 'tasks',
        asOfCommitSeq: 100,
        rowCursor: 'cursor1',
        rowLimit: 1000,
        encoding: 'json-row-frame-v1',
        compression: 'gzip',
        sha256: 'expired123',
        body: expiredBody,
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      });

      // Store valid chunk
      const validBody = new TextEncoder().encode('valid');
      const validRef = await storage.storeChunk({
        partitionId: 'test',
        scopeKey: 'user:456',
        scope: 'tasks',
        asOfCommitSeq: 200,
        rowCursor: 'cursor2',
        rowLimit: 1000,
        encoding: 'json-row-frame-v1',
        compression: 'gzip',
        sha256: 'valid456',
        body: validBody,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      });

      // Run cleanup
      const deleted = await storage.cleanupExpired(new Date().toISOString());
      expect(deleted).toBe(1);

      // Expired chunk should be gone
      const expiredRead = await storage.readChunk(expiredRef.id);
      expect(expiredRead).toBeNull();

      // Expired blob should be deleted
      const expiredBlob = await mockBlobAdapter.get(
        expectedBlobHash({
          encoding: 'json-row-frame-v1',
          compression: 'gzip',
          sha256: 'expired123',
        })
      );
      expect(expiredBlob).toBeNull();

      // Valid chunk should still exist
      const validRead = await storage.readChunk(validRef.id);
      expect(validRead).not.toBeNull();
    });

    it('returns 0 when no expired chunks exist', async () => {
      const storage = createDbMetadataChunkStorage({
        db,
        blobAdapter: mockBlobAdapter,
      });

      const deleted = await storage.cleanupExpired(new Date().toISOString());
      expect(deleted).toBe(0);
    });

    it('handles blob deletion errors gracefully', async () => {
      // Create adapter that throws on delete
      const failingAdapter: BlobStorageAdapter & {
        put: (hash: string, data: Uint8Array) => Promise<void>;
        get: (hash: string) => Promise<Uint8Array | null>;
      } = {
        ...mockBlobAdapter,
        name: 'failing-delete',
        async delete() {
          throw new Error('Delete failed');
        },
      };

      const storage = createDbMetadataChunkStorage({
        db,
        blobAdapter: failingAdapter,
      });

      // Store expired chunk
      const body = new TextEncoder().encode('content');
      await storage.storeChunk({
        partitionId: 'test',
        scopeKey: 'user:123',
        scope: 'tasks',
        asOfCommitSeq: 100,
        rowCursor: 'cursor1',
        rowLimit: 1000,
        encoding: 'json-row-frame-v1',
        compression: 'gzip',
        sha256: 'error123',
        body,
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      });

      // Should not throw even if blob delete fails
      const deleted = await storage.cleanupExpired(new Date().toISOString());
      expect(deleted).toBe(1);
    });
  });
});
