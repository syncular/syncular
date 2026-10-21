/**
 * The object-bucket seam: the handful of object-store operations the durable
 * segment store (§5.1) and blob store (§5.9.2) actually perform, expressed
 * without an HTTP transport.
 *
 * Two adapters implement it — `S3ObjectBucket` (`s3-object-bucket.ts`,
 * hand-rolled SigV4 over `fetch`) and the R2 binding adapter in
 * `@syncular/server-workers` (`r2-stores.ts`, the Worker's `env.BUCKET`) — so
 * one implementation of the store logic (`bucket-segment-store.ts`,
 * `bucket-blob-store.ts`) runs over both. The key layouts are the same on
 * either transport, so a bucket can be served through the S3 API for one host
 * and the binding for another.
 *
 * Everything here is structural: an adapter may be any object with these
 * methods, and Cloudflare's `R2Bucket` is assignable to the declaration in
 * `r2-stores.ts` without a dependency on `@cloudflare/workers-types`.
 */

/** One stored object, readable once. Mirrors `R2ObjectBody`. */
export interface BucketObject {
  /** The body, streamed; `null` only if the backend served none. */
  readonly body: ReadableStream<Uint8Array<ArrayBuffer>> | null;
  /** Backend ETag of the stored object (opaque, used as a CAS token). */
  readonly etag: string | undefined;
  /** Stored size in bytes, when the backend reports one. */
  readonly size: number | undefined;
  /** User metadata: the `x-amz-meta-*` headers S3-side, `customMetadata` on R2. */
  readonly metadata: Readonly<Record<string, string>>;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}

/** One stored object's description without its body. Mirrors `R2Object`. */
export interface BucketObjectHead {
  readonly etag: string | undefined;
  readonly size: number | undefined;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface BucketWriteOptions {
  readonly body: Uint8Array;
  readonly contentType: string;
  /** User metadata; values must be ASCII (both backends require it). */
  readonly metadata?: Readonly<Record<string, string>> | undefined;
  /**
   * Create-only write (`If-None-Match: *`, R2 `etagDoesNotMatch: '*'`). The
   * content-addressed bytes object is written this way so a second publisher
   * of identical bytes is a no-op and a hash collision cannot overwrite.
   */
  readonly createOnly?: boolean | undefined;
  /**
   * Compare-and-swap write (`If-Match`, R2 `etagMatches`): the write lands
   * only if the stored ETag still equals this. The read-modify-write of the
   * segment record and of the stats accumulator depend on it.
   */
  readonly ifMatch?: string | undefined;
}

/** One page of keys under a prefix. `cursor` is set when more remain. */
export interface BucketListPage {
  readonly keys: readonly string[];
  readonly cursor: string | undefined;
}

export interface ObjectBucket {
  /** The object plus its bytes, or `undefined` when the key is absent. */
  get(key: string): Promise<BucketObject | undefined>;
  head(key: string): Promise<BucketObjectHead | undefined>;
  /**
   * Write one object. Returns `false` when the `createOnly` / `ifMatch`
   * precondition failed, so the caller can re-read and retry; a backend that
   * ignores conditional writes would instead silently lose a concurrent
   * update, which is why the return value is not optional.
   */
  put(key: string, options: BucketWriteOptions): Promise<boolean>;
  /** Delete one object. Deleting an absent key succeeds (idempotent). */
  delete(key: string): Promise<void>;
  /**
   * List keys under a prefix, one page at a time. The blob orphan sweep
   * (§5.9.2) is the only caller: everything on the hot path is a GET/HEAD.
   */
  list(prefix: string, cursor?: string): Promise<BucketListPage>;
}
