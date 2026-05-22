import { afterEach, describe, expect, it } from 'bun:test';
import {
  type BlobRef,
  type BlobStorageAdapter,
  createDatabase,
} from '@syncular/core';
import type { Kysely } from 'kysely';
import { createBunSqliteDialect } from '../../../dialect-bun-sqlite/src';
import {
  type BlobTokenSigner,
  createBlobManager,
  createDatabaseBlobStorageAdapter,
  createHmacTokenSigner,
  ensureBlobStorageSchemaSqlite,
  type SyncBlobDb,
} from '../../../server/src';
import { createBlobRoutes } from '../../../server-hono/src/blobs';
import {
  closeNodeServer,
  createNodeHonoServer,
} from '../../../testkit/src/hono-node-server';
import {
  openSyncularRustClient,
  type SyncularRustClient,
} from '../rust-client';
import { syncConformance } from './fixtures/sync-conformance';

const BLOB_SCENARIO = syncConformance.blob;
const ACTOR_ID = BLOB_SCENARIO.browserActorId;
const AUTHORIZATION = BLOB_SCENARIO.authorization;

describe('Syncular Rust-owned SQLite blobs against Hono routes', () => {
  const servers: Array<ReturnType<typeof createNodeHonoServer>> = [];
  const clients: SyncularRustClient[] = [];
  const dbs: Array<Kysely<SyncBlobDb>> = [];

  afterEach(async () => {
    while (clients.length > 0) clients.pop()?.close();
    while (servers.length > 0) await closeNodeServer(servers.pop()!);
    while (dbs.length > 0) await dbs.pop()!.destroy();
  });

  it('uploads queued blobs and retrieves them through real Hono blob routes', async () => {
    const { authHeaders, client } = await openBlobHarness({
      clientId: BLOB_SCENARIO.browserClientId,
    });

    const bytes = new TextEncoder().encode(BLOB_SCENARIO.browserText);
    const blob = await client.storeBlob(bytes, {
      mimeType: BLOB_SCENARIO.textMimeType,
    });
    expect(blob).toMatchObject({
      size: bytes.length,
      mimeType: BLOB_SCENARIO.textMimeType,
    });
    expect(await client.blobUploadQueueStats()).toEqual(
      BLOB_SCENARIO.expectedUploadQueueBefore
    );

    await expect(client.processBlobUploadQueue()).resolves.toEqual(
      BLOB_SCENARIO.expectedProcessUploaded
    );
    expect(await client.blobUploadQueueStats()).toEqual(
      BLOB_SCENARIO.expectedUploadQueueAfter
    );

    await client.clearBlobCache();
    expect(await client.isBlobLocal(blob.hash)).toBe(false);
    const downloaded = await client.retrieveBlob(blob);
    expect(new TextDecoder().decode(downloaded)).toBe(
      BLOB_SCENARIO.browserText
    );
    expect(await client.isBlobLocal(blob.hash)).toBe(true);
    expect(await client.blobCacheStats()).toEqual({
      count: 1,
      totalBytes: bytes.length,
    });

    expect(authHeaders).toEqual(
      Array.from(
        { length: BLOB_SCENARIO.expectedAuthHeaderCount },
        () => AUTHORIZATION
      )
    );
  });

  it('encrypts browser blob bodies before cache, upload, and download', async () => {
    const { client, db } = await openBlobHarness({
      clientId: `${BLOB_SCENARIO.browserClientId}-encrypted`,
    });
    await client.setBlobEncryption({
      keys: { default: new Uint8Array(32).fill(9) },
    });

    const bytes = new TextEncoder().encode(BLOB_SCENARIO.browserText);
    const blob = await client.storeBlob(bytes, {
      mimeType: BLOB_SCENARIO.textMimeType,
    });
    expect(blob.encrypted).toBe(true);
    expect(blob.keyId).toBe('default');
    expect(blob.size).toBeGreaterThan(bytes.length);

    expect(await client.processBlobUploadQueue()).toEqual(
      BLOB_SCENARIO.expectedProcessUploaded
    );
    const stored = await db
      .selectFrom('sync_blobs')
      .select(['body'])
      .where('hash', '=', blob.hash)
      .executeTakeFirstOrThrow();
    expect(Buffer.from(stored.body)).not.toEqual(Buffer.from(bytes));

    await client.clearBlobCache();
    const downloaded = await client.retrieveBlob(blob);
    expect(new TextDecoder().decode(downloaded)).toBe(
      BLOB_SCENARIO.browserText
    );
  });

  it('dedupes identical local blob stores before upload', async () => {
    const { client } = await openBlobHarness({
      clientId: BLOB_SCENARIO.dedupeClientId,
    });

    const bytes = new TextEncoder().encode(BLOB_SCENARIO.dedupeText);
    const first = await client.storeBlob(bytes, {
      mimeType: BLOB_SCENARIO.textMimeType,
    });
    const second = await client.storeBlob(bytes, {
      mimeType: BLOB_SCENARIO.textMimeType,
    });

    expect(second).toEqual(first);
    expect(await client.blobUploadQueueStats()).toEqual(
      BLOB_SCENARIO.expectedUploadQueueBefore
    );
    expect(await client.blobCacheStats()).toEqual({
      count: 1,
      totalBytes: bytes.length,
    });
    expect(await client.processBlobUploadQueue()).toEqual(
      BLOB_SCENARIO.expectedProcessUploaded
    );
  });

  it('keeps queued blobs retryable on auth failures and fails after max attempts', async () => {
    const { client } = await openBlobHarness({
      clientId: BLOB_SCENARIO.authFailureClientId,
      authorization: BLOB_SCENARIO.staleAuthorization,
    });

    const bytes = new TextEncoder().encode(BLOB_SCENARIO.authFailureText);
    await client.storeBlob(bytes, { mimeType: BLOB_SCENARIO.textMimeType });

    await expect(client.processBlobUploadQueue()).resolves.toEqual(
      BLOB_SCENARIO.expectedProcessRetryableFailure
    );
    expect(await client.blobUploadQueueStats()).toEqual(
      BLOB_SCENARIO.expectedUploadQueueBefore
    );

    await waitForRetryBackoff();
    await expect(client.processBlobUploadQueue()).resolves.toEqual(
      BLOB_SCENARIO.expectedProcessRetryableFailure
    );
    expect(await client.blobUploadQueueStats()).toEqual(
      BLOB_SCENARIO.expectedUploadQueueBefore
    );

    await waitForRetryBackoff(250);
    await expect(client.processBlobUploadQueue()).resolves.toEqual(
      BLOB_SCENARIO.expectedProcessPermanentFailure
    );
    expect(await client.blobUploadQueueStats()).toEqual(
      BLOB_SCENARIO.expectedFailedQueue
    );
  });

  it('keeps queued blobs pending after an interrupted upload and succeeds later', async () => {
    const { client } = await openBlobHarness({
      clientId: BLOB_SCENARIO.interruptedUploadClientId,
      failDirectUploadAttempts: 1,
    });

    await client.storeBlob(
      new TextEncoder().encode(BLOB_SCENARIO.interruptedUploadText),
      {
        mimeType: BLOB_SCENARIO.textMimeType,
      }
    );

    await expect(client.processBlobUploadQueue()).resolves.toEqual(
      BLOB_SCENARIO.expectedProcessRetryableFailure
    );
    expect(await client.blobUploadQueueStats()).toEqual(
      BLOB_SCENARIO.expectedUploadQueueBefore
    );

    await waitForRetryBackoff();
    await expect(client.processBlobUploadQueue()).resolves.toEqual(
      BLOB_SCENARIO.expectedProcessUploaded
    );
    expect(await client.blobUploadQueueStats()).toEqual(
      BLOB_SCENARIO.expectedUploadQueueAfter
    );
  });

  it('rejects missing remote blobs without caching them locally', async () => {
    const { client } = await openBlobHarness({
      clientId: BLOB_SCENARIO.missingClientId,
    });
    const missing: BlobRef = {
      hash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      size: 4,
      mimeType: 'application/octet-stream',
    };

    await expect(client.retrieveBlob(missing)).rejects.toThrow(/HTTP 404/);
    expect(await client.isBlobLocal(missing.hash)).toBe(false);
  });

  it('prunes the oldest blob cache entries to the shared byte budget', async () => {
    const { client } = await openBlobHarness({
      clientId: BLOB_SCENARIO.cachePruneClientId,
    });
    const oldBlob = await client.storeBlob(
      new TextEncoder().encode(BLOB_SCENARIO.cachePruneOldText),
      { mimeType: BLOB_SCENARIO.textMimeType }
    );
    await waitForRetryBackoff(5);
    const newBlob = await client.storeBlob(
      new TextEncoder().encode(BLOB_SCENARIO.cachePruneNewText),
      { mimeType: BLOB_SCENARIO.textMimeType }
    );

    expect(await client.blobCacheStats()).toEqual(
      BLOB_SCENARIO.expectedCacheBeforePrune
    );
    expect(client.pruneBlobCache(BLOB_SCENARIO.cachePruneMaxBytes)).toBe(
      BLOB_SCENARIO.expectedCachePrunedBytes
    );
    expect(await client.blobCacheStats()).toEqual(
      BLOB_SCENARIO.expectedCacheAfterPrune
    );
    expect(await client.isBlobLocal(oldBlob.hash)).toBe(false);
    expect(await client.isBlobLocal(newBlob.hash)).toBe(true);
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

    const client = await openSyncularRustClient({
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

    return { authHeaders, client, db };
  }
});

interface BlobHarnessOptions {
  clientId: string;
  authorization?: string;
  failDirectUploadAttempts?: number;
}

interface BlobHarness {
  authHeaders: string[];
  client: SyncularRustClient;
  db: Kysely<SyncBlobDb>;
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

function waitForRetryBackoff(delayMs = 150): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
