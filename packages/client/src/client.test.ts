import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { SyncTransport } from '@syncular/core';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { createBunSqliteDialect } from '../../dialect-bun-sqlite/src';
import { ensureClientBlobSchema } from './blobs/migrate';
import { Client, type ClientBlobStorage } from './client';
import { SyncEngine } from './engine/SyncEngine';
import type { ClientHandlerCollection } from './handlers/collection';
import { ensureClientSyncSchema } from './migrate';
import type { SyncClientDb } from './schema';

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

describe('Client conflict events', () => {
  let db: Kysely<TestDb>;
  let client: Client<TestDb>;
  let engine: SyncEngine<TestDb>;

  async function seedConflict(id: string): Promise<void> {
    const now = Date.now();
    await sql`
      insert into ${sql.table('sync_outbox_commits')} (
        ${sql.ref('id')},
        ${sql.ref('client_commit_id')},
        ${sql.ref('status')},
        ${sql.ref('operations_json')},
        ${sql.ref('last_response_json')},
        ${sql.ref('error')},
        ${sql.ref('created_at')},
        ${sql.ref('updated_at')},
        ${sql.ref('attempt_count')},
        ${sql.ref('acked_commit_seq')},
        ${sql.ref('schema_version')}
      ) values (
        ${'outbox-1'},
        ${'commit-1'},
        ${'failed'},
        ${JSON.stringify([
          {
            table: 'tasks',
            row_id: 't1',
            op: 'upsert',
            payload: { id: 't1', title: 'local', server_version: 1 },
          },
        ])},
        ${null},
        ${'conflict'},
        ${now},
        ${now},
        ${1},
        ${null},
        ${1}
      )
    `.execute(db);

    await sql`
      insert into ${sql.table('sync_conflicts')} (
        ${sql.ref('id')},
        ${sql.ref('outbox_commit_id')},
        ${sql.ref('client_commit_id')},
        ${sql.ref('op_index')},
        ${sql.ref('result_status')},
        ${sql.ref('message')},
        ${sql.ref('code')},
        ${sql.ref('server_version')},
        ${sql.ref('server_row_json')},
        ${sql.ref('created_at')},
        ${sql.ref('resolved_at')},
        ${sql.ref('resolution')}
      ) values (
        ${id},
        ${'outbox-1'},
        ${'commit-1'},
        ${0},
        ${'conflict'},
        ${'server conflict'},
        ${'CONFLICT'},
        ${2},
        ${JSON.stringify({ id: 't1', title: 'server', server_version: 2 })},
        ${now},
        ${null},
        ${null}
      )
    `.execute(db);
  }

  async function runConflictCheck(
    clientInstance: Client<TestDb>
  ): Promise<void> {
    const checker = Reflect.get(clientInstance, 'checkForNewConflicts');
    if (typeof checker !== 'function') {
      throw new Error('Expected checkForNewConflicts to be callable');
    }
    await checker.call(clientInstance);
  }

  beforeEach(async () => {
    db = createDatabase<TestDb>({ dialect: createBunSqliteDialect({ path: ':memory:' }), family: 'sqlite' });
    await ensureClientSyncSchema(db);
    await db.schema
      .createTable('tasks')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('title', 'text', (col) => col.notNull())
      .addColumn('server_version', 'integer', (col) =>
        col.notNull().defaultTo(0)
      )
      .execute();

    const handlers: ClientHandlerCollection<TestDb> = [];
    client = new Client<TestDb>({
      db,
      transport: noopTransport,
      tableHandlers: handlers,
      clientId: 'client-1',
      actorId: 'u1',
      subscriptions: [],
    });

    engine = new SyncEngine<TestDb>({
      db,
      transport: noopTransport,
      handlers: handlers,
      actorId: 'u1',
      clientId: 'client-1',
      subscriptions: [],
    });
    Reflect.set(client, 'engine', engine);
  });

  afterEach(async () => {
    client.destroy();
    await db.destroy();
  });

  it('emits conflict:resolved with the resolved conflict payload', async () => {
    await seedConflict('conflict-1');

    const resolvedEvents: Array<{ id: string }> = [];
    client.on('conflict:resolved', (conflict) => {
      resolvedEvents.push({ id: conflict.id });
    });

    await client.resolveConflict('conflict-1', { strategy: 'keep-local' });

    expect(resolvedEvents).toEqual([{ id: 'conflict-1' }]);

    const resolvedRow = await sql<{ resolved_at: number | null }>`
      select ${sql.ref('resolved_at')}
      from ${sql.table('sync_conflicts')}
      where ${sql.ref('id')} = ${'conflict-1'}
      limit 1
    `.execute(db);
    expect(resolvedRow.rows[0]?.resolved_at).not.toBeNull();
  });

  it('emits conflict:new only once per unresolved conflict id', async () => {
    await seedConflict('conflict-1');

    const newEvents: string[] = [];
    client.on('conflict:new', (conflict) => {
      newEvents.push(conflict.id);
    });

    await runConflictCheck(client);
    await runConflictCheck(client);

    expect(newEvents).toEqual(['conflict-1']);
  });
});

describe('Client blob upload queue recovery', () => {
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
    db = createDatabase<TestDb>({ dialect: createBunSqliteDialect({ path: ':memory:' }), family: 'sqlite' });
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
      blobStorage: createMemoryBlobStorage(),
      clientId: 'client-1',
      actorId: 'u1',
      subscriptions: [],
    });
  });

  afterEach(async () => {
    client.destroy();
    await db.destroy();
  });

  it('requeues stale uploading rows and uploads them on the next queue run', async () => {
    await insertBlobOutboxRow({
      hash: 'sha256:stale-upload',
      status: 'uploading',
      attemptCount: 0,
      updatedAt: Date.now() - 31_000,
    });

    const result = await client.blobs!.processUploadQueue();

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

    await client.blobs!.processUploadQueue();

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

describe('Client inspector snapshot', () => {
  let db: Kysely<TestDb>;
  let client: Client<TestDb>;

  beforeEach(async () => {
    db = createDatabase<TestDb>({ dialect: createBunSqliteDialect({ path: ':memory:' }), family: 'sqlite' });
    await ensureClientSyncSchema(db);

    const handlers: ClientHandlerCollection<TestDb> = [];
    client = new Client<TestDb>({
      db,
      transport: noopTransport,
      tableHandlers: handlers,
      clientId: 'client-inspector',
      actorId: 'u1',
      subscriptions: [],
    });
  });

  afterEach(async () => {
    client.destroy();
    await db.destroy();
  });

  it('returns a serializable inspector snapshot', async () => {
    await client.start();
    await client.sync();

    const snapshot = await client.getInspectorSnapshot({ eventLimit: 20 });

    expect(snapshot).not.toBeNull();
    expect(snapshot?.version).toBe(1);
    expect(snapshot?.generatedAt).toBeGreaterThan(0);
    expect(Array.isArray(snapshot?.recentEvents)).toBe(true);
    expect(snapshot?.recentEvents.length).toBeGreaterThan(0);
    expect(snapshot?.diagnostics).toBeDefined();
  });
});
