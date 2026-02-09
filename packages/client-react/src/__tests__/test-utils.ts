/**
 * Test utilities for @syncular/client-react
 */

import type {
  SyncPullRequest,
  SyncPullResponse,
  SyncPushRequest,
  SyncPushResponse,
  SyncTransport,
} from '@syncular/client';
import { ClientTableRegistry, type SyncClientDb } from '@syncular/client';
import type { Kysely } from 'kysely';

/**
 * Create a mock transport for testing
 */
export function createMockTransport(
  options: {
    pullResponse?: Partial<SyncPullResponse>;
    pushResponse?: Partial<SyncPushResponse>;
    onPull?: (request: SyncPullRequest) => void;
    onPush?: (request: SyncPushRequest) => void;
  } = {}
): SyncTransport {
  return {
    async pull(request: SyncPullRequest): Promise<SyncPullResponse> {
      options.onPull?.(request);
      return {
        ok: true,
        subscriptions: [],
        ...options.pullResponse,
      };
    },
    async push(request: SyncPushRequest): Promise<SyncPushResponse> {
      options.onPush?.(request);
      return {
        ok: true,
        status: 'applied',
        results: request.operations.map((_, i) => ({
          opIndex: i,
          status: 'applied' as const,
        })),
        ...options.pushResponse,
      };
    },
    async fetchSnapshotChunk(): Promise<Uint8Array> {
      // Return empty gzipped NDJSON (empty array)
      return new Uint8Array();
    },
  };
}

/**
 * Create a mock shape registry
 */
export function createMockShapeRegistry<
  DB extends SyncClientDb = SyncClientDb,
>(): ClientTableRegistry<DB> {
  return new ClientTableRegistry<DB>();
}

/**
 * Create a mock in-memory database for testing
 */
export async function createMockDb<
  DB extends SyncClientDb = SyncClientDb,
>(): Promise<Kysely<DB>> {
  // Dynamic import to avoid bundling issues
  const { Kysely } = await import('kysely');
  const { BunSqliteDialect } = await import('kysely-bun-sqlite');
  const { Database } = await import('bun:sqlite');

  const db = new Kysely<DB>({
    dialect: new BunSqliteDialect({
      database: new Database(':memory:'),
    }),
  });

  // Create sync tables
  await db.schema
    .createTable('sync_subscription_state')
    .ifNotExists()
    .addColumn('state_id', 'text', (col) => col.notNull())
    .addColumn('subscription_id', 'text', (col) => col.notNull())
    .addColumn('shape', 'text', (col) => col.notNull())
    .addColumn('scopes_json', 'text', (col) => col.notNull())
    .addColumn('params_json', 'text', (col) => col.notNull())
    .addColumn('cursor', 'integer', (col) => col.notNull())
    .addColumn('bootstrap_state_json', 'text')
    .addColumn('status', 'text', (col) => col.notNull())
    .addColumn('created_at', 'integer', (col) => col.notNull())
    .addColumn('updated_at', 'integer', (col) => col.notNull())
    .addPrimaryKeyConstraint('pk_sync_subscription_state', [
      'state_id',
      'subscription_id',
    ])
    .execute();

  await db.schema
    .createTable('sync_outbox_commits')
    .ifNotExists()
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('client_commit_id', 'text', (col) => col.notNull())
    .addColumn('status', 'text', (col) => col.notNull())
    .addColumn('operations_json', 'text', (col) => col.notNull())
    .addColumn('last_response_json', 'text')
    .addColumn('error', 'text')
    .addColumn('created_at', 'integer', (col) => col.notNull())
    .addColumn('updated_at', 'integer', (col) => col.notNull())
    .addColumn('attempt_count', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('acked_commit_seq', 'integer')
    .addColumn('schema_version', 'integer', (col) => col.notNull().defaultTo(1))
    .execute();

  await db.schema
    .createTable('sync_conflicts')
    .ifNotExists()
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('outbox_commit_id', 'text', (col) => col.notNull())
    .addColumn('client_commit_id', 'text', (col) => col.notNull())
    .addColumn('op_index', 'integer', (col) => col.notNull())
    .addColumn('result_status', 'text', (col) => col.notNull())
    .addColumn('message', 'text', (col) => col.notNull())
    .addColumn('code', 'text')
    .addColumn('server_version', 'integer')
    .addColumn('server_row_json', 'text')
    .addColumn('created_at', 'integer', (col) => col.notNull())
    .addColumn('resolved_at', 'integer')
    .addColumn('resolution', 'text')
    .execute();

  await db.schema
    .createTable('sync_blob_cache')
    .ifNotExists()
    .addColumn('hash', 'text', (col) => col.primaryKey())
    .addColumn('size', 'integer', (col) => col.notNull())
    .addColumn('mime_type', 'text', (col) => col.notNull())
    .addColumn('body', 'blob', (col) => col.notNull())
    .addColumn('encrypted', 'integer', (col) => col.notNull())
    .addColumn('key_id', 'text')
    .addColumn('cached_at', 'integer', (col) => col.notNull())
    .addColumn('last_accessed_at', 'integer', (col) => col.notNull())
    .execute();

  await db.schema
    .createTable('sync_blob_outbox')
    .ifNotExists()
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    .addColumn('hash', 'text', (col) => col.notNull())
    .addColumn('size', 'integer', (col) => col.notNull())
    .addColumn('mime_type', 'text', (col) => col.notNull())
    .addColumn('body', 'blob', (col) => col.notNull())
    .addColumn('encrypted', 'integer', (col) => col.notNull())
    .addColumn('key_id', 'text')
    .addColumn('status', 'text', (col) => col.notNull())
    .addColumn('attempt_count', 'integer', (col) => col.notNull())
    .addColumn('error', 'text')
    .addColumn('created_at', 'integer', (col) => col.notNull())
    .addColumn('updated_at', 'integer', (col) => col.notNull())
    .execute();

  return db;
}

/**
 * Wait for a condition to be true
 */
export async function waitFor(
  condition: () => boolean,
  timeout = 1000
): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeout) {
      throw new Error('waitFor timeout');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Flush promises
 */
export function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
