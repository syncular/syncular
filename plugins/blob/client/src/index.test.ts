import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createDatabase, type SyncTransport } from '@syncular/core';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { Client, type SyncClientDb } from '../../../../packages/client/src';
import type { ClientHandlerCollection } from '../../../../packages/client/src/handlers/collection';
import { ensureClientSyncSchema } from '../../../../packages/client/src/migrate';
import { createBunSqliteDialect } from '../../../../packages/dialect-bun-sqlite/src';
import { createHttpTransport } from '../../../../packages/transport-http/src';
import {
  type ClientBlobStorage,
  createBlobPlugin,
  ensureClientBlobSchema,
} from './index';

interface TasksTable {
  id: string;
  title: string;
  server_version: number;
}

interface TestDb extends SyncClientDb {
  tasks: TasksTable;
}

const noopTransport: SyncTransport = {
  async sync() {
    return {};
  },
  async fetchSnapshotChunk() {
    return new Uint8Array();
  },
};

function createMemoryBlobStorage(): ClientBlobStorage {
  const memory = new Map<string, Uint8Array>();
  return {
    async write(hash, data) {
      if (data instanceof ReadableStream) {
        const reader = data.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          chunks.push(chunk.value);
          total += chunk.value.length;
        }
        const combined = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          combined.set(chunk, offset);
          offset += chunk.length;
        }
        memory.set(hash, combined);
        return;
      }
      memory.set(hash, new Uint8Array(data));
    },
    async read(hash) {
      const data = memory.get(hash);
      return data ? new Uint8Array(data) : null;
    },
    async delete(hash) {
      memory.delete(hash);
    },
    async exists(hash) {
      return memory.has(hash);
    },
  };
}

describe('blob client plugin', () => {
  let db: Kysely<TestDb>;
  let client: Client<TestDb>;
  let initiateCalls = 0;

  async function insertBlobOutboxRow(input: {
    hash: string;
    status: string;
    attemptCount: number;
    updatedAt: number;
  }): Promise<void> {
    const now = Date.now();
    await sql`
      insert into ${sql.table('sync_blob_outbox')} (
        ${sql.join([
          sql.ref('hash'),
          sql.ref('size'),
          sql.ref('mime_type'),
          sql.ref('body'),
          sql.ref('encrypted'),
          sql.ref('key_id'),
          sql.ref('status'),
          sql.ref('attempt_count'),
          sql.ref('error'),
          sql.ref('created_at'),
          sql.ref('updated_at'),
        ])}
      ) values (
        ${sql.join([
          sql.val(input.hash),
          sql.val(3),
          sql.val('application/octet-stream'),
          sql.val(new Uint8Array([1, 2, 3])),
          sql.val(0),
          sql.val(null),
          sql.val(input.status),
          sql.val(input.attemptCount),
          sql.val(null),
          sql.val(now),
          sql.val(input.updatedAt),
        ])}
      )
    `.execute(db);
  }

  beforeEach(async () => {
    db = createDatabase<TestDb>({
      dialect: createBunSqliteDialect({ path: ':memory:' }),
      family: 'sqlite',
    });
    await ensureClientSyncSchema(db);
    await ensureClientBlobSchema(db);
    initiateCalls = 0;

    const handlers: ClientHandlerCollection<TestDb> = [];
    const transport: SyncTransport = {
      ...noopTransport,
      blobs: {
        async initiateUpload() {
          initiateCalls++;
          return { exists: true };
        },
        async completeUpload() {
          return { ok: true };
        },
        async getDownloadUrl() {
          return {
            url: 'https://example.invalid/blob',
            expiresAt: new Date(0).toISOString(),
          };
        },
      },
    };

    client = new Client<TestDb>({
      db,
      transport,
      tableHandlers: handlers,
      clientId: 'client-1',
      actorId: 'u1',
      subscriptions: [],
      plugins: [createBlobPlugin({ storage: createMemoryBlobStorage() })],
    });
  });

  afterEach(async () => {
    client.destroy();
    await db.destroy();
  });

  it('attaches client.blobs through plugin setup', () => {
    expect(client.blobs).toBeDefined();
  });

  it('attaches blob transport support for the standard HTTP transport', async () => {
    const transport = createHttpTransport({
      baseUrl: 'https://example.invalid',
      fetch: async () =>
        new Response(JSON.stringify({ ok: true }), {
          headers: { 'content-type': 'application/json' },
          status: 200,
        }),
    });

    const httpClient = new Client<TestDb>({
      db,
      transport,
      tableHandlers: [],
      clientId: 'client-http',
      actorId: 'u1',
      subscriptions: [],
      plugins: [createBlobPlugin({ storage: createMemoryBlobStorage() })],
    });

    expect(httpClient.blobs).toBeDefined();
    expect(transport.blobs).toBeDefined();

    httpClient.destroy();
  });

  it('requeues stale uploading rows and uploads them on the next queue run', async () => {
    await insertBlobOutboxRow({
      hash: 'sha256:stale-upload',
      status: 'uploading',
      attemptCount: 0,
      updatedAt: Date.now() - 31_000,
    });

    const result = await client.blobs.processUploadQueue();

    expect(result.uploaded).toBe(1);
    expect(result.failed).toBe(0);
    expect(initiateCalls).toBe(1);

    const remaining = await sql<{ count: number | bigint }>`
      select count(${sql.ref('hash')}) as count
      from ${sql.table('sync_blob_outbox')}
      where ${sql.ref('hash')} = ${'sha256:stale-upload'}
    `.execute(db);
    expect(Number(remaining.rows[0]?.count ?? 0)).toBe(0);
  });

  it('marks stale uploading rows as failed after max retries', async () => {
    await insertBlobOutboxRow({
      hash: 'sha256:stale-failed',
      status: 'uploading',
      attemptCount: 2,
      updatedAt: Date.now() - 31_000,
    });

    await client.blobs.processUploadQueue();

    expect(initiateCalls).toBe(0);

    const rowResult = await sql<{
      status: string;
      attempt_count: number;
      error: string | null;
    }>`
      select
        ${sql.ref('status')} as status,
        ${sql.ref('attempt_count')} as attempt_count,
        ${sql.ref('error')} as error
      from ${sql.table('sync_blob_outbox')}
      where ${sql.ref('hash')} = ${'sha256:stale-failed'}
      limit 1
    `.execute(db);
    const row = rowResult.rows[0];
    if (!row) {
      throw new Error('Expected stale failed row to remain in outbox');
    }
    expect(row.status).toBe('failed');
    expect(row.attempt_count).toBe(3);
    expect(row.error).toContain('Upload timed out while in uploading state');
  });
});
