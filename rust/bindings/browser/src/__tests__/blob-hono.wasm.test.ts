import { afterEach, describe, expect, it } from 'bun:test';
import {
  type BlobRef,
  type BlobStorageAdapter,
  createDatabase,
} from '@syncular/core';
import type { Kysely } from 'kysely';
import { createBunSqliteDialect } from '../../../../../packages/dialect-bun-sqlite/src';
import {
  type BlobTokenSigner,
  createBlobManager,
  createDatabaseBlobStorageAdapter,
  createHmacTokenSigner,
  ensureBlobStorageSchemaSqlite,
  type SyncBlobDb,
} from '../../../../../packages/server/src';
import { createBlobRoutes } from '../../../../../packages/server-hono/src/blobs';
import {
  closeNodeServer,
  createNodeHonoServer,
} from '../../../../../packages/testkit/src/hono-node-server';
import {
  openSyncularV2RustClient,
  type SyncularV2RustClient,
} from '../rust-client';

const ACTOR_ID = 'user-blob';
const AUTHORIZATION = 'Bearer blob-token';

describe('Syncular v2 Rust-owned SQLite blobs against Hono routes', () => {
  const servers: Array<ReturnType<typeof createNodeHonoServer>> = [];
  const clients: SyncularV2RustClient[] = [];
  const dbs: Array<Kysely<SyncBlobDb>> = [];

  afterEach(async () => {
    while (clients.length > 0) clients.pop()?.close();
    while (servers.length > 0) await closeNodeServer(servers.pop()!);
    while (dbs.length > 0) await dbs.pop()!.destroy();
  });

  it('uploads queued blobs and retrieves them through real Hono blob routes', async () => {
    const { authHeaders, client } = await openBlobHarness({
      clientId: 'client-rust-blob-hono',
    });

    const bytes = new TextEncoder().encode('rust-owned-sqlite-blob');
    const blob = await client.storeBlob(bytes, { mimeType: 'text/plain' });
    expect(blob).toMatchObject({
      size: bytes.length,
      mimeType: 'text/plain',
    });
    expect(await client.blobUploadQueueStats()).toEqual({
      pending: 1,
      uploading: 0,
      failed: 0,
    });

    await expect(client.processBlobUploadQueue()).resolves.toEqual({
      uploaded: 1,
      failed: 0,
    });
    expect(await client.blobUploadQueueStats()).toEqual({
      pending: 0,
      uploading: 0,
      failed: 0,
    });

    await client.clearBlobCache();
    expect(await client.isBlobLocal(blob.hash)).toBe(false);
    const downloaded = await client.retrieveBlob(blob);
    expect(new TextDecoder().decode(downloaded)).toBe('rust-owned-sqlite-blob');
    expect(await client.isBlobLocal(blob.hash)).toBe(true);
    expect(await client.blobCacheStats()).toEqual({
      count: 1,
      totalBytes: bytes.length,
    });

    expect(authHeaders).toEqual([AUTHORIZATION, AUTHORIZATION, AUTHORIZATION]);
  });

  it('dedupes identical local blob stores before upload', async () => {
    const { client } = await openBlobHarness({
      clientId: 'client-rust-blob-dedupe',
    });

    const bytes = new TextEncoder().encode('same-content');
    const first = await client.storeBlob(bytes, { mimeType: 'text/plain' });
    const second = await client.storeBlob(bytes, { mimeType: 'text/plain' });

    expect(second).toEqual(first);
    expect(await client.blobUploadQueueStats()).toEqual({
      pending: 1,
      uploading: 0,
      failed: 0,
    });
    expect(await client.blobCacheStats()).toEqual({
      count: 1,
      totalBytes: bytes.length,
    });
    expect(await client.processBlobUploadQueue()).toEqual({
      uploaded: 1,
      failed: 0,
    });
  });

  it('keeps queued blobs retryable on auth failures and fails after max attempts', async () => {
    const { client } = await openBlobHarness({
      clientId: 'client-rust-blob-auth-failure',
      authorization: 'Bearer stale-token',
    });

    const bytes = new TextEncoder().encode('auth-failure-blob');
    await client.storeBlob(bytes, { mimeType: 'text/plain' });

    await expect(client.processBlobUploadQueue()).resolves.toEqual({
      uploaded: 0,
      failed: 0,
    });
    expect(await client.blobUploadQueueStats()).toEqual({
      pending: 1,
      uploading: 0,
      failed: 0,
    });

    await waitForRetryBackoff();
    await expect(client.processBlobUploadQueue()).resolves.toEqual({
      uploaded: 0,
      failed: 0,
    });
    expect(await client.blobUploadQueueStats()).toEqual({
      pending: 1,
      uploading: 0,
      failed: 0,
    });

    await waitForRetryBackoff(2_100);
    await expect(client.processBlobUploadQueue()).resolves.toEqual({
      uploaded: 0,
      failed: 1,
    });
    expect(await client.blobUploadQueueStats()).toEqual({
      pending: 0,
      uploading: 0,
      failed: 1,
    });
  });

  it('keeps queued blobs pending after an interrupted upload and succeeds later', async () => {
    const { client } = await openBlobHarness({
      clientId: 'client-rust-blob-interrupted-upload',
      failDirectUploadAttempts: 1,
    });

    await client.storeBlob(new TextEncoder().encode('retryable-upload'), {
      mimeType: 'text/plain',
    });

    await expect(client.processBlobUploadQueue()).resolves.toEqual({
      uploaded: 0,
      failed: 0,
    });
    expect(await client.blobUploadQueueStats()).toEqual({
      pending: 1,
      uploading: 0,
      failed: 0,
    });

    await waitForRetryBackoff();
    await expect(client.processBlobUploadQueue()).resolves.toEqual({
      uploaded: 1,
      failed: 0,
    });
    expect(await client.blobUploadQueueStats()).toEqual({
      pending: 0,
      uploading: 0,
      failed: 0,
    });
  });

  it('rejects missing remote blobs without caching them locally', async () => {
    const { client } = await openBlobHarness({
      clientId: 'client-rust-blob-missing',
    });
    const missing: BlobRef = {
      hash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      size: 4,
      mimeType: 'application/octet-stream',
    };

    await expect(client.retrieveBlob(missing)).rejects.toThrow(/HTTP 404/);
    expect(await client.isBlobLocal(missing.hash)).toBe(false);
  });

  async function openBlobHarness(
    options: BlobHarnessOptions
  ): Promise<BlobHarness> {
    const db = createDatabase<SyncBlobDb>({
      dialect: createBunSqliteDialect({ path: ':memory:' }),
      family: 'sqlite',
    });
    dbs.push(db);
    await ensureBlobStorageSchemaSqlite(db);

    let routes: ReturnType<typeof createBlobRoutes> | undefined;
    let directUploadFailuresRemaining = options.failDirectUploadAttempts ?? 0;
    const app = {
      fetch(request: Request): Response | Promise<Response> {
        if (!routes) return new Response('not ready', { status: 503 });
        const url = new URL(request.url);
        if (!url.pathname.startsWith('/sync')) {
          return new Response('not found', { status: 404 });
        }
        if (
          directUploadFailuresRemaining > 0 &&
          request.method === 'PUT' &&
          url.pathname.startsWith('/sync/blobs/') &&
          url.pathname.endsWith('/upload')
        ) {
          directUploadFailuresRemaining -= 1;
          return new Response('interrupted upload', { status: 500 });
        }
        url.pathname = url.pathname.slice('/sync'.length) || '/';
        return routes.fetch(new Request(url, request));
      },
    } as Parameters<typeof createNodeHonoServer>[0];
    const server = createNodeHonoServer(app);
    servers.push(server);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (typeof address !== 'object' || !address) {
      throw new Error('Failed to resolve Hono blob test server address');
    }
    const baseUrl = `http://127.0.0.1:${address.port}/sync`;
    const authHeaders: string[] = [];
    const tokenSigner = createHmacTokenSigner('syncular-rust-blob-hono-secret');
    routes = createBlobRoutes({
      blobManager: createBlobManager({
        db,
        adapter: createBlobAdapter(db, tokenSigner, baseUrl),
      }),
      authenticate: async (c) => {
        const authorization = c.req.header('authorization');
        if (authorization) authHeaders.push(authorization);
        return authorization === AUTHORIZATION ? { actorId: ACTOR_ID } : null;
      },
      tokenSigner,
      db,
      canAccessBlob: async ({ actorId }) => actorId === ACTOR_ID,
    });

    const client = await openSyncularV2RustClient({
      config: {
        baseUrl,
        clientId: options.clientId,
        actorId: ACTOR_ID,
        fileName: `${options.clientId}.sqlite`,
        storage: 'memory',
        clearOnInit: true,
      },
    });
    clients.push(client);
    client.setAuthHeaders({
      authorization: options.authorization ?? AUTHORIZATION,
    });

    return { authHeaders, client };
  }
});

interface BlobHarnessOptions {
  clientId: string;
  authorization?: string;
  failDirectUploadAttempts?: number;
}

interface BlobHarness {
  authHeaders: string[];
  client: SyncularV2RustClient;
}

function createBlobAdapter(
  db: Kysely<SyncBlobDb>,
  tokenSigner: BlobTokenSigner,
  baseUrl: string
): BlobStorageAdapter {
  return createDatabaseBlobStorageAdapter({
    db,
    baseUrl,
    tokenSigner,
  });
}

function waitForRetryBackoff(delayMs = 1_100): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
