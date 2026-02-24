import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { BlobStorageAdapter } from '@syncular/core';
import { type Kysely, sql } from 'kysely';
import { createBunSqliteDialect } from '../../../dialect-bun-sqlite/src';
import { createSqliteServerDialect } from '../../../server-dialect-sqlite/src';
import { ensureSyncSchema } from '../migrate';
import type { SyncCoreDb } from '../schema';
import { createDbMetadataChunkStorage } from './db-metadata';

interface TestDb extends SyncCoreDb {}

function createInMemoryBlobAdapter(): BlobStorageAdapter {
  const store = new Map<string, Uint8Array>();

  return {
    name: 'memory',
    async signUpload() {
      return { url: 'https://example.test/upload', method: 'PUT' };
    },
    async signDownload() {
      return 'https://example.test/download';
    },
    async exists(hash) {
      return store.has(hash);
    },
    async delete(hash) {
      store.delete(hash);
    },
    async put(hash, data) {
      store.set(hash, new Uint8Array(data));
    },
    async get(hash) {
      const value = store.get(hash);
      return value ? new Uint8Array(value) : null;
    },
  };
}

function createBodyStream(
  chunks: readonly Uint8Array[]
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

describe('createDbMetadataChunkStorage', () => {
  let db: Kysely<TestDb>;

  beforeEach(async () => {
    db = createDatabase<TestDb>({ dialect: createBunSqliteDialect({ path: ':memory:' }), family: 'sqlite' });
    await ensureSyncSchema(db, createSqliteServerDialect());
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('returns the persisted chunk id on page-key conflicts', async () => {
    const storage = createDbMetadataChunkStorage({
      db,
      blobAdapter: createInMemoryBlobAdapter(),
    });

    const body = new Uint8Array([1, 2, 3, 4]);
    const expiresAt = new Date(Date.now() + 60_000).toISOString();

    const first = await storage.storeChunk({
      partitionId: 'p1',
      scopeKey: 'scope-key',
      scope: 'tasks',
      asOfCommitSeq: 1,
      rowCursor: null,
      rowLimit: 100,
      encoding: 'json-row-frame-v1',
      compression: 'gzip',
      sha256: 'chunk-sha',
      expiresAt,
      body,
    });

    const second = await storage.storeChunk({
      partitionId: 'p1',
      scopeKey: 'scope-key',
      scope: 'tasks',
      asOfCommitSeq: 1,
      rowCursor: null,
      rowLimit: 100,
      encoding: 'json-row-frame-v1',
      compression: 'gzip',
      sha256: 'chunk-sha',
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
      body,
    });

    expect(second.id).toBe(first.id);

    const chunkBody = await storage.readChunk(second.id);
    expect(chunkBody).toEqual(body);

    const countResult = await sql<{ count: number }>`
      select count(*) as count
      from ${sql.table('sync_snapshot_chunks')}
    `.execute(db);

    expect(Number(countResult.rows[0]?.count ?? 0)).toBe(1);
  });

  it('disables blob checksums for chunk stream writes', async () => {
    const putStreamMetadata: Array<Record<string, unknown> | undefined> = [];
    const blobAdapter: BlobStorageAdapter = {
      name: 'memory-stream',
      async signUpload() {
        return { url: 'https://example.test/upload', method: 'PUT' };
      },
      async signDownload() {
        return 'https://example.test/download';
      },
      async exists() {
        return false;
      },
      async delete() {},
      async put() {},
      async get() {
        return null;
      },
      async putStream(_hash, stream, metadata) {
        putStreamMetadata.push(metadata);
        const reader = stream.getReader();
        try {
          while (true) {
            const { done } = await reader.read();
            if (done) break;
          }
        } finally {
          reader.releaseLock();
        }
      },
    };

    const storage = createDbMetadataChunkStorage({
      db,
      blobAdapter,
    });

    await storage.storeChunkStream({
      partitionId: 'p1',
      scopeKey: 'scope-key',
      scope: 'tasks',
      asOfCommitSeq: 1,
      rowCursor: null,
      rowLimit: 100,
      encoding: 'json-row-frame-v1',
      compression: 'gzip',
      sha256: 'chunk-sha',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      byteLength: 4,
      bodyStream: createBodyStream([new Uint8Array([1, 2, 3, 4])]),
    });

    expect(putStreamMetadata).toHaveLength(1);
    expect(putStreamMetadata[0]?.disableChecksum).toBe(true);
  });
});
