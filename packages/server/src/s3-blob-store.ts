/**
 * S3-compatible blob store (SPEC.md §5.9.2 durable objects, §5.9.5 delegated
 * presign) — AWS S3, Cloudflare R2's S3 endpoint, MinIO. The blob twin of
 * `s3-segment-store.ts`.
 *
 * The store logic (content-addressed key layout, idempotent re-put, orphan
 * sweep, CAS stats accumulator) is `BucketBlobStore`, shared with
 * `R2BlobStore` in `@syncular/server-workers`; this class adds the S3 REST
 * transport (`S3ObjectBucket`) and the SigV4 presign methods, which a bucket
 * binding cannot mint.
 */
import {
  BucketBlobStore,
  type BucketBlobStoreOptions,
} from './bucket-blob-store';
import { S3ObjectBucket } from './s3-object-bucket';
import type {
  BlobPresignConfig,
  BlobUploadPresignConfig,
  SegmentUrlIssue,
} from './signed-url';
import { presignUrl, type SigV4Credentials } from './sigv4';

export interface S3BlobStoreConfig {
  /**
   * Endpoint origin, no bucket, no trailing slash:
   * AWS `https://s3.<region>.amazonaws.com`,
   * R2 `https://<account-id>.r2.cloudflarestorage.com`,
   * MinIO `http://127.0.0.1:9000`. Requests are path-style
   * (`{endpoint}/{bucket}/{key}`), which all three accept.
   */
  readonly endpoint: string;
  /** AWS region; R2 uses `auto`. */
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Optional STS session token. */
  readonly sessionToken?: string;
  /** Key namespace inside the bucket, e.g. `syncular/`. Default: none. */
  readonly keyPrefix?: string;
}

const BLOB_ID_PATTERN = /^sha256:[0-9a-f]{64}$/;

export class S3BlobStore extends BucketBlobStore {
  readonly #bucket: S3ObjectBucket;
  readonly #region: string;
  readonly #credentials: SigV4Credentials;

  constructor(config: S3BlobStoreConfig) {
    const options: BucketBlobStoreOptions = { keyPrefix: config.keyPrefix };
    const bucket = new S3ObjectBucket(config);
    super(bucket, options);
    this.#bucket = bucket;
    this.#region = config.region;
    this.#credentials = {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      ...(config.sessionToken !== undefined
        ? { sessionToken: config.sessionToken }
        : {}),
    };
  }

  /**
   * SigV4 presigned GET for a blob object (§5.9.5 delegated presign). The
   * signed key embeds the `blobId`; `urlExpiresAtMs` is the provider-enforced
   * expiry (`X-Amz-Date + X-Amz-Expires`). Issued ONLY after the row-derived
   * authorization check (§5.9.5) — the caller (blob-handlers) resolves scopes
   * and tests referencing rows first; the URL is then a short-TTL bearer
   * grant to exactly those immutable bytes. TTL SHOULD be ≤ 15 minutes;
   * default 900 s.
   */
  async presignBlobGet(
    partition: string,
    blobId: string,
    options?: { readonly ttlSeconds?: number; readonly nowMs?: number },
  ): Promise<SegmentUrlIssue> {
    if (!BLOB_ID_PATTERN.test(blobId)) {
      throw new Error(`S3BlobStore: malformed blobId ${blobId}`);
    }
    const ttlSeconds = options?.ttlSeconds ?? 900;
    const nowMs = options?.nowMs ?? Date.now();
    const url = await presignUrl({
      url: this.#bucket.urlFor(this.objectKeyFor(partition, blobId)),
      region: this.#region,
      credentials: this.#credentials,
      nowMs,
      expiresSeconds: ttlSeconds,
    });
    return {
      url: url.toString(),
      urlExpiresAtMs: (Math.floor(nowMs / 1000) + ttlSeconds) * 1000,
    };
  }

  /**
   * SigV4 presigned PUT for a blob object (§5.9.3 direct-to-storage upload).
   * The signed key embeds the `blobId`, and the signature binds
   * `content-length` to the granted `byteLength` and `x-amz-checksum-sha256`
   * to the `blobId` digest (the same SHA-256, re-encoded from lowercase hex to
   * the base64 of its 32 raw bytes). The object store therefore rejects a PUT
   * of any other size (signature mismatch) or any other bytes (`BadDigest`),
   * so a grant can only place the content-addressed bytes at their key.
   * Issued by the upload-grant handler after host authentication and the
   * size-cap check; TTL SHOULD be ≤ 15 min (default 900).
   */
  async presignBlobPut(
    partition: string,
    blobId: string,
    byteLength: number,
    options?: { readonly ttlSeconds?: number; readonly nowMs?: number },
  ): Promise<SegmentUrlIssue> {
    if (!BLOB_ID_PATTERN.test(blobId)) {
      throw new Error(`S3BlobStore: malformed blobId ${blobId}`);
    }
    const ttlSeconds = options?.ttlSeconds ?? 900;
    const nowMs = options?.nowMs ?? Date.now();
    const digest = (blobId.slice('sha256:'.length).match(/../g) ?? []).map(
      (hex) => Number.parseInt(hex, 16),
    );
    const url = await presignUrl({
      method: 'PUT',
      url: this.#bucket.urlFor(this.objectKeyFor(partition, blobId)),
      region: this.#region,
      credentials: this.#credentials,
      nowMs,
      expiresSeconds: ttlSeconds,
      headers: {
        'content-length': String(byteLength),
        'x-amz-checksum-sha256': btoa(String.fromCharCode(...digest)),
      },
    });
    return {
      url: url.toString(),
      urlExpiresAtMs: (Math.floor(nowMs / 1000) + ttlSeconds) * 1000,
    };
  }
}

/**
 * Wire an `S3BlobStore` into `SyncServerConfig.blobSignedUrls` as the §5.9.5
 * delegated-presign scheme for blob downloads:
 * `blobSignedUrls: s3PresignedBlobUrls(blobStore, { ttlSeconds: 900 })`.
 * The presigned URL is issued only after the row-derived authorization check
 * (blob-handlers) — never as a bearer capability minted from the id alone.
 */
export function s3PresignedBlobUrls(
  store: S3BlobStore,
  options?: { readonly ttlSeconds?: number },
): BlobPresignConfig {
  return {
    ...(options?.ttlSeconds !== undefined
      ? { ttlSeconds: options.ttlSeconds }
      : {}),
    presign: ({ partition, blobId, ttlSeconds, nowMs }) =>
      store.presignBlobGet(partition, blobId, { ttlSeconds, nowMs }),
  };
}

/**
 * Wire an `S3BlobStore` into `SyncServerConfig.blobUploadUrls` as the §5.9.3
 * presigned-upload (direct-to-storage) scheme:
 * `blobUploadUrls: s3PresignedBlobUploads(blobStore, { ttlSeconds: 900 })`.
 * The upload-grant handler issues the presigned PUT only after host
 * authentication + the size-cap check; the client PUTs bytes straight to the
 * object store with no host auth, and the store verifies the signed
 * `content-length` and `x-amz-checksum-sha256` (§5.9.3).
 */
export function s3PresignedBlobUploads(
  store: S3BlobStore,
  options?: { readonly ttlSeconds?: number },
): BlobUploadPresignConfig {
  return {
    ...(options?.ttlSeconds !== undefined
      ? { ttlSeconds: options.ttlSeconds }
      : {}),
    presign: ({ partition, blobId, byteLength, ttlSeconds, nowMs }) =>
      store.presignBlobPut(partition, blobId, byteLength, {
        ttlSeconds,
        nowMs,
      }),
  };
}
