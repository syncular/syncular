/**
 * `R2SegmentStore` / `R2BlobStore` over the R2 binding double: the shared
 * store contract suites (the same ones the S3, sqlite, and memory stores run),
 * the binding-specific seam behavior (`onlyIf` preconditions, `customMetadata`,
 * paged `list`), and the concurrency cases the segment record and stats CAS
 * exist for.
 *
 * The double implements exactly the `R2BucketLike` subset the stores use, with
 * R2's semantics where they matter: an object ETag is a content hash, a failed
 * `onlyIf` returns `null` from `put`, and `list` pages by cursor.
 */
import { describe, expect, test } from 'bun:test';
import {
  blobIdFor,
  S3BlobStore,
  S3SegmentStore,
  type SegmentMetadata,
  segmentIdFor,
  sha256Hex,
} from '@syncular/server';
import {
  R2BlobStore,
  type R2BucketLike,
  type R2ObjectBodyLike,
  type R2ObjectLike,
  type R2ObjectsLike,
  R2SegmentStore,
} from '../src/index';
import { runBlobStoreContract } from '../../server/test/blob-store-contract';
import {
  CONTRACT_NOW,
  runSegmentStoreContract,
} from '../../server/test/segment-store-contract';

interface StoredR2Object {
  readonly bytes: Uint8Array;
  readonly contentType: string | undefined;
  readonly customMetadata: Record<string, string>;
  readonly etag: string;
}

/** In-memory `R2Bucket` double with content-hash ETags and `onlyIf` support. */
class R2BucketDouble implements R2BucketLike {
  readonly objects = new Map<string, StoredR2Object>();
  /** Awaited before a `put` is applied (deterministic interleaving). */
  beforePut: ((key: string) => Promise<void> | void) | undefined;
  /** Keys per `list` page; 2 keeps the cursor path exercised. */
  pageSize = 2;

  #describe(key: string, stored: StoredR2Object): R2ObjectLike {
    return {
      key,
      etag: stored.etag,
      size: stored.bytes.length,
      customMetadata: stored.customMetadata,
    };
  }

  async get(key: string): Promise<R2ObjectBodyLike | null> {
    const stored = this.objects.get(key);
    if (stored === undefined) return null;
    const bytes = Uint8Array.from(stored.bytes);
    return {
      ...this.#describe(key, stored),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
      arrayBuffer: async () => Uint8Array.from(stored.bytes).buffer,
      text: async () => new TextDecoder().decode(stored.bytes),
    };
  }

  async head(key: string): Promise<R2ObjectLike | null> {
    const stored = this.objects.get(key);
    return stored === undefined ? null : this.#describe(key, stored);
  }

  async put(
    key: string,
    value: Uint8Array,
    options?: {
      readonly onlyIf?: {
        readonly etagMatches?: string;
        readonly etagDoesNotMatch?: string;
      };
      readonly httpMetadata?: { readonly contentType?: string };
      readonly customMetadata?: Record<string, string>;
    },
  ): Promise<R2ObjectLike | null> {
    await this.beforePut?.(key);
    // The object ETag is a content hash, exactly as R2 derives it, so it is
    // computed BEFORE the precondition check: the check and the write have to
    // be one synchronous step, or two writers can both pass
    // `etagDoesNotMatch: '*'` and the later `set` silently wins.
    const etag = await sha256Hex(value);
    const existing = this.objects.get(key);
    if (
      options?.onlyIf?.etagMatches !== undefined &&
      existing?.etag !== options.onlyIf.etagMatches
    ) {
      return null;
    }
    if (options?.onlyIf?.etagDoesNotMatch === '*' && existing !== undefined) {
      return null;
    }
    const stored: StoredR2Object = {
      bytes: Uint8Array.from(value),
      contentType: options?.httpMetadata?.contentType,
      customMetadata: { ...(options?.customMetadata ?? {}) },
      etag,
    };
    this.objects.set(key, stored);
    return this.#describe(key, stored);
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async list(options: {
    readonly prefix: string;
    readonly cursor?: string;
    readonly limit?: number;
  }): Promise<R2ObjectsLike> {
    const cursor = options.cursor;
    const keys = [...this.objects.keys()]
      .filter((key) => key.startsWith(options.prefix))
      .filter((key) => cursor === undefined || key > cursor)
      .sort();
    const limit = options.limit ?? this.pageSize;
    const page = keys.slice(0, limit);
    const truncated = keys.length > limit;
    const last = page[page.length - 1];
    return {
      objects: page.map((key) => {
        const stored = this.objects.get(key);
        if (stored === undefined) throw new Error(`missing ${key}`);
        return this.#describe(key, stored);
      }),
      truncated,
      ...(truncated && last !== undefined ? { cursor: last } : {}),
    };
  }
}

const META: SegmentMetadata = {
  partition: 'p',
  logEpoch: 'epoch-1',
  table: 'tasks',
  schemaVersion: 1,
  mediaType: 'rows',
  scopeDigest: 'digest-a',
  asOfCommitSeq: 7,
  rowCount: 2,
  rowCursor: null,
  nextRowCursor: null,
};

const S3_CONFIG = {
  endpoint: 'https://example.r2.cloudflarestorage.com',
  region: 'auto',
  bucket: 'syncular',
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'secret',
};

runSegmentStoreContract('r2', () => new R2SegmentStore(new R2BucketDouble()));
runBlobStoreContract('r2', () => new R2BlobStore(new R2BucketDouble()));

describe('R2 binding seam', () => {
  test('the key layout matches the S3 stores, so one bucket serves both paths', async () => {
    const bucket = new R2BucketDouble();
    const segmentId = await segmentIdFor(new Uint8Array([1]));
    const blobId = await blobIdFor(new Uint8Array([2]));
    expect(new R2SegmentStore(bucket).objectKeyFor(segmentId)).toBe(
      new S3SegmentStore(S3_CONFIG).objectKeyFor(segmentId),
    );
    expect(new R2BlobStore(bucket).objectKeyFor('p', blobId)).toBe(
      new S3BlobStore(S3_CONFIG).objectKeyFor('p', blobId),
    );
    expect(
      new R2SegmentStore(bucket, { keyPrefix: 'syn/2nd/' }).objectKeyFor(
        segmentId,
      ),
    ).toBe(`syn/2nd/seg/${segmentId.replace(':', '/')}`);
  });

  test('a binding cannot presign, so the stores expose no presign methods', () => {
    const bucket = new R2BucketDouble();
    expect('presignSegmentGet' in new R2SegmentStore(bucket)).toBe(false);
    const blobs = new R2BlobStore(bucket);
    expect('presignBlobGet' in blobs).toBe(false);
    expect('presignBlobPut' in blobs).toBe(false);
  });

  test('put writes the verbatim bytes object and the mutable record object', async () => {
    const bucket = new R2BucketDouble();
    const store = new R2SegmentStore(bucket);
    const bytes = new Uint8Array([1, 2, 3]);
    const record = await store.put(META, bytes, CONTRACT_NOW);
    const hex = record.segmentId.slice('sha256:'.length);
    const stored = bucket.objects.get(`seg/sha256/${hex}`);
    // The body must be exactly the content-addressed bytes: the inline
    // download route and any presigned GET serve it to the client's §5.1 check.
    expect(stored?.bytes).toEqual(bytes);
    expect(stored?.contentType).toBe('application/octet-stream');
    expect(bucket.objects.has(`rec/sha256/${hex}.json`)).toBe(true);
    expect(
      [...bucket.objects.keys()].filter((key) => key.startsWith('find/')),
    ).toHaveLength(1);
    expect(bucket.objects.has('stats/segments.json')).toBe(true);
  });

  test('open streams the binding body without buffering it into the record', async () => {
    const store = new R2SegmentStore(new R2BucketDouble());
    const bytes = new Uint8Array(64 * 1024).map((_, index) => index % 253);
    const record = await store.put(META, bytes, CONTRACT_NOW);
    const opened = await store.open(record.segmentId);
    if (opened === undefined) throw new Error('expected the stored segment');
    expect(opened.byteLength).toBe(bytes.length);
    expect(
      new Uint8Array(await new Response(opened.body).arrayBuffer()),
    ).toEqual(bytes);
  });

  test('a legacy record in object metadata is still readable over the binding', async () => {
    // The record used to ride in the bytes object's user metadata. The seam
    // surfaces R2's `customMetadata` in the same shape S3's `x-amz-meta-*`
    // headers take, so the upgrade read works on either transport.
    const bucket = new R2BucketDouble();
    const store = new R2SegmentStore(bucket);
    const bytes = new Uint8Array([7, 8, 9]);
    const segmentId = await segmentIdFor(bytes);
    const legacyRecord = JSON.stringify({
      segmentId,
      partition: 'p',
      logEpoch: 'epoch-1',
      table: 'tasks',
      schemaVersion: 1,
      mediaType: 'rows',
      scopeDigest: 'digest-a',
      asOfCommitSeq: 7,
      rowCount: 2,
      rowCursor: null,
      nextRowCursor: null,
      byteLength: bytes.length,
      createdAtMs: CONTRACT_NOW,
      expiresAtMs: CONTRACT_NOW + 24 * 60 * 60 * 1000,
    });
    await bucket.put(store.objectKeyFor(segmentId), bytes, {
      httpMetadata: { contentType: 'application/octet-stream' },
      customMetadata: {
        'syncular-record': btoa(legacyRecord)
          .replaceAll('+', '-')
          .replaceAll('/', '_')
          .replace(/=+$/, ''),
      },
    });
    const got = await store.get(segmentId);
    expect(got?.record.segmentId).toBe(segmentId);
    expect(got?.record.scopeDigests).toEqual(['digest-a']);
    expect(got?.bytes).toEqual(bytes);
  });

  test('stats read the accumulator, count each content address once, and stay approximate', async () => {
    const store = new R2SegmentStore(new R2BucketDouble());
    expect(await store.stats()).toEqual({
      count: 0,
      bytes: 0,
      rowsSegments: 0,
      sqliteSegments: 0,
      approximate: true,
    });
    const rows = new Uint8Array([1, 2, 3]);
    await store.put(META, rows, CONTRACT_NOW);
    await store.put(
      { ...META, mediaType: 'sqlite', scopeDigest: 'digest-b' },
      new Uint8Array([4, 5, 6, 7]),
      CONTRACT_NOW,
    );
    // An idempotent re-put of one content address is not counted twice.
    await store.put(META, rows, CONTRACT_NOW + 1);
    expect(await store.stats()).toEqual({
      count: 2,
      bytes: 7,
      rowsSegments: 1,
      sqliteSegments: 1,
      approximate: true,
    });
  });

  test('find reports a pointer as stale once the bytes object is gone', async () => {
    const bucket = new R2BucketDouble();
    const store = new R2SegmentStore(bucket);
    const record = await store.put(META, new Uint8Array([5, 6]), CONTRACT_NOW);
    bucket.objects.delete(store.objectKeyFor(record.segmentId));
    const found = await store.find(
      {
        partition: META.partition,
        logEpoch: META.logEpoch,
        table: META.table,
        schemaVersion: META.schemaVersion,
        mediaType: META.mediaType,
        scopeDigest: META.scopeDigest,
        asOfCommitSeq: META.asOfCommitSeq,
      },
      CONTRACT_NOW + 1,
    );
    expect(found).toBeUndefined();
  });
});

describe('segment record CAS over the binding (§5.1)', () => {
  test('two scopes publishing identical bytes concurrently keep both digests', async () => {
    const bucket = new R2BucketDouble();
    const store = new R2SegmentStore(bucket);
    // The empty rows segment: no rows in scope, so two authorized scopes
    // encode to identical bytes and share one content address. Both builds run
    // concurrently, so both `put`s read the same pre-state; the first record
    // write is held until the second has read it.
    const bytes = new Uint8Array();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let recordPuts = 0;
    bucket.beforePut = async (key) => {
      if (!key.startsWith('rec/')) return;
      recordPuts += 1;
      if (recordPuts === 1) await gate;
      else release?.();
    };
    try {
      const [first, second] = await Promise.all([
        store.put(
          { ...META, partition: 'p1', scopeDigest: 'digest-a' },
          bytes,
          CONTRACT_NOW,
        ),
        store.put(
          { ...META, partition: 'p2', scopeDigest: 'digest-b' },
          bytes,
          CONTRACT_NOW,
        ),
      ]);
      expect(first.segmentId).toBe(second.segmentId);
      const stored = await store.get(first.segmentId);
      // A lost digest is what makes the losing scope's download
      // `sync.forbidden: scope digest mismatch` (§5.5), so both surviving IS
      // the contract.
      expect(stored?.record.scopeDigests.slice().sort()).toEqual([
        'digest-a',
        'digest-b',
      ]);
      expect(stored?.record.publications).toHaveLength(2);
      expect(recordPuts).toBeGreaterThan(1);
    } finally {
      bucket.beforePut = undefined;
    }
  });

  test('the stats accumulator retries a stale ETag instead of losing an increment', async () => {
    const bucket = new R2BucketDouble();
    const store = new R2SegmentStore(bucket);
    await store.put(META, new Uint8Array([1]), CONTRACT_NOW);
    expect((await store.stats()).count).toBe(1);

    // Both writers read count 1 with one ETag; the first stats write is held
    // until the second has landed, so the held write carries a stale ETag and
    // must be rejected, re-read, and re-applied.
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let statsPuts = 0;
    bucket.beforePut = async (key) => {
      if (key !== 'stats/segments.json') return;
      statsPuts += 1;
      if (statsPuts === 1) await gate;
      else release?.();
    };
    try {
      await Promise.all([
        store.put(
          { ...META, scopeDigest: 'digest-a' },
          new Uint8Array([2]),
          CONTRACT_NOW,
        ),
        // A different byte length makes the two accumulators different
        // bodies (hence different ETags), so the held write is distinguishable
        // from the one that landed.
        store.put(
          { ...META, scopeDigest: 'digest-b' },
          new Uint8Array([3, 3]),
          CONTRACT_NOW,
        ),
      ]);
    } finally {
      bucket.beforePut = undefined;
    }
    // Two increments on top of the seed; the retry is what makes it exact.
    expect(statsPuts).toBeGreaterThan(2);
    const stats = await store.stats();
    expect(stats.count).toBe(3);
    expect(stats.bytes).toBe(4);
    expect(stats.approximate).toBe(true);
  });
});

describe('blob sweep over a paged binding list (§5.9.2)', () => {
  test('pages the whole prefix, spares references, and decrements the counters', async () => {
    const bucket = new R2BucketDouble();
    bucket.pageSize = 2;
    const store = new R2BlobStore(bucket);
    const blobIds: string[] = [];
    for (let index = 0; index < 5; index++) {
      const bytes = new Uint8Array([index]);
      const blobId = await blobIdFor(bytes);
      blobIds.push(blobId);
      await store.put('p', blobId, bytes, CONTRACT_NOW - 10_000);
    }
    const referenced = blobIds[0]!;
    const swept = await store.sweepOrphans(
      'p',
      CONTRACT_NOW,
      new Set([referenced]),
    );
    expect(swept.slice().sort()).toEqual(
      blobIds.filter((blobId) => blobId !== referenced).sort(),
    );
    expect(await store.has('p', referenced)).toBe(true);
    expect((await store.stats('p')).count).toBe(1);
    expect((await store.stats('p')).bytes).toBe(1);
  });

  test('an idempotent re-put is counted once and keeps the first upload age', async () => {
    const bucket = new R2BucketDouble();
    const store = new R2BlobStore(bucket);
    const bytes = new Uint8Array([9, 9, 9]);
    const blobId = await blobIdFor(bytes);
    await store.put('p', blobId, bytes, CONTRACT_NOW);
    await store.put('p', blobId, bytes, CONTRACT_NOW + 5_000);
    expect((await store.stats('p')).count).toBe(1);
    expect((await store.stats('p')).bytes).toBe(3);
    expect((await store.get('p', blobId))?.record.createdAtMs).toBe(
      CONTRACT_NOW,
    );
  });
});
