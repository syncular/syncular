import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { gzipSync } from 'node:zlib';
import {
  createDatabase,
  encodeSnapshotRows,
  type SyncPullResponse,
  type SyncTransport,
} from '@syncular/core';
import { type Kysely, sql } from 'kysely';
import { createBunSqliteDialect } from '../../dialect-bun-sqlite/src';
import type { ClientHandlerCollection } from './handlers/collection';
import { createClientHandler } from './handlers/create-handler';
import { ensureClientSyncSchema } from './migrate';
import { applyPullResponse, buildPullRequest } from './pull-engine';
import type { SyncClientDb } from './schema';

interface ItemsTable {
  id: string;
  name: string;
}

interface TestDb extends SyncClientDb {
  items: ItemsTable;
}

function createStreamFromBytes(
  bytes: Uint8Array,
  chunkSize = 1024
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let index = 0; index < bytes.length; index += chunkSize) {
        controller.enqueue(bytes.subarray(index, index + chunkSize));
      }
      controller.close();
    },
  });
}

describe('applyPullResponse chunk streaming', () => {
  let db: Kysely<TestDb>;

  beforeEach(async () => {
    db = createDatabase<TestDb>({
      dialect: createBunSqliteDialect({ path: ':memory:' }),
      family: 'sqlite',
    });
    await ensureClientSyncSchema(db);
    await db.schema
      .createTable('items')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('name', 'text', (col) => col.notNull())
      .execute();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('applies chunked bootstrap snapshots using streaming transport', async () => {
    const rows = Array.from({ length: 5000 }, (_, index) => ({
      id: `${index + 1}`,
      name: `Item ${index + 1}`,
    }));
    const encoded = encodeSnapshotRows(rows);
    const compressed = new Uint8Array(gzipSync(encoded));

    let streamFetchCount = 0;
    const transport: SyncTransport = {
      async sync() {
        return {};
      },
      async fetchSnapshotChunk() {
        throw new Error('fetchSnapshotChunk should not be used');
      },
      async fetchSnapshotChunkStream() {
        streamFetchCount += 1;
        return createStreamFromBytes(compressed, 257);
      },
    };

    const handlers: ClientHandlerCollection<TestDb> = [
      createClientHandler({
        table: 'items',
        scopes: ['items:{id}'],
      }),
    ];

    const options = {
      clientId: 'client-1',
      subscriptions: [
        {
          id: 'items-sub',
          table: 'items',
          scopes: {},
        },
      ],
      stateId: 'default',
    };

    const pullState = await buildPullRequest(db, options);

    const response: SyncPullResponse = {
      ok: true,
      subscriptions: [
        {
          id: 'items-sub',
          status: 'active',
          scopes: {},
          bootstrap: true,
          bootstrapState: null,
          nextCursor: 1,
          commits: [],
          snapshots: [
            {
              table: 'items',
              rows: [],
              chunks: [
                {
                  id: 'chunk-1',
                  byteLength: compressed.length,
                  sha256: '',
                  encoding: 'json-row-frame-v1',
                  compression: 'gzip',
                },
              ],
              isFirstPage: true,
              isLastPage: true,
            },
          ],
        },
      ],
    };

    await applyPullResponse(
      db,
      transport,
      handlers,
      options,
      pullState,
      response
    );

    const countResult = await sql<{ count: number }>`
      select count(*) as count
      from ${sql.table('items')}
    `.execute(db);
    expect(Number(countResult.rows[0]?.count ?? 0)).toBe(rows.length);
    expect(streamFetchCount).toBe(1);
  });

  it('rolls back partial chunked bootstrap when a later chunk fails', async () => {
    const firstRows = Array.from({ length: 1500 }, (_, index) => ({
      id: `${index + 1}`,
      name: `Item ${index + 1}`,
    }));
    const secondRows = Array.from({ length: 1500 }, (_, index) => ({
      id: `${index + 1501}`,
      name: `Item ${index + 1501}`,
    }));

    const firstChunk = new Uint8Array(gzipSync(encodeSnapshotRows(firstRows)));
    const secondChunk = new Uint8Array(
      gzipSync(encodeSnapshotRows(secondRows))
    );

    let failSecondChunk = true;
    const transport: SyncTransport = {
      async sync() {
        return {};
      },
      async fetchSnapshotChunk() {
        throw new Error('fetchSnapshotChunk should not be used');
      },
      async fetchSnapshotChunkStream({ chunkId }) {
        if (chunkId === 'chunk-2' && failSecondChunk) {
          throw new Error('chunk-2 missing');
        }
        if (chunkId === 'chunk-1') {
          return createStreamFromBytes(firstChunk, 317);
        }
        if (chunkId === 'chunk-2') {
          return createStreamFromBytes(secondChunk, 503);
        }
        throw new Error(`Unexpected chunk id: ${chunkId}`);
      },
    };

    const handlers: ClientHandlerCollection<TestDb> = [
      createClientHandler({
        table: 'items',
        scopes: ['items:{id}'],
      }),
    ];

    const options = {
      clientId: 'client-1',
      subscriptions: [
        {
          id: 'items-sub',
          table: 'items',
          scopes: {},
        },
      ],
      stateId: 'default',
    };

    const response: SyncPullResponse = {
      ok: true,
      subscriptions: [
        {
          id: 'items-sub',
          status: 'active',
          scopes: {},
          bootstrap: true,
          bootstrapState: null,
          nextCursor: 12,
          commits: [],
          snapshots: [
            {
              table: 'items',
              rows: [],
              chunks: [
                {
                  id: 'chunk-1',
                  byteLength: firstChunk.length,
                  sha256: '',
                  encoding: 'json-row-frame-v1',
                  compression: 'gzip',
                },
                {
                  id: 'chunk-2',
                  byteLength: secondChunk.length,
                  sha256: '',
                  encoding: 'json-row-frame-v1',
                  compression: 'gzip',
                },
              ],
              isFirstPage: true,
              isLastPage: true,
            },
          ],
        },
      ],
    };

    const firstPullState = await buildPullRequest(db, options);
    await expect(
      applyPullResponse(
        db,
        transport,
        handlers,
        options,
        firstPullState,
        response
      )
    ).rejects.toThrow('chunk-2 missing');

    const countAfterFailure = await sql<{ count: number }>`
      select count(*) as count
      from ${sql.table('items')}
    `.execute(db);
    expect(Number(countAfterFailure.rows[0]?.count ?? 0)).toBe(0);

    const stateAfterFailure = await db
      .selectFrom('sync_subscription_state')
      .select(({ fn }) => fn.countAll().as('total'))
      .where('state_id', '=', 'default')
      .where('subscription_id', '=', 'items-sub')
      .executeTakeFirst();
    expect(Number(stateAfterFailure?.total ?? 0)).toBe(0);

    failSecondChunk = false;
    const retryPullState = await buildPullRequest(db, options);
    await applyPullResponse(
      db,
      transport,
      handlers,
      options,
      retryPullState,
      response
    );

    const countAfterRetry = await sql<{ count: number }>`
      select count(*) as count
      from ${sql.table('items')}
    `.execute(db);
    expect(Number(countAfterRetry.rows[0]?.count ?? 0)).toBe(
      firstRows.length + secondRows.length
    );
  });

  it('verifies sha256 integrity for streamed chunk snapshots', async () => {
    const rows = Array.from({ length: 1000 }, (_, index) => ({
      id: `${index + 1}`,
      name: `Item ${index + 1}`,
    }));
    const chunk = new Uint8Array(gzipSync(encodeSnapshotRows(rows)));

    const transport: SyncTransport = {
      async sync() {
        return {};
      },
      async fetchSnapshotChunk() {
        throw new Error('fetchSnapshotChunk should not be used');
      },
      async fetchSnapshotChunkStream() {
        return createStreamFromBytes(chunk, 211);
      },
    };

    const handlers: ClientHandlerCollection<TestDb> = [
      createClientHandler({
        table: 'items',
        scopes: ['items:{id}'],
      }),
    ];

    const options = {
      clientId: 'client-1',
      subscriptions: [
        {
          id: 'items-sub',
          table: 'items',
          scopes: {},
        },
      ],
      stateId: 'default',
    };

    const response: SyncPullResponse = {
      ok: true,
      subscriptions: [
        {
          id: 'items-sub',
          status: 'active',
          scopes: {},
          bootstrap: true,
          bootstrapState: null,
          nextCursor: 5,
          commits: [],
          snapshots: [
            {
              table: 'items',
              rows: [],
              chunks: [
                {
                  id: 'chunk-1',
                  byteLength: chunk.length,
                  sha256: 'deadbeef',
                  encoding: 'json-row-frame-v1',
                  compression: 'gzip',
                },
              ],
              isFirstPage: true,
              isLastPage: true,
            },
          ],
        },
      ],
    };

    const pullState = await buildPullRequest(db, options);
    await expect(
      applyPullResponse(db, transport, handlers, options, pullState, response)
    ).rejects.toThrow('Snapshot chunk integrity check failed');

    const countAfterFailure = await sql<{ count: number }>`
      select count(*) as count
      from ${sql.table('items')}
    `.execute(db);
    expect(Number(countAfterFailure.rows[0]?.count ?? 0)).toBe(0);

    const stateAfterFailure = await db
      .selectFrom('sync_subscription_state')
      .select(({ fn }) => fn.countAll().as('total'))
      .where('state_id', '=', 'default')
      .where('subscription_id', '=', 'items-sub')
      .executeTakeFirst();
    expect(Number(stateAfterFailure?.total ?? 0)).toBe(0);
  });

  it('uses custom sha256 override for streamed chunk integrity checks', async () => {
    const rows = Array.from({ length: 256 }, (_, index) => ({
      id: `${index + 1}`,
      name: `Item ${index + 1}`,
    }));
    const chunk = new Uint8Array(gzipSync(encodeSnapshotRows(rows)));

    const transport: SyncTransport = {
      async sync() {
        return {};
      },
      async fetchSnapshotChunk() {
        throw new Error('fetchSnapshotChunk should not be used');
      },
      async fetchSnapshotChunkStream() {
        return createStreamFromBytes(chunk, 137);
      },
    };

    const handlers: ClientHandlerCollection<TestDb> = [
      createClientHandler({
        table: 'items',
        scopes: ['items:{id}'],
      }),
    ];

    let sha256CallCount = 0;
    const options = {
      clientId: 'client-1',
      subscriptions: [
        {
          id: 'items-sub',
          table: 'items',
          scopes: {},
        },
      ],
      stateId: 'default',
      sha256: async () => {
        sha256CallCount += 1;
        return 'expected-hash';
      },
    };

    const response: SyncPullResponse = {
      ok: true,
      subscriptions: [
        {
          id: 'items-sub',
          status: 'active',
          scopes: {},
          bootstrap: true,
          bootstrapState: null,
          nextCursor: 8,
          commits: [],
          snapshots: [
            {
              table: 'items',
              rows: [],
              chunks: [
                {
                  id: 'chunk-1',
                  byteLength: chunk.length,
                  sha256: 'expected-hash',
                  encoding: 'json-row-frame-v1',
                  compression: 'gzip',
                },
              ],
              isFirstPage: true,
              isLastPage: true,
            },
          ],
        },
      ],
    };

    const pullState = await buildPullRequest(db, options);
    await applyPullResponse(
      db,
      transport,
      handlers,
      options,
      pullState,
      response
    );

    expect(sha256CallCount).toBe(1);

    const countResult = await sql<{ count: number }>`
      select count(*) as count
      from ${sql.table('items')}
    `.execute(db);
    expect(Number(countResult.rows[0]?.count ?? 0)).toBe(rows.length);
  });

  it('rolls back when a later chunk fails custom sha256 verification', async () => {
    const firstRows = Array.from({ length: 512 }, (_, index) => ({
      id: `${index + 1}`,
      name: `Item ${index + 1}`,
    }));
    const secondRows = Array.from({ length: 512 }, (_, index) => ({
      id: `${index + 513}`,
      name: `Item ${index + 513}`,
    }));

    const firstChunk = new Uint8Array(gzipSync(encodeSnapshotRows(firstRows)));
    const secondChunk = new Uint8Array(
      gzipSync(encodeSnapshotRows(secondRows))
    );

    const transport: SyncTransport = {
      async sync() {
        return {};
      },
      async fetchSnapshotChunk() {
        throw new Error('fetchSnapshotChunk should not be used');
      },
      async fetchSnapshotChunkStream({ chunkId }) {
        if (chunkId === 'chunk-1') {
          return createStreamFromBytes(firstChunk, 173);
        }
        if (chunkId === 'chunk-2') {
          return createStreamFromBytes(secondChunk, 173);
        }
        throw new Error(`Unexpected chunk id: ${chunkId}`);
      },
    };

    const handlers: ClientHandlerCollection<TestDb> = [
      createClientHandler({
        table: 'items',
        scopes: ['items:{id}'],
      }),
    ];

    let sha256CallCount = 0;
    const options = {
      clientId: 'client-1',
      subscriptions: [
        {
          id: 'items-sub',
          table: 'items',
          scopes: {},
        },
      ],
      stateId: 'default',
      sha256: async () => {
        sha256CallCount += 1;
        return sha256CallCount === 1 ? 'hash-1' : 'bad-hash';
      },
    };

    const response: SyncPullResponse = {
      ok: true,
      subscriptions: [
        {
          id: 'items-sub',
          status: 'active',
          scopes: {},
          bootstrap: true,
          bootstrapState: null,
          nextCursor: 15,
          commits: [],
          snapshots: [
            {
              table: 'items',
              rows: [],
              chunks: [
                {
                  id: 'chunk-1',
                  byteLength: firstChunk.length,
                  sha256: 'hash-1',
                  encoding: 'json-row-frame-v1',
                  compression: 'gzip',
                },
                {
                  id: 'chunk-2',
                  byteLength: secondChunk.length,
                  sha256: 'hash-2',
                  encoding: 'json-row-frame-v1',
                  compression: 'gzip',
                },
              ],
              isFirstPage: true,
              isLastPage: true,
            },
          ],
        },
      ],
    };

    const pullState = await buildPullRequest(db, options);
    await expect(
      applyPullResponse(db, transport, handlers, options, pullState, response)
    ).rejects.toThrow('Snapshot chunk integrity check failed');

    expect(sha256CallCount).toBe(2);

    const countAfterFailure = await sql<{ count: number }>`
      select count(*) as count
      from ${sql.table('items')}
    `.execute(db);
    expect(Number(countAfterFailure.rows[0]?.count ?? 0)).toBe(0);

    const stateAfterFailure = await db
      .selectFrom('sync_subscription_state')
      .select(({ fn }) => fn.countAll().as('total'))
      .where('state_id', '=', 'default')
      .where('subscription_id', '=', 'items-sub')
      .executeTakeFirst();
    expect(Number(stateAfterFailure?.total ?? 0)).toBe(0);
  });

  it('does not call custom sha256 override for chunks without hash references', async () => {
    const rows = Array.from({ length: 128 }, (_, index) => ({
      id: `${index + 1}`,
      name: `Item ${index + 1}`,
    }));
    const chunk = new Uint8Array(gzipSync(encodeSnapshotRows(rows)));

    const transport: SyncTransport = {
      async sync() {
        return {};
      },
      async fetchSnapshotChunk() {
        throw new Error('fetchSnapshotChunk should not be used');
      },
      async fetchSnapshotChunkStream() {
        return createStreamFromBytes(chunk, 89);
      },
    };

    const handlers: ClientHandlerCollection<TestDb> = [
      createClientHandler({
        table: 'items',
        scopes: ['items:{id}'],
      }),
    ];

    let sha256CallCount = 0;
    const options = {
      clientId: 'client-1',
      subscriptions: [
        {
          id: 'items-sub',
          table: 'items',
          scopes: {},
        },
      ],
      stateId: 'default',
      sha256: async () => {
        sha256CallCount += 1;
        return 'unused';
      },
    };

    const response: SyncPullResponse = {
      ok: true,
      subscriptions: [
        {
          id: 'items-sub',
          status: 'active',
          scopes: {},
          bootstrap: true,
          bootstrapState: null,
          nextCursor: 19,
          commits: [],
          snapshots: [
            {
              table: 'items',
              rows: [],
              chunks: [
                {
                  id: 'chunk-1',
                  byteLength: chunk.length,
                  sha256: '',
                  encoding: 'json-row-frame-v1',
                  compression: 'gzip',
                },
              ],
              isFirstPage: true,
              isLastPage: true,
            },
          ],
        },
      ],
    };

    const pullState = await buildPullRequest(db, options);
    await applyPullResponse(
      db,
      transport,
      handlers,
      options,
      pullState,
      response
    );

    expect(sha256CallCount).toBe(0);

    const countResult = await sql<{ count: number }>`
      select count(*) as count
      from ${sql.table('items')}
    `.execute(db);
    expect(Number(countResult.rows[0]?.count ?? 0)).toBe(rows.length);
  });
});
