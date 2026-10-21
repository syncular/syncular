/**
 * R2-binding segment and blob stores (SPEC.md §5.1, §5.9.2) for Cloudflare
 * Workers.
 *
 * `R2SegmentStore` and `R2BlobStore` run the same bucket-generic store logic
 * as `S3SegmentStore` and `S3BlobStore` (`BucketSegmentStore` /
 * `BucketBlobStore` in `@syncular/server`) over the Worker's `env.BUCKET`
 * binding instead of the S3 REST API. No S3 credentials, no SigV4 signing, and
 * no outbound request: every read and write is a binding call, which works the
 * same under `wrangler dev --local`.
 *
 * The object key layout is identical to the S3 stores, so one bucket serves
 * both access paths: a Bun or Node host can publish segments and blobs through
 * the S3 API while the Worker reads them through the binding.
 *
 * There are no `presign*` methods here. A binding cannot mint a provider URL,
 * so segments and blobs are served inline through `GET /segments/:id` and
 * `GET /blobs/:id` (the `open` path streams them without buffering the object
 * in the isolate). Configure no `signedUrls` / `blobSignedUrls` for a binding
 * deployment; the core falls back to inline delivery.
 *
 * The binding surface is declared structurally below, so this package keeps
 * taking no `@cloudflare/workers-types` dependency. Cloudflare's `R2Bucket`
 * is assignable to `R2BucketLike`.
 */
import {
  BucketBlobStore,
  type BucketBlobStoreOptions,
  BucketSegmentStore,
  type BucketSegmentStoreOptions,
  type ObjectBucket,
} from '@syncular/server';

// -- R2 bindings (structural; no @cloudflare/workers-types dep) -------------

/** `R2Conditional`: the precondition R2 evaluates before it writes. */
export interface R2ConditionLike {
  /** Write only if the stored ETag equals this one. */
  readonly etagMatches?: string;
  /** Write only if the stored ETag differs; `*` means "only when absent". */
  readonly etagDoesNotMatch?: string;
}

/** `R2Object`: one stored object's description. */
export interface R2ObjectLike {
  readonly key: string;
  /** Unquoted object ETag (the CAS token; R2 also reports `httpEtag`). */
  readonly etag: string;
  readonly size: number;
  readonly customMetadata?: Readonly<Record<string, string>>;
}

/** `R2ObjectBody`: the object plus its bytes. */
export interface R2ObjectBodyLike extends R2ObjectLike {
  readonly body: ReadableStream<Uint8Array<ArrayBuffer>>;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}

/** `R2Objects`: one page of a `list`. */
export interface R2ObjectsLike {
  readonly objects: readonly R2ObjectLike[];
  readonly truncated: boolean;
  readonly cursor?: string;
}

/** `R2PutOptions`: the subset the stores set. */
export interface R2PutOptionsLike {
  readonly onlyIf?: R2ConditionLike;
  readonly httpMetadata?: { readonly contentType?: string };
  readonly customMetadata?: Record<string, string>;
}

/** `R2GetOptions`: declared for structural parity; the stores read plainly. */
export interface R2GetOptionsLike {
  readonly onlyIf?: R2ConditionLike;
}

/**
 * The `R2Bucket` binding surface the stores use
 * (`wrangler [[r2_buckets]] binding = "BUCKET"` → `env.BUCKET`).
 */
export interface R2BucketLike {
  get(
    key: string,
    options?: R2GetOptionsLike,
  ): Promise<R2ObjectBodyLike | null>;
  head(key: string): Promise<R2ObjectLike | null>;
  /** `null` when `onlyIf` failed, exactly as the platform reports it. */
  put(
    key: string,
    value: Uint8Array,
    options?: R2PutOptionsLike,
  ): Promise<R2ObjectLike | null>;
  delete(key: string): Promise<void>;
  list(options: {
    readonly prefix: string;
    readonly cursor?: string;
    readonly limit?: number;
  }): Promise<R2ObjectsLike>;
}

function metadataOf(object: R2ObjectLike): Readonly<Record<string, string>> {
  return object.customMetadata ?? {};
}

/**
 * The `ObjectBucket` seam over one R2 binding. `etagMatches` /
 * `etagDoesNotMatch: '*'` are the binding's spelling of the `If-Match` /
 * `If-None-Match: *` preconditions the record and stats CAS depend on; a
 * failed precondition is a `null` put result.
 */
function r2ObjectBucket(bucket: R2BucketLike): ObjectBucket {
  return {
    async get(key) {
      const object = await bucket.get(key);
      if (object === null) return undefined;
      return {
        body: object.body,
        etag: object.etag,
        size: object.size,
        metadata: metadataOf(object),
        arrayBuffer: () => object.arrayBuffer(),
        text: () => object.text(),
      };
    },
    async head(key) {
      const object = await bucket.head(key);
      if (object === null) return undefined;
      return {
        etag: object.etag,
        size: object.size,
        metadata: metadataOf(object),
      };
    },
    async put(key, options) {
      const onlyIf: R2ConditionLike | undefined =
        options.createOnly === true
          ? { etagDoesNotMatch: '*' }
          : options.ifMatch !== undefined
            ? { etagMatches: options.ifMatch }
            : undefined;
      const written = await bucket.put(key, options.body, {
        ...(onlyIf !== undefined ? { onlyIf } : {}),
        httpMetadata: { contentType: options.contentType },
        ...(options.metadata !== undefined
          ? { customMetadata: { ...options.metadata } }
          : {}),
      });
      return written !== null;
    },
    async delete(key) {
      await bucket.delete(key);
    },
    async list(prefix, cursor) {
      const page = await bucket.list({
        prefix,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      return {
        keys: page.objects.map((object) => object.key),
        cursor: page.truncated ? page.cursor : undefined,
      };
    },
  };
}

/**
 * Segment store over an R2 binding. Same key layout, record CAS, reuse
 * pointers, and approximate stats accumulator as `S3SegmentStore`.
 *
 * ```ts
 * const segments = new R2SegmentStore(env.BUCKET);
 * ```
 */
export class R2SegmentStore extends BucketSegmentStore {
  constructor(bucket: R2BucketLike, options?: BucketSegmentStoreOptions) {
    super(r2ObjectBucket(bucket), options);
  }
}

/**
 * Blob store over an R2 binding. Same key layout, idempotent re-put, orphan
 * sweep, and approximate stats accumulator as `S3BlobStore`. The sweep pages
 * the binding's `list`, so no S3 credentials are needed for GC either.
 *
 * ```ts
 * const blobs = new R2BlobStore(env.BUCKET);
 * ```
 */
export class R2BlobStore extends BucketBlobStore {
  constructor(bucket: R2BucketLike, options?: BucketBlobStoreOptions) {
    super(r2ObjectBucket(bucket), options);
  }
}
