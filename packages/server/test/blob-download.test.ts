/**
 * `handleBlobDownload` (SPEC.md §5.9.5): the row-derived authorization gate,
 * streamed inline delivery, and the additive delegated-presign issuance — a
 * signed URL is minted ONLY after the authorization check passes, never as a
 * bearer capability from the blobId alone. `handleBlobUpload` (§5.9.3): the
 * size cap holds before and while the body is read.
 */
import { describe, expect, test } from 'bun:test';
import { encodeRow } from '@syncular/core';
import {
  type BlobStore,
  blobIdFor,
  compileSchema,
  handleBlobDownload,
  handleBlobUpload,
  handleBlobUploadGrant,
  MemoryBlobStore,
  S3BlobStore,
  type ServerSchema,
  SqliteServerStorage,
  type SyncRequestContext,
  s3PresignedBlobUrls,
} from '@syncular/server';
import { startS3Stub } from './s3-stub';

const PARTITION = 'part-1';
const NOW = 1_750_000_000_000;

const SCHEMA: ServerSchema = {
  version: 1,
  tables: [
    {
      name: 'tasks',
      primaryKey: 'id',
      scopes: ['project:{project_id}'],
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'project_id', type: 'string', nullable: false },
        { name: 'attachment', type: 'blob_ref', nullable: true },
      ],
    },
  ],
};

async function seedReferencedBlob(
  storage: SqliteServerStorage,
  blobId: string,
  scopeValue: string,
): Promise<void> {
  await storage.ensureSchema(compileSchema(SCHEMA));
  const tx = await storage.begin(PARTITION);
  if (tx.setBlobRefs === undefined) throw new Error('no setBlobRefs');
  // The reference index carries the row's stored scopes for the §3.4 check.
  const columns = SCHEMA.tables[0]?.columns ?? [];
  await tx.upsertRow('tasks', {
    rowId: 'row-1',
    serverVersion: 1,
    scopes: { project_id: scopeValue },
    payload: encodeRow(columns, ['row-1', scopeValue, null]),
  });
  await tx.setBlobRefs('tasks', 'row-1', [blobId]);
  await tx.commit();
}

function baseCtx(
  storage: SqliteServerStorage,
  blobs: BlobStore,
  overrides?: Partial<SyncRequestContext>,
): SyncRequestContext {
  return {
    partition: PARTITION,
    actorId: 'actor-1',
    schema: SCHEMA,
    storage,
    // segments is required on the config but unused by the download path.
    segments: undefined as never,
    blobs,
    resolveScopes: () => ({ project_id: ['p1'] }),
    clock: () => NOW,
    ...overrides,
  };
}

describe('handleBlobDownload authorization (§5.9.5)', () => {
  test('serves bytes when a referencing row authorizes the actor', async () => {
    const storage = new SqliteServerStorage();
    const blobs = new MemoryBlobStore();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const blobId = await blobIdFor(bytes);
    await blobs.put(PARTITION, blobId, bytes, NOW, 'image/png');
    await seedReferencedBlob(storage, blobId, 'p1');

    const result = await handleBlobDownload(baseCtx(storage, blobs), blobId);
    if ('url' in result) throw new Error('expected inline delivery');
    expect(result.byteLength).toBe(bytes.length);
    expect(
      new Uint8Array(await new Response(result.body).arrayBuffer()),
    ).toEqual(bytes);
    // §5.9.5: inline bytes carry the stored media type, never sniffed.
    expect(result.headers['Content-Type']).toBe('image/png');
    expect(result.headers['X-Content-Type-Options']).toBe('nosniff');
    expect(result.headers.Vary).toBe('Authorization');
    expect(await storage.listPartitionRegistry()).toEqual([
      {
        partition: PARTITION,
        logEpoch: expect.any(String),
        epochRequired: false,
        lastAuthenticatedAtMs: NOW,
      },
    ]);
  });

  test('serves JSON and untyped blobs as octet-stream', async () => {
    for (const mediaType of ['application/json; charset=utf-8', undefined]) {
      const storage = new SqliteServerStorage();
      const blobs = new MemoryBlobStore();
      const bytes = new TextEncoder().encode('{"url":"https://x.test/"}');
      const blobId = await blobIdFor(bytes);
      await blobs.put(PARTITION, blobId, bytes, NOW, mediaType);
      await seedReferencedBlob(storage, blobId, 'p1');
      const result = await handleBlobDownload(baseCtx(storage, blobs), blobId);
      // A JSON body is reserved for the signed-URL envelope (§5.9.5).
      expect(result.headers['Content-Type']).toBe('application/octet-stream');
    }
  });

  test('denies (403) when no referencing row is authorized', async () => {
    const storage = new SqliteServerStorage();
    const blobs = new MemoryBlobStore();
    const bytes = new Uint8Array([5, 6]);
    const blobId = await blobIdFor(bytes);
    await blobs.put(PARTITION, blobId, bytes, NOW);
    // The only referencing row is in project p2; the actor holds only p1.
    await seedReferencedBlob(storage, blobId, 'p2');

    await expect(
      handleBlobDownload(baseCtx(storage, blobs), blobId),
    ).rejects.toThrow(/no referencing row/);
  });

  test('reads no blob byte before authorization passes', async () => {
    const storage = new SqliteServerStorage();
    const inner = new MemoryBlobStore();
    const bytes = new Uint8Array([5, 6, 7]);
    const blobId = await blobIdFor(bytes);
    await inner.put(PARTITION, blobId, bytes, NOW);
    await seedReferencedBlob(storage, blobId, 'p2');
    const reads: string[] = [];
    const blobs: BlobStore = {
      put: (...args) => inner.put(...args),
      has: (...args) => inner.has(...args),
      get: (partition, id) => {
        reads.push('get');
        return inner.get(partition, id);
      },
      open: async (partition, id) => {
        reads.push('open');
        const entry = await inner.get(partition, id);
        return entry === undefined
          ? undefined
          : {
              record: entry.record,
              body:
                new Response(entry.bytes.slice()).body ?? new ReadableStream(),
              byteLength: entry.bytes.length,
            };
      },
      sweepOrphans: (...args) => inner.sweepOrphans(...args),
      delete: (...args) => inner.delete(...args),
    };
    await expect(
      handleBlobDownload(baseCtx(storage, blobs), blobId),
    ).rejects.toThrow(/no referencing row/);
    expect(reads).toEqual([]);
    // The authorized actor streams through `open`, never `get`.
    const result = await handleBlobDownload(
      baseCtx(storage, blobs, {
        resolveScopes: () => ({ project_id: ['p2'] }),
      }),
      blobId,
    );
    if ('url' in result) throw new Error('expected inline delivery');
    expect(reads).toEqual(['open']);
    expect(
      new Uint8Array(await new Response(result.body).arrayBuffer()),
    ).toEqual(bytes);
  });
});

describe('handleBlobUpload size cap (§5.9.3)', () => {
  const upload = (body: BodyInit | ReadableStream, headers: HeadersInit) =>
    new Request('http://host/blobs/x', {
      method: 'PUT',
      body,
      headers,
      duplex: 'half',
    } as RequestInit);

  test('a declared Content-Length over the cap fails before any byte is read', async () => {
    const storage = new SqliteServerStorage();
    const blobs = new MemoryBlobStore();
    const blobId = await blobIdFor(new Uint8Array([1]));
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          controller.enqueue(new Uint8Array(8));
        },
      },
      { highWaterMark: 0 },
    );
    await expect(
      handleBlobUpload(
        baseCtx(storage, blobs, { maxBlobBytes: 10 }),
        blobId,
        upload(body, { 'content-length': '11' }),
      ),
    ).rejects.toMatchObject({ code: 'blob.too_large' });
    expect(pulls).toBe(0);
  });

  test('an undeclared body stops being read once it passes the cap', async () => {
    const storage = new SqliteServerStorage();
    const blobs = new MemoryBlobStore();
    const blobId = await blobIdFor(new Uint8Array([1]));
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          controller.enqueue(new Uint8Array(8));
        },
      },
      { highWaterMark: 0 },
    );
    await expect(
      handleBlobUpload(
        baseCtx(storage, blobs, { maxBlobBytes: 10 }),
        blobId,
        upload(body, {}),
      ),
    ).rejects.toMatchObject({ code: 'blob.too_large' });
    // Two 8-byte chunks pass the 10-byte cap; the stream is never drained.
    expect(pulls).toBe(2);
    expect(await blobs.has(PARTITION, blobId)).toBe(false);
  });

  test('stores a body within the cap with its media type', async () => {
    const storage = new SqliteServerStorage();
    const blobs = new MemoryBlobStore();
    const bytes = new Uint8Array([1, 2, 3]);
    const blobId = await blobIdFor(bytes);
    await handleBlobUpload(
      baseCtx(storage, blobs, { maxBlobBytes: 10 }),
      blobId,
      upload(bytes, { 'content-type': 'image/png' }),
    );
    expect((await blobs.get(PARTITION, blobId))?.record.mediaType).toBe(
      'image/png',
    );
  });
});

describe('handleBlobDownload delegated presign (§5.9.5 additive url)', () => {
  const stub = startS3Stub({
    bucket: 'dl-blobs',
    region: 'auto',
    accessKeyId: 'SYNCULARTESTAKID',
    secretAccessKey: 'syncular-test-secret',
    now: () => NOW,
  });

  test('issues a signed URL AFTER the authz check; a bare fetch redeems it', async () => {
    const storage = new SqliteServerStorage();
    const blobs = new S3BlobStore({
      endpoint: stub.url,
      region: 'auto',
      bucket: 'dl-blobs',
      accessKeyId: 'SYNCULARTESTAKID',
      secretAccessKey: 'syncular-test-secret',
      keyPrefix: 'dl/',
    });
    const bytes = new Uint8Array([7, 7, 7, 7, 7]);
    const blobId = await blobIdFor(bytes);
    await blobs.put(PARTITION, blobId, bytes, NOW);
    await seedReferencedBlob(storage, blobId, 'p1');

    const result = await handleBlobDownload(
      baseCtx(storage, blobs, {
        blobSignedUrls: s3PresignedBlobUrls(blobs, { ttlSeconds: 600 }),
      }),
      blobId,
    );
    if (!('url' in result)) throw new Error('expected a presigned url');
    expect(result.headers['Cache-Control']).toBe('private, max-age=0');
    expect(result.urlExpiresAtMs).toBe((Math.floor(NOW / 1000) + 600) * 1000);
    // §5.9.5 equivalence: the signed key embeds the blobId.
    expect(new URL(result.url).pathname).toContain(blobId.replace(':', '/'));
    const response = await fetch(result.url);
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    stub.stop();
  });

  test('a forbidden download never mints a URL', async () => {
    const storage = new SqliteServerStorage();
    const blobs = new MemoryBlobStore();
    const bytes = new Uint8Array([8]);
    const blobId = await blobIdFor(bytes);
    await blobs.put(PARTITION, blobId, bytes, NOW);
    await seedReferencedBlob(storage, blobId, 'p2'); // unauthorized

    let presignCalled = false;
    await expect(
      handleBlobDownload(
        baseCtx(storage, blobs, {
          blobSignedUrls: {
            presign: () => {
              presignCalled = true;
              return { url: 'x', urlExpiresAtMs: 0 };
            },
          },
        }),
        blobId,
      ),
    ).rejects.toThrow(/no referencing row/);
    expect(presignCalled).toBe(false);
  });
});

describe('handleBlobUploadGrant (§5.9.3 presigned upload)', () => {
  test('host-auth only (no scope check) mints a single PUT within the cap', async () => {
    const storage = new SqliteServerStorage();
    const blobs = new MemoryBlobStore();
    const bytes = new Uint8Array([1, 2, 3]);
    const blobId = await blobIdFor(bytes);
    let presignCalls = 0;
    const grant = await handleBlobUploadGrant(
      baseCtx(storage, blobs, {
        // No referencing row exists yet — grant authz is host-auth only.
        blobUploadUrls: {
          presign: ({ blobId: id, byteLength }) => {
            presignCalls += 1;
            return {
              url: `presigned://put/${id}?len=${byteLength}`,
              urlExpiresAtMs: NOW + 900_000,
            };
          },
        },
      }),
      { blobId, byteLength: bytes.length },
    );
    expect(presignCalls).toBe(1);
    expect(grant.url).toContain(blobId);
    expect(grant.urlExpiresAtMs).toBe(NOW + 900_000);
    expect(grant.present).toBeUndefined();
    expect((await storage.listPartitionRegistry())[0]).toMatchObject({
      partition: PARTITION,
      lastAuthenticatedAtMs: NOW,
    });
  });

  test('an already-present blob returns present:true and no url (idempotent)', async () => {
    const storage = new SqliteServerStorage();
    const blobs = new MemoryBlobStore();
    const bytes = new Uint8Array([9, 9]);
    const blobId = await blobIdFor(bytes);
    await blobs.put(PARTITION, blobId, bytes, NOW);
    let presignCalls = 0;
    const grant = await handleBlobUploadGrant(
      baseCtx(storage, blobs, {
        blobUploadUrls: {
          presign: () => {
            presignCalls += 1;
            return { url: 'x', urlExpiresAtMs: 0 };
          },
        },
      }),
      { blobId, byteLength: bytes.length },
    );
    expect(grant.present).toBe(true);
    expect(grant.url).toBeUndefined();
    expect(presignCalls).toBe(0);
  });

  test('no presigned-upload store ⇒ empty grant (client streams direct)', async () => {
    const storage = new SqliteServerStorage();
    const blobs = new MemoryBlobStore();
    const bytes = new Uint8Array([4]);
    const blobId = await blobIdFor(bytes);
    const grant = await handleBlobUploadGrant(baseCtx(storage, blobs), {
      blobId,
      byteLength: bytes.length,
    });
    expect(grant.url).toBeUndefined();
    expect(grant.present).toBeUndefined();
  });

  test('the size cap is enforced up front against the declared byteLength', async () => {
    const storage = new SqliteServerStorage();
    const blobs = new MemoryBlobStore();
    const blobId = await blobIdFor(new Uint8Array([1]));
    let presignCalls = 0;
    await expect(
      handleBlobUploadGrant(
        baseCtx(storage, blobs, {
          maxBlobBytes: 10,
          blobUploadUrls: {
            presign: () => {
              presignCalls += 1;
              return { url: 'x', urlExpiresAtMs: 0 };
            },
          },
        }),
        { blobId, byteLength: 11 },
      ),
    ).rejects.toThrow(/too_large|cap/);
    // The cap rejects BEFORE any url is minted.
    expect(presignCalls).toBe(0);
  });
});
