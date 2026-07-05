/**
 * `handleBlobDownload` (SPEC.md §5.9.5): the row-derived authorization gate,
 * and the additive delegated-presign issuance — a signed URL is minted ONLY
 * after the authorization check passes, never as a bearer capability from the
 * blobId alone.
 */
import { describe, expect, test } from 'bun:test';
import {
  type BlobStore,
  blobIdFor,
  handleBlobDownload,
  MemoryBlobStore,
  S3BlobStore,
  type ServerSchema,
  SqliteServerStorage,
  type SyncRequestContext,
  s3PresignedBlobUrls,
} from '@syncular-v2/server';
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
  const tx = await storage.begin(PARTITION);
  if (tx.setBlobRefs === undefined) throw new Error('no setBlobRefs');
  // The reference index carries the row's stored scopes for the §3.4 check.
  await tx.upsertRow('tasks', {
    rowId: 'row-1',
    serverVersion: 1,
    scopes: { project_id: scopeValue },
    payload: new Uint8Array(),
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
    expect(result.bytes).toEqual(bytes);
    expect(result.headers['Content-Type']).toBe('image/png');
    // No presign configured ⇒ no url on the result.
    expect(result.url).toBeUndefined();
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
    if (result.url === undefined) throw new Error('expected a presigned url');
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
