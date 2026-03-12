import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { gzipSync } from 'node:zlib';
import {
  createDatabase,
  encodeSnapshotRows,
  type ScopeValues,
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

interface ScopedItemsTable {
  id: string;
  project_id: string;
  name: string;
}

interface TestDb extends SyncClientDb {
  items: ItemsTable;
  scoped_items: ScopedItemsTable;
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

function toScopeValueArray(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
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

  it('applies gzip-compressed chunk streams without DecompressionStream', async () => {
    const rows = Array.from({ length: 128 }, (_, index) => ({
      id: `${index + 1}`,
      name: `Item ${index + 1}`,
    }));
    const encoded = encodeSnapshotRows(rows);
    const compressed = new Uint8Array(gzipSync(encoded));

    const originalDecompressionStream = globalThis.DecompressionStream;
    Object.defineProperty(globalThis, 'DecompressionStream', {
      value: undefined,
      configurable: true,
      writable: true,
    });

    try {
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
          return createStreamFromBytes(compressed, 73);
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
    } finally {
      Object.defineProperty(globalThis, 'DecompressionStream', {
        value: originalDecompressionStream,
        configurable: true,
        writable: true,
      });
    }
  });

  it('materializes chunked bootstrap snapshots for afterPull plugins via streaming transport', async () => {
    const firstRows = Array.from({ length: 1200 }, (_, index) => ({
      id: `${index + 1}`,
      name: `Item ${index + 1}`,
    }));
    const secondRows = Array.from({ length: 1200 }, (_, index) => ({
      id: `${index + 1201}`,
      name: `Item ${index + 1201}`,
    }));
    const firstChunk = new Uint8Array(gzipSync(encodeSnapshotRows(firstRows)));
    const secondChunk = new Uint8Array(
      gzipSync(encodeSnapshotRows(secondRows))
    );

    let streamFetchCount = 0;
    let activeStreamFetches = 0;
    let maxConcurrentStreamFetches = 0;
    const transport: SyncTransport = {
      async sync() {
        return {};
      },
      async fetchSnapshotChunk() {
        throw new Error('fetchSnapshotChunk should not be used');
      },
      async fetchSnapshotChunkStream({ chunkId }) {
        streamFetchCount += 1;
        activeStreamFetches += 1;
        maxConcurrentStreamFetches = Math.max(
          maxConcurrentStreamFetches,
          activeStreamFetches
        );
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeStreamFetches -= 1;

        if (chunkId === 'chunk-1') {
          return createStreamFromBytes(firstChunk, 193);
        }
        if (chunkId === 'chunk-2') {
          return createStreamFromBytes(secondChunk, 211);
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

    let pluginSawRows = 0;
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
      plugins: [
        {
          name: 'after-pull-observer',
          async afterPull(_ctx, { response }) {
            pluginSawRows =
              response.subscriptions[0]?.snapshots?.[0]?.rows.length ?? 0;
            return response;
          },
        },
      ],
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
          nextCursor: 2,
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
    expect(Number(countResult.rows[0]?.count ?? 0)).toBe(
      firstRows.length + secondRows.length
    );
    expect(pluginSawRows).toBe(firstRows.length + secondRows.length);
    expect(streamFetchCount).toBe(2);
    expect(maxConcurrentStreamFetches).toBe(1);
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

  it('can commit bootstrap subscriptions independently', async () => {
    await db.schema
      .createTable('scoped_items')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('project_id', 'text', (col) => col.notNull())
      .addColumn('name', 'text', (col) => col.notNull())
      .execute();

    const itemsRows = Array.from({ length: 3 }, (_, index) => ({
      id: `${index + 1}`,
      name: `Item ${index + 1}`,
    }));
    const scopedRows = Array.from({ length: 2 }, (_, index) => ({
      id: `scoped-${index + 1}`,
      project_id: 'alpha',
      name: `Scoped ${index + 1}`,
    }));

    const transport: SyncTransport = {
      async sync() {
        return {};
      },
      async fetchSnapshotChunk() {
        throw new Error('fetchSnapshotChunk should not be used');
      },
    };

    const handlers: ClientHandlerCollection<TestDb> = [
      createClientHandler({
        table: 'items',
        scopes: ['items:{id}'],
      }),
      {
        table: 'scoped_items',
        scopePatterns: ['scoped_items:{project}'],
        async applySnapshot() {
          throw new Error('scoped bootstrap failed');
        },
        async clearAll() {
          return;
        },
        async applyChange() {
          return;
        },
      },
    ];

    const options = {
      clientId: 'client-1',
      subscriptions: [
        {
          id: 'items-sub',
          table: 'items',
          scopes: {},
        },
        {
          id: 'scoped-sub',
          table: 'scoped_items',
          scopes: { project: 'alpha' },
        },
      ],
      stateId: 'default',
      bootstrapApplyMode: 'per-subscription' as const,
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
          nextCursor: 3,
          commits: [],
          snapshots: [
            {
              table: 'items',
              rows: itemsRows,
              isFirstPage: true,
              isLastPage: true,
            },
          ],
        },
        {
          id: 'scoped-sub',
          status: 'active',
          scopes: { project: 'alpha' },
          bootstrap: true,
          bootstrapState: null,
          nextCursor: 3,
          commits: [],
          snapshots: [
            {
              table: 'scoped_items',
              rows: scopedRows,
              isFirstPage: true,
              isLastPage: true,
            },
          ],
        },
      ],
    };

    await expect(
      applyPullResponse(db, transport, handlers, options, pullState, response)
    ).rejects.toThrow('scoped bootstrap failed');

    const itemCount = await sql<{ count: number }>`
      select count(*) as count
      from ${sql.table('items')}
    `.execute(db);
    expect(Number(itemCount.rows[0]?.count ?? 0)).toBe(itemsRows.length);

    const scopedCount = await sql<{ count: number }>`
      select count(*) as count
      from ${sql.table('scoped_items')}
    `.execute(db);
    expect(Number(scopedCount.rows[0]?.count ?? 0)).toBe(0);

    const stateRows = await db
      .selectFrom('sync_subscription_state')
      .select(['subscription_id', 'cursor'])
      .where('state_id', '=', 'default')
      .orderBy('subscription_id')
      .execute();

    expect(stateRows).toEqual([
      {
        subscription_id: 'items-sub',
        cursor: 3,
      },
    ]);
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

  it('ignores stale incremental responses that would rewind cursor state', async () => {
    const transport: SyncTransport = {
      async sync() {
        return {};
      },
      async fetchSnapshotChunk() {
        throw new Error('fetchSnapshotChunk should not be used');
      },
      async fetchSnapshotChunkStream() {
        throw new Error('fetchSnapshotChunkStream should not be used');
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

    const stalePullState = await buildPullRequest(db, options);

    const freshResponse: SyncPullResponse = {
      ok: true,
      subscriptions: [
        {
          id: 'items-sub',
          status: 'active',
          scopes: {},
          bootstrap: false,
          bootstrapState: null,
          nextCursor: 2,
          commits: [
            {
              commitSeq: 2,
              changes: [
                {
                  table: 'items',
                  row_id: 'item-1',
                  op: 'upsert',
                  row_version: 2,
                  row_json: {
                    id: 'item-1',
                    name: 'latest',
                  },
                  scopes: {},
                },
              ],
            },
          ],
          snapshots: [],
        },
      ],
    };

    const staleResponse: SyncPullResponse = {
      ok: true,
      subscriptions: [
        {
          id: 'items-sub',
          status: 'active',
          scopes: {},
          bootstrap: false,
          bootstrapState: null,
          nextCursor: 1,
          commits: [
            {
              commitSeq: 1,
              changes: [
                {
                  table: 'items',
                  row_id: 'item-1',
                  op: 'upsert',
                  row_version: 1,
                  row_json: {
                    id: 'item-1',
                    name: 'stale',
                  },
                  scopes: {},
                },
              ],
            },
          ],
          snapshots: [],
        },
      ],
    };

    await applyPullResponse(
      db,
      transport,
      handlers,
      options,
      stalePullState,
      freshResponse
    );
    await applyPullResponse(
      db,
      transport,
      handlers,
      options,
      stalePullState,
      staleResponse
    );

    const item = await db
      .selectFrom('items')
      .select(['id', 'name'])
      .where('id', '=', 'item-1')
      .executeTakeFirst();
    expect(item?.name).toBe('latest');

    const state = await db
      .selectFrom('sync_subscription_state')
      .select(['cursor'])
      .where('state_id', '=', 'default')
      .where('subscription_id', '=', 'items-sub')
      .executeTakeFirst();
    expect(Number(state?.cursor ?? -1)).toBe(2);
  });

  it('passes commit metadata to applyChange handler context', async () => {
    const transport: SyncTransport = {
      async sync() {
        return {};
      },
      async fetchSnapshotChunk() {
        return new Uint8Array();
      },
    };

    const appliedContexts: Array<{
      commitSeq: number | null | undefined;
      actorId: string | null | undefined;
      createdAt: string | null | undefined;
    }> = [];

    const handlers: ClientHandlerCollection<TestDb> = [
      {
        table: 'items',
        async applySnapshot() {},
        async clearAll() {},
        async applyChange(ctx) {
          appliedContexts.push({
            commitSeq: ctx.commitSeq,
            actorId: ctx.actorId,
            createdAt: ctx.createdAt,
          });
        },
      },
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
          bootstrap: false,
          bootstrapState: null,
          nextCursor: 7,
          commits: [
            {
              commitSeq: 7,
              actorId: 'remote-user',
              createdAt: '2026-02-28T12:00:00.000Z',
              changes: [
                {
                  table: 'items',
                  row_id: 'item-ctx',
                  op: 'upsert',
                  row_version: 1,
                  row_json: { id: 'item-ctx', name: 'ctx-test' },
                  scopes: {},
                },
              ],
            },
          ],
          snapshots: [],
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

    expect(appliedContexts).toEqual([
      {
        commitSeq: 7,
        actorId: 'remote-user',
        createdAt: '2026-02-28T12:00:00.000Z',
      },
    ]);
  });

  it('uses applyChanges for contiguous same-table incremental changes', async () => {
    const transport: SyncTransport = {
      async sync() {
        return {};
      },
      async fetchSnapshotChunk() {
        return new Uint8Array();
      },
    };

    let applyChangeCalls = 0;
    let applyChangesCalls = 0;
    const baseHandler = createClientHandler<TestDb, 'items'>({
      table: 'items',
      scopes: ['items:{id}'],
    });

    const handlers: ClientHandlerCollection<TestDb> = [
      {
        ...baseHandler,
        async applyChange(ctx, change) {
          applyChangeCalls += 1;
          await baseHandler.applyChange(ctx, change);
        },
        async applyChanges(ctx, changes) {
          applyChangesCalls += 1;
          if (!baseHandler.applyChanges) {
            throw new Error('Expected applyChanges to be available');
          }
          await baseHandler.applyChanges(ctx, changes);
        },
      },
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
          bootstrap: false,
          bootstrapState: null,
          nextCursor: 9,
          commits: [
            {
              commitSeq: 9,
              actorId: 'remote-user',
              createdAt: '2026-03-01T12:00:00.000Z',
              changes: [
                {
                  table: 'items',
                  row_id: 'item-1',
                  op: 'upsert',
                  row_version: 1,
                  row_json: { id: 'item-1', name: 'One' },
                  scopes: {},
                },
                {
                  table: 'items',
                  row_id: 'item-2',
                  op: 'upsert',
                  row_version: 1,
                  row_json: { id: 'item-2', name: 'Two' },
                  scopes: {},
                },
              ],
            },
          ],
          snapshots: [],
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

    expect(applyChangesCalls).toBe(1);
    expect(applyChangeCalls).toBe(0);
  });

  it('flushes batched upserts when the same row appears twice in one commit', async () => {
    const transport: SyncTransport = {
      async sync() {
        return {};
      },
      async fetchSnapshotChunk() {
        return new Uint8Array();
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
          bootstrap: false,
          bootstrapState: null,
          nextCursor: 10,
          commits: [
            {
              commitSeq: 10,
              actorId: 'remote-user',
              createdAt: '2026-03-01T12:00:00.000Z',
              changes: [
                {
                  table: 'items',
                  row_id: 'item-1',
                  op: 'upsert',
                  row_version: 1,
                  row_json: { id: 'item-1', name: 'One' },
                  scopes: {},
                },
                {
                  table: 'items',
                  row_id: 'item-1',
                  op: 'upsert',
                  row_version: 2,
                  row_json: { id: 'item-1', name: 'Two' },
                  scopes: {},
                },
              ],
            },
          ],
          snapshots: [],
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

    const row = await db
      .selectFrom('items')
      .select(['id', 'name'])
      .where('id', '=', 'item-1')
      .executeTakeFirstOrThrow();

    expect(row.name).toBe('Two');
  });

  it('clears stale rows during same-scope bootstrap by default', async () => {
    const transport: SyncTransport = {
      async sync() {
        return {};
      },
      async fetchSnapshotChunk() {
        throw new Error('fetchSnapshotChunk should not be used');
      },
    };

    await db.schema
      .createTable('scoped_items')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('project_id', 'text', (col) => col.notNull())
      .addColumn('name', 'text', (col) => col.notNull())
      .execute();

    const handlers: ClientHandlerCollection<TestDb> = [
      createClientHandler({
        table: 'scoped_items',
        scopes: ['project:{project_id}'],
      }),
    ];

    const options = {
      clientId: 'client-1',
      subscriptions: [
        {
          id: 'scoped-sub',
          table: 'scoped_items',
          scopes: { project_id: 'p1' },
        },
      ],
      stateId: 'default',
    };

    const firstState = await buildPullRequest(db, options);
    await applyPullResponse(db, transport, handlers, options, firstState, {
      ok: true,
      subscriptions: [
        {
          id: 'scoped-sub',
          status: 'active',
          scopes: { project_id: 'p1' },
          bootstrap: true,
          bootstrapState: null,
          nextCursor: 1,
          commits: [],
          snapshots: [
            {
              table: 'scoped_items',
              rows: [
                { id: 'p1-a', project_id: 'p1', name: 'A' },
                { id: 'p1-b', project_id: 'p1', name: 'B' },
              ],
              isFirstPage: true,
              isLastPage: true,
            },
          ],
        },
      ],
    });

    const secondState = await buildPullRequest(db, options);
    await applyPullResponse(db, transport, handlers, options, secondState, {
      ok: true,
      subscriptions: [
        {
          id: 'scoped-sub',
          status: 'active',
          scopes: { project_id: 'p1' },
          bootstrap: true,
          bootstrapState: null,
          nextCursor: 2,
          commits: [],
          snapshots: [
            {
              table: 'scoped_items',
              rows: [{ id: 'p1-a', project_id: 'p1', name: 'A' }],
              isFirstPage: true,
              isLastPage: true,
            },
          ],
        },
      ],
    });

    const rows = await db
      .selectFrom('scoped_items')
      .select(['id'])
      .orderBy('id', 'asc')
      .execute();
    expect(rows.map((row) => row.id)).toEqual(['p1-a']);
  });

  it('clears previously authorized rows when bootstrap scopes narrow', async () => {
    const transport: SyncTransport = {
      async sync() {
        return {};
      },
      async fetchSnapshotChunk() {
        throw new Error('fetchSnapshotChunk should not be used');
      },
    };

    await db.schema
      .createTable('scoped_items')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('project_id', 'text', (col) => col.notNull())
      .addColumn('name', 'text', (col) => col.notNull())
      .execute();

    const handlers: ClientHandlerCollection<TestDb> = [
      createClientHandler({
        table: 'scoped_items',
        scopes: ['project:{project_id}'],
      }),
    ];

    const options = {
      clientId: 'client-1',
      subscriptions: [
        {
          id: 'scoped-sub',
          table: 'scoped_items',
          scopes: { project_id: ['p1', 'p2'] },
        },
      ],
      stateId: 'default',
    };

    const firstState = await buildPullRequest(db, options);
    await applyPullResponse(db, transport, handlers, options, firstState, {
      ok: true,
      subscriptions: [
        {
          id: 'scoped-sub',
          status: 'active',
          scopes: { project_id: ['p1', 'p2'] },
          bootstrap: true,
          bootstrapState: null,
          nextCursor: 1,
          commits: [],
          snapshots: [
            {
              table: 'scoped_items',
              rows: [
                { id: 'p1-a', project_id: 'p1', name: 'A' },
                { id: 'p2-a', project_id: 'p2', name: 'B' },
              ],
              isFirstPage: true,
              isLastPage: true,
            },
          ],
        },
      ],
    });

    const secondState = await buildPullRequest(db, options);
    await applyPullResponse(db, transport, handlers, options, secondState, {
      ok: true,
      subscriptions: [
        {
          id: 'scoped-sub',
          status: 'active',
          scopes: { project_id: 'p2' },
          bootstrap: true,
          bootstrapState: null,
          nextCursor: 2,
          commits: [],
          snapshots: [
            {
              table: 'scoped_items',
              rows: [{ id: 'p2-a', project_id: 'p2', name: 'B' }],
              isFirstPage: true,
              isLastPage: true,
            },
          ],
        },
      ],
    });

    const rows = await db
      .selectFrom('scoped_items')
      .select(['id'])
      .orderBy('id', 'asc')
      .execute();
    expect(rows.map((row) => row.id)).toEqual(['p2-a']);
  });

  it('clears only the removed scope slice when bootstrap scopes narrow on one key', async () => {
    const transport: SyncTransport = {
      async sync() {
        return {};
      },
      async fetchSnapshotChunk() {
        throw new Error('fetchSnapshotChunk should not be used');
      },
    };

    await db.schema
      .createTable('tracked_items')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('project_id', 'text', (col) => col.notNull())
      .addColumn('name', 'text', (col) => col.notNull())
      .execute();

    const clearedScopes: ScopeValues[] = [];

    const handlers: ClientHandlerCollection<TestDb> = [
      createClientHandler({
        table: 'tracked_items',
        scopes: ['project:{project_id}'],
        clearAll: async (ctx) => {
          clearedScopes.push(ctx.scopes);
          await sql`
              delete from ${sql.table('tracked_items')}
              where ${sql.ref('project_id')} in ${sql`(${sql.join(
                toScopeValueArray(ctx.scopes.project_id).map((value) =>
                  sql.val(value)
                )
              )})`}
            `.execute(ctx.trx);
        },
      }),
    ];

    const options = {
      clientId: 'client-1',
      subscriptions: [
        {
          id: 'tracked-sub',
          table: 'tracked_items',
          scopes: { project_id: ['p1', 'p2'] },
        },
      ],
      stateId: 'default',
    };

    const firstState = await buildPullRequest(db, options);
    await applyPullResponse(db, transport, handlers, options, firstState, {
      ok: true,
      subscriptions: [
        {
          id: 'tracked-sub',
          status: 'active',
          scopes: { project_id: ['p1', 'p2'] },
          bootstrap: true,
          bootstrapState: null,
          nextCursor: 1,
          commits: [],
          snapshots: [
            {
              table: 'tracked_items',
              rows: [
                { id: 'p1-a', project_id: 'p1', name: 'A' },
                { id: 'p2-a', project_id: 'p2', name: 'B' },
              ],
              isFirstPage: true,
              isLastPage: true,
            },
          ],
        },
      ],
    });

    const secondState = await buildPullRequest(db, options);
    await applyPullResponse(db, transport, handlers, options, secondState, {
      ok: true,
      subscriptions: [
        {
          id: 'tracked-sub',
          status: 'active',
          scopes: { project_id: 'p2' },
          bootstrap: true,
          bootstrapState: null,
          nextCursor: 2,
          commits: [],
          snapshots: [
            {
              table: 'tracked_items',
              rows: [{ id: 'p2-a', project_id: 'p2', name: 'B' }],
              isFirstPage: true,
              isLastPage: true,
            },
          ],
        },
      ],
    });

    expect(clearedScopes).toEqual([{ project_id: 'p1' }]);
  });
});
