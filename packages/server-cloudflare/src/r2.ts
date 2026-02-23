/**
 * R2 blob storage adapter using native R2Bucket binding.
 *
 * This adapter stores blobs in Cloudflare R2 using the native binding,
 * without requiring the AWS SDK. Since R2 bindings don't support presigned URLs,
 * this adapter generates signed tokens that allow uploads/downloads through
 * the Worker's blob routes (similar to the database adapter).
 */

// ============================================================================
// Blob Storage Types (locally defined to avoid DOM/Workers lib conflicts)
// These match @syncular/core BlobStorageAdapter interface.
// ============================================================================

/**
 * Options for signing an upload URL.
 */
export interface BlobSignUploadOptions {
  /** SHA-256 hash (for naming and checksum validation) */
  hash: string;
  /** Content size in bytes */
  size: number;
  /** MIME type */
  mimeType: string;
  /** URL expiration in seconds */
  expiresIn: number;
}

/**
 * Result of signing an upload URL.
 */
export interface BlobSignedUpload {
  /** The URL to upload to */
  url: string;
  /** HTTP method */
  method: 'PUT' | 'POST';
  /** Required headers */
  headers?: Record<string, string>;
}

/**
 * Options for signing a download URL.
 */
export interface BlobSignDownloadOptions {
  /** SHA-256 hash */
  hash: string;
  /** URL expiration in seconds */
  expiresIn: number;
}

/**
 * Adapter for blob storage backends.
 * Implements the same interface as @syncular/core BlobStorageAdapter.
 */
export interface BlobStorageAdapter {
  /** Adapter name for logging/debugging */
  readonly name: string;

  /**
   * Generate a presigned URL for uploading a blob.
   */
  signUpload(options: BlobSignUploadOptions): Promise<BlobSignedUpload>;

  /**
   * Generate a presigned URL for downloading a blob.
   */
  signDownload(options: BlobSignDownloadOptions): Promise<string>;

  /**
   * Check if a blob exists in storage.
   */
  exists(hash: string): Promise<boolean>;

  /**
   * Delete a blob (for garbage collection).
   */
  delete(hash: string): Promise<void>;

  /**
   * Get blob metadata from storage (optional).
   */
  getMetadata?(
    hash: string
  ): Promise<{ size: number; mimeType?: string } | null>;

  /**
   * Store blob data directly (for adapters that support direct storage).
   */
  put?(
    hash: string,
    data: Uint8Array,
    metadata?: Record<string, unknown>
  ): Promise<void>;

  /**
   * Store blob data directly from a stream.
   */
  putStream?(
    hash: string,
    stream: ReadableStream<Uint8Array>,
    metadata?: Record<string, unknown>
  ): Promise<void>;

  /**
   * Get blob data directly (for adapters that support direct retrieval).
   */
  get?(hash: string): Promise<Uint8Array | null>;

  /**
   * Get blob data directly as a stream.
   */
  getStream?(hash: string): Promise<ReadableStream<Uint8Array> | null>;
}

/**
 * Token signer interface for creating/verifying upload/download tokens.
 */
export interface BlobTokenSigner {
  /**
   * Sign a token for blob upload/download authorization.
   * @param payload The data to sign
   * @param expiresIn Expiration time in seconds
   * @returns A signed token string
   */
  sign(
    payload: { hash: string; action: 'upload' | 'download'; expiresAt: number },
    expiresIn: number
  ): Promise<string>;

  /**
   * Verify and decode a signed token.
   * @returns The payload if valid, null if invalid/expired
   */
  verify(token: string): Promise<{
    hash: string;
    action: 'upload' | 'download';
    expiresAt: number;
  } | null>;
}

/**
 * Create a simple HMAC-based token signer.
 */
export function createHmacTokenSigner(secret: string): BlobTokenSigner {
  const encoder = new TextEncoder();

  async function hmacSign(data: string): Promise<string> {
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const signature = await crypto.subtle.sign(
      'HMAC',
      key,
      encoder.encode(data)
    );
    return bufferToHex(new Uint8Array(signature));
  }

  return {
    async sign(payload, _expiresIn) {
      const data = JSON.stringify(payload);
      const dataB64 = btoa(data);
      const sig = await hmacSign(dataB64);
      return `${dataB64}.${sig}`;
    },

    async verify(token) {
      const [dataB64, sig] = token.split('.');
      if (!dataB64 || !sig) return null;

      const expectedSig = await hmacSign(dataB64);
      if (sig !== expectedSig) return null;

      try {
        const data = JSON.parse(atob(dataB64)) as {
          hash: string;
          action: 'upload' | 'download';
          expiresAt: number;
        };

        if (Date.now() > data.expiresAt) return null;

        return data;
      } catch {
        return null;
      }
    },
  };
}

function bufferToHex(buffer: Uint8Array): string {
  return Array.from(buffer)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export interface R2BlobStorageAdapterOptions {
  /** R2 bucket binding */
  bucket: R2Bucket;
  /** Optional key prefix for all blobs */
  keyPrefix?: string;
  /** Base URL for the blob routes (e.g., "https://api.example.com/api/sync") */
  baseUrl: string;
  /** Token signer for authorization */
  tokenSigner: BlobTokenSigner;
}

/**
 * Create an R2 blob storage adapter using native R2Bucket binding.
 *
 * Since R2 bindings don't support presigned URLs, this adapter generates
 * signed tokens and uses Worker-proxied uploads/downloads.
 *
 * @example
 * ```typescript
 * import { createR2BlobStorageAdapter, createHmacTokenSigner } from '@syncular/server-cloudflare/r2';
 *
 * type Env = { BLOBS: R2Bucket };
 *
 * const adapter = createR2BlobStorageAdapter({
 *   bucket: env.BLOBS,
 *   baseUrl: 'https://api.example.com/sync',
 *   tokenSigner: createHmacTokenSigner(env.BLOB_SECRET),
 * });
 * ```
 */
export function createR2BlobStorageAdapter(
  options: R2BlobStorageAdapterOptions
): BlobStorageAdapter {
  const { bucket, keyPrefix = '', baseUrl, tokenSigner } = options;

  // Normalize base URL (remove trailing slash)
  const normalizedBaseUrl = baseUrl.replace(/\/$/, '');

  function getKey(hash: string): string {
    // Remove "sha256:" prefix and use hex as key
    const hex = hash.startsWith('sha256:') ? hash.slice(7) : hash;
    return `${keyPrefix}${hex}`;
  }

  function resolveMimeType(metadata?: Record<string, unknown>): string {
    return typeof metadata?.mimeType === 'string'
      ? metadata.mimeType
      : 'application/octet-stream';
  }

  function resolveChecksum(
    hash: string,
    metadata?: Record<string, unknown>
  ): string | undefined {
    if (metadata?.disableChecksum === true) {
      return undefined;
    }

    const explicitChecksum = metadata?.checksumSha256;
    if (
      typeof explicitChecksum === 'string' &&
      /^[0-9a-f]{64}$/i.test(explicitChecksum)
    ) {
      return explicitChecksum.toLowerCase();
    }

    return hash.startsWith('sha256:') ? hash.slice(7) : undefined;
  }

  function resolveContentLength(
    metadata?: Record<string, unknown>
  ): number | undefined {
    const candidates = [
      metadata?.contentLength,
      metadata?.byteLength,
      metadata?.size,
    ];
    for (const candidate of candidates) {
      if (typeof candidate !== 'number') continue;
      if (!Number.isFinite(candidate) || candidate < 0) continue;
      return candidate;
    }
    return undefined;
  }

  async function streamToBytes(
    stream: ReadableStream<Uint8Array>
  ): Promise<Uint8Array> {
    const reader = stream.getReader();
    try {
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        chunks.push(value);
        total += value.length;
      }

      const output = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.length;
      }
      return output;
    } finally {
      reader.releaseLock();
    }
  }

  async function putStreamInternal(
    hash: string,
    stream: ReadableStream<Uint8Array>,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    const key = getKey(hash);
    const mimeType = resolveMimeType(metadata);
    const checksum = resolveChecksum(hash, metadata);
    const contentLength = resolveContentLength(metadata);

    if (typeof contentLength === 'number' && contentLength >= 0) {
      if (typeof FixedLengthStream !== 'undefined') {
        const fixedLength = new FixedLengthStream(contentLength);
        await Promise.all([
          stream.pipeTo(fixedLength.writable),
          bucket.put(key, fixedLength.readable, {
            httpMetadata: { contentType: mimeType },
            sha256: checksum,
          }),
        ]);
        return;
      }

      const bufferedBody = await streamToBytes(stream);
      if (bufferedBody.byteLength !== contentLength) {
        throw new Error(
          `Blob content length mismatch: expected ${contentLength}, got ${bufferedBody.byteLength}`
        );
      }
      await bucket.put(key, bufferedBody, {
        httpMetadata: { contentType: mimeType },
        sha256: checksum,
      });
      return;
    }

    const bufferedBody = await streamToBytes(stream);
    await bucket.put(key, bufferedBody, {
      httpMetadata: {
        contentType: mimeType,
      },
      sha256: checksum,
    });
  }

  async function getStreamInternal(
    hash: string
  ): Promise<ReadableStream<Uint8Array> | null> {
    const key = getKey(hash);
    const object = await bucket.get(key);
    if (!object) return null;
    return object.body as ReadableStream<Uint8Array> | null;
  }

  return {
    name: 'r2',

    async signUpload(opts: BlobSignUploadOptions): Promise<BlobSignedUpload> {
      const expiresAt = Date.now() + opts.expiresIn * 1000;
      const token = await tokenSigner.sign(
        { hash: opts.hash, action: 'upload', expiresAt },
        opts.expiresIn
      );

      // URL points to server's blob upload endpoint
      const url = `${normalizedBaseUrl}/blobs/${encodeURIComponent(opts.hash)}/upload?token=${encodeURIComponent(token)}`;

      return {
        url,
        method: 'PUT',
        headers: {
          'Content-Type': opts.mimeType,
          'Content-Length': String(opts.size),
        },
      };
    },

    async signDownload(opts: BlobSignDownloadOptions): Promise<string> {
      const expiresAt = Date.now() + opts.expiresIn * 1000;
      const token = await tokenSigner.sign(
        { hash: opts.hash, action: 'download', expiresAt },
        opts.expiresIn
      );

      return `${normalizedBaseUrl}/blobs/${encodeURIComponent(opts.hash)}/download?token=${encodeURIComponent(token)}`;
    },

    async exists(hash: string): Promise<boolean> {
      const key = getKey(hash);
      const head = await bucket.head(key);
      return head !== null;
    },

    async delete(hash: string): Promise<void> {
      const key = getKey(hash);
      await bucket.delete(key);
    },

    async getMetadata(
      hash: string
    ): Promise<{ size: number; mimeType?: string } | null> {
      const key = getKey(hash);
      const head = await bucket.head(key);
      if (!head) return null;

      return {
        size: head.size,
        mimeType: head.httpMetadata?.contentType,
      };
    },

    async put(
      hash: string,
      data: Uint8Array,
      metadata?: Record<string, unknown>
    ): Promise<void> {
      const key = getKey(hash);
      const mimeType = resolveMimeType(metadata);
      const checksum = resolveChecksum(hash, metadata);
      await bucket.put(key, data, {
        httpMetadata: {
          contentType: mimeType,
        },
        sha256: checksum,
      });
    },

    async putStream(
      hash: string,
      stream: ReadableStream<Uint8Array>,
      metadata?: Record<string, unknown>
    ): Promise<void> {
      await putStreamInternal(hash, stream, metadata);
    },

    async get(hash: string): Promise<Uint8Array | null> {
      const stream = await getStreamInternal(hash);
      if (!stream) return null;

      const reader = stream.getReader();
      try {
        const chunks: Uint8Array[] = [];
        let total = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          chunks.push(value);
          total += value.length;
        }
        const out = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          out.set(chunk, offset);
          offset += chunk.length;
        }
        return out;
      } finally {
        reader.releaseLock();
      }
    },

    async getStream(hash: string): Promise<ReadableStream<Uint8Array> | null> {
      return getStreamInternal(hash);
    },
  };
}
