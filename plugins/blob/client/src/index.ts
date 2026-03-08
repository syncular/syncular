import type { SyncTransport } from '@syncular/core';
import type {
  SyncClientDb,
  SyncClientPlugin,
} from '@syncular/client';
import { sql } from 'kysely';
import { ensureClientBlobSchema } from './migrate';
import type { BlobClient, ClientBlobStorage } from './types';

export * from './migrate';
export * from './types';

export const BLOB_PLUGIN_KIND = 'blob';

export interface BlobPluginOptions {
  storage: ClientBlobStorage;
}

declare module '@syncular/client' {
  interface SyncClientFeatureRegistry {
    blobs: BlobClient;
  }
}

declare module 'syncular/client' {
  interface SyncClientFeatureRegistry {
    blobs: BlobClient;
  }
}

export function createBlobPlugin(options: BlobPluginOptions): SyncClientPlugin {
  return {
    kind: BLOB_PLUGIN_KIND,
    name: BLOB_PLUGIN_KIND,
    setup(ctx) {
      if (!ctx.transport.blobs) {
        throw new Error(
          'Blob plugin requires a transport with blob support enabled'
        );
      }

      ctx.defineFeature(
        'blobs',
        createBlobClient({
          db: ctx.db,
          transport: ctx.transport,
          storage: options.storage,
          emit: ctx.emit,
        })
      );
    },
    async migrate(ctx) {
      await ensureClientBlobSchema(ctx.db);
    },
  };
}

function createBlobClient(args: {
  db: import('kysely').Kysely<SyncClientDb>;
  transport: SyncTransport;
  storage: ClientBlobStorage;
  emit: (event: string, payload: object) => void;
}): BlobClient {
  const { db, storage, transport, emit } = args;
  const blobs = transport.blobs!;
  const staleUploadingTimeoutMs = 30_000;
  const maxUploadRetries = 3;

  return {
    async store(data, options) {
      const bytes = await toUint8Array(data);
      const mimeType =
        data instanceof Blob
          ? data.type
          : (options?.mimeType ?? 'application/octet-stream');

      const hashHex = await computeSha256Hex(bytes);
      const hash = `sha256:${hashHex}`;

      await storage.write(hash, bytes);

      const now = Date.now();
      await sql`
        insert into ${sql.table('sync_blob_cache')} (
          ${sql.join([
            sql.ref('hash'),
            sql.ref('size'),
            sql.ref('mime_type'),
            sql.ref('cached_at'),
            sql.ref('last_accessed_at'),
            sql.ref('encrypted'),
            sql.ref('key_id'),
            sql.ref('body'),
          ])}
        ) values (
          ${sql.join([
            sql.val(hash),
            sql.val(bytes.length),
            sql.val(mimeType),
            sql.val(now),
            sql.val(now),
            sql.val(0),
            sql.val(null),
            sql.val(bytes),
          ])}
        )
        on conflict (${sql.ref('hash')}) do nothing
      `.execute(db);

      if (options?.immediate) {
        const initResult = await blobs.initiateUpload({
          hash,
          size: bytes.length,
          mimeType,
        });

        if (!initResult.exists && initResult.uploadUrl) {
          const uploadResponse = await fetch(initResult.uploadUrl, {
            method: initResult.uploadMethod ?? 'PUT',
            body: bytes.buffer as ArrayBuffer,
            headers: initResult.uploadHeaders,
          });

          if (!uploadResponse.ok) {
            throw new Error(`Upload failed: ${uploadResponse.statusText}`);
          }

          await blobs.completeUpload(hash);
        }
      } else {
        await sql`
          insert into ${sql.table('sync_blob_outbox')} (
            ${sql.join([
              sql.ref('hash'),
              sql.ref('size'),
              sql.ref('mime_type'),
              sql.ref('status'),
              sql.ref('created_at'),
              sql.ref('updated_at'),
              sql.ref('attempt_count'),
              sql.ref('error'),
              sql.ref('encrypted'),
              sql.ref('key_id'),
              sql.ref('body'),
            ])}
          ) values (
            ${sql.join([
              sql.val(hash),
              sql.val(bytes.length),
              sql.val(mimeType),
              sql.val('pending'),
              sql.val(now),
              sql.val(now),
              sql.val(0),
              sql.val(null),
              sql.val(0),
              sql.val(null),
              sql.val(bytes),
            ])}
          )
          on conflict (${sql.ref('hash')}) do nothing
        `.execute(db);
      }

      return {
        hash,
        size: bytes.length,
        mimeType,
      };
    },

    async retrieve(ref) {
      const local = await storage.read(ref.hash);
      if (local) {
        await sql`
          update ${sql.table('sync_blob_cache')}
          set ${sql.ref('last_accessed_at')} = ${sql.val(Date.now())}
          where ${sql.ref('hash')} = ${sql.val(ref.hash)}
        `.execute(db);
        return local;
      }

      const { url } = await blobs.getDownloadUrl(ref.hash);
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Download failed: ${response.statusText}`);
      }

      const bytes = new Uint8Array(await response.arrayBuffer());
      await storage.write(ref.hash, bytes);
      const now = Date.now();
      await sql`
        insert into ${sql.table('sync_blob_cache')} (
          ${sql.join([
            sql.ref('hash'),
            sql.ref('size'),
            sql.ref('mime_type'),
            sql.ref('cached_at'),
            sql.ref('last_accessed_at'),
            sql.ref('encrypted'),
            sql.ref('key_id'),
            sql.ref('body'),
          ])}
        ) values (
          ${sql.join([
            sql.val(ref.hash),
            sql.val(bytes.length),
            sql.val(ref.mimeType),
            sql.val(now),
            sql.val(now),
            sql.val(0),
            sql.val(null),
            sql.val(bytes),
          ])}
        )
        on conflict (${sql.ref('hash')}) do nothing
      `.execute(db);

      return bytes;
    },

    async isLocal(hash) {
      return storage.exists(hash);
    },

    async preload(refs) {
      await Promise.all(refs.map((ref) => this.retrieve(ref)));
    },

    async processUploadQueue() {
      let uploaded = 0;
      let failed = 0;
      const now = Date.now();
      const staleThreshold = now - staleUploadingTimeoutMs;

      await sql`
        update ${sql.table('sync_blob_outbox')}
        set
          ${sql.ref('status')} = ${sql.val('failed')},
          ${sql.ref('attempt_count')} = ${sql.ref('attempt_count')} + ${sql.val(
            1
          )},
          ${sql.ref('error')} = ${sql.val(
            'Upload timed out while in uploading state'
          )},
          ${sql.ref('updated_at')} = ${sql.val(now)}
        where ${sql.ref('status')} = ${sql.val('uploading')}
          and ${sql.ref('updated_at')} < ${sql.val(staleThreshold)}
          and ${sql.ref('attempt_count')} + ${sql.val(1)} >= ${sql.val(
            maxUploadRetries
          )}
      `.execute(db);

      await sql`
        update ${sql.table('sync_blob_outbox')}
        set
          ${sql.ref('status')} = ${sql.val('pending')},
          ${sql.ref('attempt_count')} = ${sql.ref('attempt_count')} + ${sql.val(
            1
          )},
          ${sql.ref('error')} = ${sql.val(
            'Upload timed out while in uploading state; retrying'
          )},
          ${sql.ref('updated_at')} = ${sql.val(now)}
        where ${sql.ref('status')} = ${sql.val('uploading')}
          and ${sql.ref('updated_at')} < ${sql.val(staleThreshold)}
          and ${sql.ref('attempt_count')} + ${sql.val(1)} < ${sql.val(
            maxUploadRetries
          )}
      `.execute(db);

      const pendingResult = await sql<{
        hash: string;
        size: number;
        mime_type: string;
        body: Uint8Array | null;
        attempt_count: number;
      }>`
        select
          ${sql.ref('hash')},
          ${sql.ref('size')},
          ${sql.ref('mime_type')},
          ${sql.ref('body')},
          ${sql.ref('attempt_count')}
        from ${sql.table('sync_blob_outbox')}
        where ${sql.ref('status')} = ${sql.val('pending')}
          and ${sql.ref('attempt_count')} < ${sql.val(maxUploadRetries)}
        limit ${sql.val(10)}
      `.execute(db);
      const pending = pendingResult.rows;

      for (const item of pending) {
        const nextAttemptCount = item.attempt_count + 1;
        try {
          await sql`
            update ${sql.table('sync_blob_outbox')}
            set
              ${sql.ref('status')} = ${sql.val('uploading')},
              ${sql.ref('attempt_count')} = ${sql.val(nextAttemptCount)},
              ${sql.ref('error')} = ${sql.val(null)},
              ${sql.ref('updated_at')} = ${sql.val(Date.now())}
            where ${sql.ref('hash')} = ${sql.val(item.hash)}
              and ${sql.ref('status')} = ${sql.val('pending')}
          `.execute(db);

          const initResult = await blobs.initiateUpload({
            hash: item.hash,
            size: item.size,
            mimeType: item.mime_type,
          });

          if (!initResult.exists && initResult.uploadUrl && item.body) {
            const uploadBody = new ArrayBuffer(item.body.byteLength);
            new Uint8Array(uploadBody).set(item.body);

            const uploadResponse = await fetch(initResult.uploadUrl, {
              method: initResult.uploadMethod ?? 'PUT',
              body: uploadBody,
              headers: initResult.uploadHeaders,
            });

            if (!uploadResponse.ok) {
              throw new Error(`Upload failed: ${uploadResponse.statusText}`);
            }

            const completeResult = await blobs.completeUpload(item.hash);
            if (!completeResult.ok) {
              throw new Error(
                completeResult.error ?? 'Failed to complete blob upload'
              );
            }
          }

          await sql`
            delete from ${sql.table('sync_blob_outbox')}
            where ${sql.ref('hash')} = ${sql.val(item.hash)}
          `.execute(db);

          emit('blob:upload:complete', {
            hash: item.hash,
            size: item.size,
            mimeType: item.mime_type,
          });
          uploaded++;
        } catch (err) {
          const nextStatus =
            nextAttemptCount >= maxUploadRetries ? 'failed' : 'pending';
          const errorMessage =
            err instanceof Error ? err.message : 'Unknown error';

          await sql`
            update ${sql.table('sync_blob_outbox')}
            set
              ${sql.ref('status')} = ${sql.val(nextStatus)},
              ${sql.ref('error')} = ${sql.val(errorMessage)},
              ${sql.ref('updated_at')} = ${sql.val(Date.now())}
            where ${sql.ref('hash')} = ${sql.val(item.hash)}
          `.execute(db);

          emit('blob:upload:error', {
            hash: item.hash,
            error: errorMessage,
          });

          if (nextStatus === 'failed') {
            failed++;
          }
        }
      }

      return { uploaded, failed };
    },

    async getUploadQueueStats() {
      const rowsResult = await sql<{
        status: string;
        count: number | bigint;
      }>`
        select
          ${sql.ref('status')} as status,
          count(${sql.ref('hash')}) as count
        from ${sql.table('sync_blob_outbox')}
        group by ${sql.ref('status')}
      `.execute(db);

      const stats = { pending: 0, uploading: 0, failed: 0 };
      for (const row of rowsResult.rows) {
        if (row.status === 'pending') stats.pending = Number(row.count);
        if (row.status === 'uploading') stats.uploading = Number(row.count);
        if (row.status === 'failed') stats.failed = Number(row.count);
      }
      return stats;
    },

    async getCacheStats() {
      const result = await sql<{
        count: number | bigint;
        totalBytes: number | bigint | null;
      }>`
        select
          count(${sql.ref('hash')}) as count,
          sum(${sql.ref('size')}) as totalBytes
        from ${sql.table('sync_blob_cache')}
      `.execute(db);
      const row = result.rows[0];

      return {
        count: Number(row?.count ?? 0),
        totalBytes: Number(row?.totalBytes ?? 0),
      };
    },

    async pruneCache(maxBytes) {
      if (!maxBytes) return 0;

      const stats = await this.getCacheStats();
      if (stats.totalBytes <= maxBytes) return 0;

      const toFree = stats.totalBytes - maxBytes;
      let freed = 0;

      const oldEntriesResult = await sql<{ hash: string; size: number }>`
        select ${sql.ref('hash')}, ${sql.ref('size')}
        from ${sql.table('sync_blob_cache')}
        order by ${sql.ref('last_accessed_at')} asc
      `.execute(db);
      const oldEntries = oldEntriesResult.rows;

      for (const entry of oldEntries) {
        if (freed >= toFree) break;

        await storage.delete(entry.hash);
        await sql`
          delete from ${sql.table('sync_blob_cache')}
          where ${sql.ref('hash')} = ${sql.val(entry.hash)}
        `.execute(db);
        freed += entry.size;
      }

      return freed;
    },

    async clearCache() {
      if (storage.clear) {
        await storage.clear();
      } else {
        const entriesResult = await sql<{ hash: string }>`
          select ${sql.ref('hash')}
          from ${sql.table('sync_blob_cache')}
        `.execute(db);

        for (const entry of entriesResult.rows) {
          await storage.delete(entry.hash);
        }
      }

      await sql`delete from ${sql.table('sync_blob_cache')}`.execute(db);
    },
  };
}

async function toUint8Array(
  data: Blob | File | Uint8Array
): Promise<Uint8Array> {
  if (data instanceof Uint8Array) {
    return data;
  }
  const buffer = await data.arrayBuffer();
  return new Uint8Array(buffer);
}

async function computeSha256Hex(data: Uint8Array): Promise<string> {
  const hashBuffer = await crypto.subtle.digest(
    'SHA-256',
    data.buffer as ArrayBuffer
  );
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
