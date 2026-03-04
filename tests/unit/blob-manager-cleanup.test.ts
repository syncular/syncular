import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { BlobStorageAdapter } from '@syncular/core';
import { createDatabase } from '@syncular/core';
import { createBunSqliteDialect } from '@syncular/dialect-bun-sqlite';
import {
  createBlobManager,
  ensureBlobStorageSchemaSqlite,
  type SyncBlobDb,
} from '@syncular/server';
import type { Kysely } from 'kysely';

describe('BlobManager cleanup tuning', () => {
  let db: Kysely<SyncBlobDb>;

  beforeEach(async () => {
    db = createDatabase<SyncBlobDb>({
      dialect: createBunSqliteDialect({ path: ':memory:' }),
      family: 'sqlite',
    });
    await ensureBlobStorageSchemaSqlite(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('supports custom cleanup tuning across paginated pending/complete rows', async () => {
    const deletedFromStorage: Array<{ hash: string; partitionId?: string }> =
      [];
    const adapter: BlobStorageAdapter = {
      name: 'cleanup-test',
      async signUpload() {
        return { url: 'http://example.test/upload', method: 'PUT' };
      },
      async signDownload() {
        return 'http://example.test/download';
      },
      async exists() {
        return false;
      },
      async delete(hash, options) {
        deletedFromStorage.push({
          hash,
          partitionId: options?.partitionId,
        });
      },
    };

    const manager = createBlobManager({
      db,
      adapter,
      cleanupTuning: {
        batchSize: 1,
        storageDeleteConcurrency: 1,
        referenceCheckConcurrency: 1,
      },
    });

    const partitionId = 'tenant-a';
    const expiredIso = new Date(Date.now() - 60_000).toISOString();
    const futureIso = new Date(Date.now() + 60_000).toISOString();
    const completedIso = new Date().toISOString();

    const pendingExpired = [
      'sha256:pending-expired-1',
      'sha256:pending-expired-2',
      'sha256:pending-expired-3',
    ];
    const pendingActive = ['sha256:pending-active-1'];
    const completeUnreferenced = [
      'sha256:complete-drop-1',
      'sha256:complete-drop-2',
    ];
    const completeReferenced = ['sha256:complete-keep-1'];

    for (const hash of pendingExpired) {
      await db
        .insertInto('sync_blob_uploads')
        .values({
          partition_id: partitionId,
          hash,
          size: 1,
          mime_type: 'application/octet-stream',
          status: 'pending',
          actor_id: 'actor',
          expires_at: expiredIso,
          completed_at: null,
        })
        .execute();
    }

    for (const hash of pendingActive) {
      await db
        .insertInto('sync_blob_uploads')
        .values({
          partition_id: partitionId,
          hash,
          size: 1,
          mime_type: 'application/octet-stream',
          status: 'pending',
          actor_id: 'actor',
          expires_at: futureIso,
          completed_at: null,
        })
        .execute();
    }

    for (const hash of completeUnreferenced) {
      await db
        .insertInto('sync_blob_uploads')
        .values({
          partition_id: partitionId,
          hash,
          size: 1,
          mime_type: 'application/octet-stream',
          status: 'complete',
          actor_id: 'actor',
          expires_at: futureIso,
          completed_at: completedIso,
        })
        .execute();
    }

    for (const hash of completeReferenced) {
      await db
        .insertInto('sync_blob_uploads')
        .values({
          partition_id: partitionId,
          hash,
          size: 1,
          mime_type: 'application/octet-stream',
          status: 'complete',
          actor_id: 'actor',
          expires_at: futureIso,
          completed_at: completedIso,
        })
        .execute();
    }

    const result = await manager.cleanup({
      partitionId,
      deleteFromStorage: true,
      isReferenced: async (hash) => completeReferenced.includes(hash),
    });

    expect(result.deleted).toBe(5);

    const remaining = await db
      .selectFrom('sync_blob_uploads')
      .select(['hash'])
      .where('partition_id', '=', partitionId)
      .orderBy('hash', 'asc')
      .execute();

    expect(remaining.map((row) => row.hash)).toEqual(
      [...completeReferenced, ...pendingActive].sort()
    );

    expect(deletedFromStorage).toHaveLength(5);
    for (const call of deletedFromStorage) {
      expect(call.partitionId).toBe(partitionId);
    }
  });
});
