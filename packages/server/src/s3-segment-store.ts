/**
 * S3-compatible segment store (SPEC.md §5.1 cache semantics, §5.4
 * delegated presign) — AWS S3, Cloudflare R2's S3 endpoint, MinIO. Zero
 * dependencies: hand-rolled SigV4 over `fetch` (sigv4.ts).
 *
 * The store logic (key layout, record CAS, reuse pointers, stats
 * accumulator) is `BucketSegmentStore`, shared with `R2SegmentStore` in
 * `@syncular/server-workers`; this class adds the S3 REST transport
 * (`S3ObjectBucket`) and the SigV4 presign methods, which a bucket binding
 * cannot mint.
 */
import {
  BucketSegmentStore,
  type BucketSegmentStoreOptions,
} from './bucket-segment-store';
import { S3ObjectBucket } from './s3-object-bucket';
import type { DelegatedPresignConfig, SegmentUrlIssue } from './signed-url';
import { presignUrl, type SigV4Credentials } from './sigv4';

export interface S3SegmentStoreConfig {
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
  /** Segment TTL (§5.1 cache semantics). Default 24 h. */
  readonly ttlMs?: number;
}

const SEGMENT_ID_PATTERN = /^sha256:[0-9a-f]{64}$/;

export class S3SegmentStore extends BucketSegmentStore {
  readonly #bucket: S3ObjectBucket;
  readonly #region: string;
  readonly #credentials: SigV4Credentials;

  constructor(config: S3SegmentStoreConfig) {
    const options: BucketSegmentStoreOptions = {
      keyPrefix: config.keyPrefix,
      ttlMs: config.ttlMs,
    };
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
   * SigV4 presigned GET for a segment object (§5.4 delegated presign).
   * The signed key embeds the `segmentId` (equivalence rule) and
   * `urlExpiresAtMs` is the provider-enforced expiry
   * (`X-Amz-Date + X-Amz-Expires`). TTL SHOULD be ≤ 15 minutes (§5.4);
   * default 900 s.
   */
  async presignSegmentGet(
    segmentId: string,
    options?: { readonly ttlSeconds?: number; readonly nowMs?: number },
  ): Promise<SegmentUrlIssue> {
    if (!SEGMENT_ID_PATTERN.test(segmentId)) {
      throw new Error(`S3SegmentStore: malformed segmentId ${segmentId}`);
    }
    const ttlSeconds = options?.ttlSeconds ?? 900;
    const nowMs = options?.nowMs ?? Date.now();
    const url = await presignUrl({
      url: this.#bucket.urlFor(this.objectKeyFor(segmentId)),
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
}

/**
 * Wire an `S3SegmentStore` into `SyncServerConfig.signedUrls` as the §5.4
 * delegated-presign scheme:
 * `signedUrls: s3PresignedUrls(store, { ttlSeconds: 900 })`.
 */
export function s3PresignedUrls(
  store: S3SegmentStore,
  options?: { readonly ttlSeconds?: number },
): DelegatedPresignConfig {
  return {
    ...(options?.ttlSeconds !== undefined
      ? { ttlSeconds: options.ttlSeconds }
      : {}),
    presign: ({ segmentId, ttlSeconds, nowMs }) =>
      store.presignSegmentGet(segmentId, { ttlSeconds, nowMs }),
  };
}
