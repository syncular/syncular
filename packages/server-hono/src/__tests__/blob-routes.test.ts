import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { BlobStorageAdapter } from '@syncular/core';
import { createDatabase } from '@syncular/core';
import {
  type BlobTokenSigner,
  createBlobManager,
  createDatabaseBlobStorageAdapter,
  createHmacTokenSigner,
  ensureBlobStorageSchemaSqlite,
  type SyncBlobDb,
} from '@syncular/server';
import { Hono } from 'hono';
import type { Kysely } from 'kysely';
import { createBunSqliteDialect } from '../../../dialect-bun-sqlite/src';
import { createBlobRoutes } from '../blobs';

interface UploadInitResponse {
  exists: boolean;
  uploadUrl?: string;
  uploadMethod?: 'PUT' | 'POST';
}

interface UrlResponse {
  url: string;
}

interface CompleteResponse {
  ok: boolean;
  error?: string;
}

const ACTOR_HEADER = 'x-user-id';
const PARTITION_HEADER = 'x-partition-id';
const ACTOR_ID = 'user-1';
const INVALID_HASH = 'invalid-hash';

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

async function createHash(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${toHex(new Uint8Array(digest))}`;
}

async function signBlobToken(args: {
  signer: BlobTokenSigner;
  hash: string;
  action: 'upload' | 'download';
  size?: number;
  partitionId?: string;
}): Promise<string> {
  const partitionId = args.partitionId ?? 'default';
  if (args.action === 'upload') {
    if (typeof args.size !== 'number') {
      throw new Error('size is required for upload tokens');
    }
    return args.signer.sign(
      {
        hash: args.hash,
        partitionId,
        action: 'upload',
        size: args.size,
        expiresAt: Date.now() + 60_000,
      },
      60
    );
  }

  return args.signer.sign(
    {
      hash: args.hash,
      partitionId,
      action: 'download',
      expiresAt: Date.now() + 60_000,
    },
    60
  );
}

function createDefaultAdapter(
  db: Kysely<SyncBlobDb>,
  tokenSigner: BlobTokenSigner
): BlobStorageAdapter {
  return createDatabaseBlobStorageAdapter({
    db,
    baseUrl: 'http://localhost/sync',
    tokenSigner,
  });
}

function createFallbackAdapter(
  db: Kysely<SyncBlobDb>,
  tokenSigner: BlobTokenSigner
): BlobStorageAdapter {
  const adapter = createDefaultAdapter(db, tokenSigner);
  return {
    name: 'database-fallback',
    signUpload: adapter.signUpload,
    signDownload: adapter.signDownload,
    exists: adapter.exists,
    delete: adapter.delete,
    getMetadata: adapter.getMetadata,
  };
}

async function readStreamBytes(
  stream: ReadableStream<Uint8Array>
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || value.length === 0) continue;
    chunks.push(value);
    total += value.length;
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

function createStreamCapableAdapter(
  db: Kysely<SyncBlobDb>,
  tokenSigner: BlobTokenSigner
): {
  adapter: BlobStorageAdapter;
  getCounts: () => {
    putCalls: number;
    putStreamCalls: number;
    deleteCalls: number;
  };
} {
  const baseAdapter = createDefaultAdapter(db, tokenSigner);
  let putCalls = 0;
  let putStreamCalls = 0;
  let deleteCalls = 0;

  const adapter: BlobStorageAdapter = {
    name: 'database-stream-capable',
    signUpload: baseAdapter.signUpload,
    signDownload: baseAdapter.signDownload,
    exists: baseAdapter.exists,
    getMetadata: baseAdapter.getMetadata,
    get: baseAdapter.get,
    put: async (hash, data, metadata, options) => {
      putCalls += 1;
      await baseAdapter.put?.(hash, data, metadata, options);
    },
    putStream: async (hash, stream, metadata, options) => {
      putStreamCalls += 1;
      const bytes = await readStreamBytes(stream);
      await baseAdapter.put?.(hash, bytes, metadata, options);
    },
    delete: async (hash, options) => {
      deleteCalls += 1;
      await baseAdapter.delete(hash, options);
    },
  };

  return {
    adapter,
    getCounts: () => ({
      putCalls,
      putStreamCalls,
      deleteCalls,
    }),
  };
}

function buildApp(args: {
  db: Kysely<SyncBlobDb>;
  tokenSigner: BlobTokenSigner;
  adapter: BlobStorageAdapter;
  authenticate?: (
    c: Parameters<typeof createBlobRoutes>[0]['authenticate']
  ) => ReturnType<Parameters<typeof createBlobRoutes>[0]['authenticate']>;
  canAccessBlob?: Parameters<typeof createBlobRoutes>[0]['canAccessBlob'];
}): Hono {
  const blobManager = createBlobManager({
    db: args.db,
    adapter: args.adapter,
  });

  const app = new Hono();
  app.route(
    '/sync',
    createBlobRoutes({
      blobManager,
      authenticate: async (c) => {
        if (args.authenticate) {
          return args.authenticate(c);
        }
        const actorId = c.req.header(ACTOR_HEADER);
        return actorId ? { actorId } : null;
      },
      tokenSigner: args.tokenSigner,
      db: args.db,
      canAccessBlob: args.canAccessBlob ?? (async () => true),
    })
  );
  return app;
}

async function initiateUpload(args: {
  app: Hono;
  hash: string;
  size: number;
  mimeType?: string;
  partitionId?: string;
}): Promise<UploadInitResponse> {
  const response = await args.app.request(
    'http://localhost/sync/blobs/upload',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [ACTOR_HEADER]: ACTOR_ID,
        [PARTITION_HEADER]: args.partitionId ?? 'default',
      },
      body: JSON.stringify({
        hash: args.hash,
        size: args.size,
        mimeType: args.mimeType ?? 'application/octet-stream',
      }),
    }
  );

  expect(response.status).toBe(200);
  return (await response.json()) as UploadInitResponse;
}

describe('createBlobRoutes', () => {
  let db: Kysely<SyncBlobDb>;
  let tokenSigner: BlobTokenSigner;

  beforeEach(async () => {
    db = createDatabase<SyncBlobDb>({
      dialect: createBunSqliteDialect({ path: ':memory:' }),
      family: 'sqlite',
    });
    await ensureBlobStorageSchemaSqlite(db);
    tokenSigner = createHmacTokenSigner('blob-route-test-secret');
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('rejects unauthenticated upload initiation', async () => {
    const app = buildApp({
      db,
      tokenSigner,
      adapter: createDefaultAdapter(db, tokenSigner),
      authenticate: async () => null,
    });

    const hash = await createHash(new Uint8Array([1, 2, 3]));
    const response = await app.request('http://localhost/sync/blobs/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        hash,
        size: 3,
        mimeType: 'application/octet-stream',
      }),
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'UNAUTHENTICATED' });
  });

  it('rejects invalid direct-upload tokens', async () => {
    const app = buildApp({
      db,
      tokenSigner,
      adapter: createDefaultAdapter(db, tokenSigner),
    });

    const response = await app.request(
      `http://localhost/sync/blobs/${encodeURIComponent(`sha256:${'a'.repeat(64)}`)}/upload?token=invalid-token`,
      {
        method: 'PUT',
        body: new Uint8Array([1, 2, 3]),
      }
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'INVALID_TOKEN' });
  });

  it('rejects direct upload when body size does not match metadata', async () => {
    const app = buildApp({
      db,
      tokenSigner,
      adapter: createDefaultAdapter(db, tokenSigner),
    });

    const content = new Uint8Array([1, 2, 3, 4]);
    const hash = await createHash(content);
    await initiateUpload({
      app,
      hash,
      size: content.length,
    });

    const token = await signBlobToken({
      signer: tokenSigner,
      hash,
      action: 'upload',
      size: content.length,
      partitionId: 'default',
    });

    const response = await app.request(
      `http://localhost/sync/blobs/${encodeURIComponent(hash)}/upload?token=${encodeURIComponent(token)}`,
      {
        method: 'PUT',
        body: new Uint8Array([1, 2, 3]),
      }
    );

    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: string };
    expect(payload.error).toBe('SIZE_MISMATCH');
  });

  it('rejects direct upload when body hash does not match route hash', async () => {
    const app = buildApp({
      db,
      tokenSigner,
      adapter: createDefaultAdapter(db, tokenSigner),
    });

    const expected = new Uint8Array([1, 2, 3, 4]);
    const hash = await createHash(expected);
    await initiateUpload({
      app,
      hash,
      size: expected.length,
    });

    const token = await signBlobToken({
      signer: tokenSigner,
      hash,
      action: 'upload',
      size: expected.length,
      partitionId: 'default',
    });

    const response = await app.request(
      `http://localhost/sync/blobs/${encodeURIComponent(hash)}/upload?token=${encodeURIComponent(token)}`,
      {
        method: 'PUT',
        body: new Uint8Array([9, 9, 9, 9]),
      }
    );

    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: string };
    expect(payload.error).toBe('HASH_MISMATCH');
  });

  it('returns 404 for invalid hash format and 403 for forbidden actor access', async () => {
    const app = buildApp({
      db,
      tokenSigner,
      adapter: createDefaultAdapter(db, tokenSigner),
      canAccessBlob: async () => false,
    });

    const invalidHashResponse = await app.request(
      `http://localhost/sync/blobs/${INVALID_HASH}/url`,
      {
        headers: { [ACTOR_HEADER]: ACTOR_ID },
      }
    );
    expect(invalidHashResponse.status).toBe(404);
    expect(await invalidHashResponse.json()).toEqual({ error: 'NOT_FOUND' });

    const validHash = `sha256:${'b'.repeat(64)}`;
    const forbiddenResponse = await app.request(
      `http://localhost/sync/blobs/${encodeURIComponent(validHash)}/url`,
      {
        headers: { [ACTOR_HEADER]: ACTOR_ID },
      }
    );
    expect(forbiddenResponse.status).toBe(403);
    expect(await forbiddenResponse.json()).toEqual({ error: 'FORBIDDEN' });
  });

  it('rejects upload completion from a different actor', async () => {
    const app = buildApp({
      db,
      tokenSigner,
      adapter: createDefaultAdapter(db, tokenSigner),
    });

    const content = new TextEncoder().encode('actor-ownership-check');
    const hash = await createHash(content);
    const init = await initiateUpload({
      app,
      hash,
      size: content.length,
      mimeType: 'text/plain',
      partitionId: 'default',
    });
    const uploadResponse = await app.request(init.uploadUrl!, {
      method: init.uploadMethod ?? 'PUT',
      headers: { 'content-type': 'text/plain' },
      body: content,
    });
    expect(uploadResponse.status).toBe(200);

    const completeResponse = await app.request(
      `http://localhost/sync/blobs/${encodeURIComponent(hash)}/complete`,
      {
        method: 'POST',
        headers: { [ACTOR_HEADER]: 'user-2' },
      }
    );

    expect(completeResponse.status).toBe(403);
    expect(await completeResponse.json()).toEqual({ error: 'FORBIDDEN' });
  });

  it('uploads and downloads blobs through adapter put/get branches', async () => {
    const app = buildApp({
      db,
      tokenSigner,
      adapter: createDefaultAdapter(db, tokenSigner),
    });

    const content = new TextEncoder().encode('adapter-route-content');
    const hash = await createHash(content);
    const init = await initiateUpload({
      app,
      hash,
      size: content.length,
      mimeType: 'text/plain',
      partitionId: 'default',
    });

    expect(init.exists).toBe(false);
    expect(typeof init.uploadUrl).toBe('string');

    const uploadResponse = await app.request(init.uploadUrl!, {
      method: init.uploadMethod ?? 'PUT',
      headers: { 'content-type': 'text/plain' },
      body: content,
    });
    expect(uploadResponse.status).toBe(200);

    const completeResponse = await app.request(
      `http://localhost/sync/blobs/${encodeURIComponent(hash)}/complete`,
      {
        method: 'POST',
        headers: { [ACTOR_HEADER]: ACTOR_ID },
      }
    );
    expect(completeResponse.status).toBe(200);
    expect((await completeResponse.json()) as CompleteResponse).toEqual({
      ok: true,
      metadata: expect.anything(),
    });

    const downloadUrlResponse = await app.request(
      `http://localhost/sync/blobs/${encodeURIComponent(hash)}/url`,
      {
        headers: { [ACTOR_HEADER]: ACTOR_ID },
      }
    );
    expect(downloadUrlResponse.status).toBe(200);
    const { url } = (await downloadUrlResponse.json()) as UrlResponse;

    const downloadResponse = await app.request(url);
    expect(downloadResponse.status).toBe(200);
    expect(new Uint8Array(await downloadResponse.arrayBuffer())).toEqual(
      content
    );
  });

  it('prefers streaming direct upload when adapter exposes putStream', async () => {
    const streamHarness = createStreamCapableAdapter(db, tokenSigner);
    const app = buildApp({
      db,
      tokenSigner,
      adapter: streamHarness.adapter,
    });

    const content = new TextEncoder().encode('streaming-upload-content');
    const hash = await createHash(content);
    const init = await initiateUpload({
      app,
      hash,
      size: content.length,
      mimeType: 'text/plain',
      partitionId: 'default',
    });

    const uploadResponse = await app.request(init.uploadUrl!, {
      method: init.uploadMethod ?? 'PUT',
      headers: { 'content-type': 'text/plain' },
      body: content,
    });
    expect(uploadResponse.status).toBe(200);

    expect(streamHarness.getCounts()).toEqual({
      putCalls: 0,
      putStreamCalls: 1,
      deleteCalls: 0,
    });
  });

  it('deletes streamed upload on hash mismatch', async () => {
    const streamHarness = createStreamCapableAdapter(db, tokenSigner);
    const app = buildApp({
      db,
      tokenSigner,
      adapter: streamHarness.adapter,
    });

    const expected = new Uint8Array([1, 2, 3, 4, 5]);
    const hash = await createHash(expected);
    await initiateUpload({
      app,
      hash,
      size: expected.length,
      partitionId: 'default',
    });

    const uploadResponse = await app.request(
      `http://localhost/sync/blobs/${encodeURIComponent(hash)}/upload?token=${encodeURIComponent(
        await signBlobToken({
          signer: tokenSigner,
          hash,
          action: 'upload',
          size: expected.length,
          partitionId: 'default',
        })
      )}`,
      {
        method: 'PUT',
        body: new Uint8Array([9, 9, 9, 9, 9]),
      }
    );
    expect(uploadResponse.status).toBe(400);
    expect(await uploadResponse.json()).toEqual({
      error: 'HASH_MISMATCH',
      message: 'Content hash does not match',
    });

    expect(
      await streamHarness.adapter.exists(hash, { partitionId: 'default' })
    ).toBe(false);
    expect(streamHarness.getCounts()).toEqual({
      putCalls: 0,
      putStreamCalls: 1,
      deleteCalls: 1,
    });
  });

  it('uploads and downloads blobs through DB fallback branches when adapter lacks put/get', async () => {
    const app = buildApp({
      db,
      tokenSigner,
      adapter: createFallbackAdapter(db, tokenSigner),
    });

    const content = new TextEncoder().encode('database-fallback-content');
    const hash = await createHash(content);
    const init = await initiateUpload({
      app,
      hash,
      size: content.length,
      mimeType: 'text/plain',
      partitionId: 'default',
    });

    const uploadResponse = await app.request(init.uploadUrl!, {
      method: init.uploadMethod ?? 'PUT',
      headers: { 'content-type': 'text/plain' },
      body: content,
    });
    expect(uploadResponse.status).toBe(200);

    const completeResponse = await app.request(
      `http://localhost/sync/blobs/${encodeURIComponent(hash)}/complete`,
      {
        method: 'POST',
        headers: { [ACTOR_HEADER]: ACTOR_ID },
      }
    );
    expect(completeResponse.status).toBe(200);
    expect((await completeResponse.json()) as CompleteResponse).toEqual({
      ok: true,
      metadata: expect.anything(),
    });

    const urlResponse = await app.request(
      `http://localhost/sync/blobs/${encodeURIComponent(hash)}/url`,
      {
        headers: { [ACTOR_HEADER]: ACTOR_ID },
      }
    );
    expect(urlResponse.status).toBe(200);
    const payload = (await urlResponse.json()) as UrlResponse;

    const downloadResponse = await app.request(payload.url);
    expect(downloadResponse.status).toBe(200);
    expect(new Uint8Array(await downloadResponse.arrayBuffer())).toEqual(
      content
    );
  });

  it('isolates blob lookup by partition', async () => {
    const app = buildApp({
      db,
      tokenSigner,
      adapter: createDefaultAdapter(db, tokenSigner),
      authenticate: async (c) => {
        const actorId = c.req.header(ACTOR_HEADER);
        if (!actorId) return null;
        return {
          actorId,
          partitionId: c.req.header(PARTITION_HEADER) ?? 'default',
        };
      },
      canAccessBlob: async () => true,
    });

    const content = new TextEncoder().encode('partition-isolated-blob');
    const hash = await createHash(content);
    const init = await initiateUpload({
      app,
      hash,
      size: content.length,
      partitionId: 'tenant-a',
    });
    const uploadResponse = await app.request(init.uploadUrl!, {
      method: init.uploadMethod ?? 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: content,
    });
    expect(uploadResponse.status).toBe(200);

    const completeResponse = await app.request(
      `http://localhost/sync/blobs/${encodeURIComponent(hash)}/complete`,
      {
        method: 'POST',
        headers: {
          [ACTOR_HEADER]: ACTOR_ID,
          [PARTITION_HEADER]: 'tenant-a',
        },
      }
    );
    expect(completeResponse.status).toBe(200);

    const samePartitionUrl = await app.request(
      `http://localhost/sync/blobs/${encodeURIComponent(hash)}/url`,
      {
        headers: {
          [ACTOR_HEADER]: ACTOR_ID,
          [PARTITION_HEADER]: 'tenant-a',
        },
      }
    );
    expect(samePartitionUrl.status).toBe(200);

    const otherPartitionUrl = await app.request(
      `http://localhost/sync/blobs/${encodeURIComponent(hash)}/url`,
      {
        headers: {
          [ACTOR_HEADER]: ACTOR_ID,
          [PARTITION_HEADER]: 'tenant-b',
        },
      }
    );
    expect(otherPartitionUrl.status).toBe(404);
    expect(await otherPartitionUrl.json()).toEqual({ error: 'NOT_FOUND' });
  });
});
