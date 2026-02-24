import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { gzipSync } from 'node:zlib';
import {
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
    db = createDatabase<TestDb>({ dialect: createBunSqliteDialect({ path: ':memory:' }), family: 'sqlite' });
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
});
