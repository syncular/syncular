/**
 * S3-compatible blob storage adapter.
 *
 * Works with AWS S3, Cloudflare R2, MinIO, and other S3-compatible services.
 * Requires @aws-sdk/client-s3 and @aws-sdk/s3-request-presigner as peer dependencies.
 */

import type {
  BlobSignDownloadOptions,
  BlobSignedUpload,
  BlobSignUploadOptions,
  BlobStorageAdapter,
} from '@syncular/core';

/**
 * S3 client interface (minimal subset of @aws-sdk/client-s3).
 * This allows users to pass in their own configured S3 client.
 */
export interface S3ClientLike {
  send(command: unknown): Promise<unknown>;
}

/**
 * Function to create presigned URLs.
 * This should be getSignedUrl from @aws-sdk/s3-request-presigner.
 */
export type GetSignedUrlFn = (
  client: S3ClientLike,
  command: unknown,
  options: { expiresIn: number }
) => Promise<string>;

/**
 * S3 command constructors.
 * These should be imported from @aws-sdk/client-s3.
 */
export interface S3Commands {
  PutObjectCommand: new (input: {
    Bucket: string;
    Key: string;
    ContentLength?: number;
    ContentType?: string;
    ChecksumSHA256?: string;
    Body?: Uint8Array | ReadableStream<Uint8Array>;
  }) => unknown;
  GetObjectCommand: new (input: { Bucket: string; Key: string }) => unknown;
  HeadObjectCommand: new (input: { Bucket: string; Key: string }) => unknown;
  DeleteObjectCommand: new (input: { Bucket: string; Key: string }) => unknown;
}

export interface S3BlobStorageAdapterOptions {
  /** S3 client instance */
  client: S3ClientLike;
  /** S3 bucket name */
  bucket: string;
  /** Optional key prefix for all blobs */
  keyPrefix?: string;
  /** S3 command constructors */
  commands: S3Commands;
  /** getSignedUrl function from @aws-sdk/s3-request-presigner */
  getSignedUrl: GetSignedUrlFn;
  /**
   * Whether to require SHA-256 checksum validation on upload.
   * Supported by S3 and R2. Default: true.
   */
  requireChecksum?: boolean;
}

/**
 * Create an S3-compatible blob storage adapter.
 *
 * @example
 * ```typescript
 * import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
 * import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
 *
 * const adapter = createS3BlobStorageAdapter({
 *   client: new S3Client({ region: 'us-east-1' }),
 *   bucket: 'my-bucket',
 *   keyPrefix: 'blobs/',
 *   commands: { PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand },
 *   getSignedUrl,
 * });
 * ```
 */
export function createS3BlobStorageAdapter(
  options: S3BlobStorageAdapterOptions
): BlobStorageAdapter {
  const {
    client,
    bucket,
    keyPrefix = '',
    commands,
    getSignedUrl,
    requireChecksum = true,
  } = options;

  function getKey(hash: string): string {
    // Remove "sha256:" prefix and use hex as key
    const hex = hash.startsWith('sha256:') ? hash.slice(7) : hash;
    return `${keyPrefix}${hex}`;
  }

  return {
    name: 's3',

    async signUpload(opts: BlobSignUploadOptions): Promise<BlobSignedUpload> {
      const key = getKey(opts.hash);

      // Extract hex hash for checksum (S3 expects base64-encoded SHA-256)
      const hexHash = opts.hash.startsWith('sha256:')
        ? opts.hash.slice(7)
        : opts.hash;

      // Convert hex to base64 for S3 checksum header
      const checksumBase64 = hexToBase64(hexHash);

      const commandInput: {
        Bucket: string;
        Key: string;
        ContentLength: number;
        ContentType: string;
        ChecksumSHA256?: string;
      } = {
        Bucket: bucket,
        Key: key,
        ContentLength: opts.size,
        ContentType: opts.mimeType,
      };

      if (requireChecksum) {
        commandInput.ChecksumSHA256 = checksumBase64;
      }

      const command = new commands.PutObjectCommand(commandInput);
      const url = await getSignedUrl(client, command, {
        expiresIn: opts.expiresIn,
      });

      const headers: Record<string, string> = {
        'Content-Type': opts.mimeType,
        'Content-Length': String(opts.size),
      };

      if (requireChecksum) {
        headers['x-amz-checksum-sha256'] = checksumBase64;
      }

      return {
        url,
        method: 'PUT',
        headers,
      };
    },

    async signDownload(opts: BlobSignDownloadOptions): Promise<string> {
      const key = getKey(opts.hash);
      const command = new commands.GetObjectCommand({
        Bucket: bucket,
        Key: key,
      });
      return getSignedUrl(client, command, { expiresIn: opts.expiresIn });
    },

    async exists(hash: string): Promise<boolean> {
      const key = getKey(hash);
      try {
        const command = new commands.HeadObjectCommand({
          Bucket: bucket,
          Key: key,
        });
        await client.send(command);
        return true;
      } catch (err) {
        // Check for NotFound error
        if (isNotFoundError(err)) {
          return false;
        }
        throw err;
      }
    },

    async delete(hash: string): Promise<void> {
      const key = getKey(hash);
      const command = new commands.DeleteObjectCommand({
        Bucket: bucket,
        Key: key,
      });
      await client.send(command);
    },

    async getMetadata(
      hash: string
    ): Promise<{ size: number; mimeType?: string } | null> {
      const key = getKey(hash);
      try {
        const command = new commands.HeadObjectCommand({
          Bucket: bucket,
          Key: key,
        });
        const response = (await client.send(command)) as {
          ContentLength?: number;
          ContentType?: string;
        };
        return {
          size: response.ContentLength ?? 0,
          mimeType: response.ContentType,
        };
      } catch (err) {
        if (isNotFoundError(err)) {
          return null;
        }
        throw err;
      }
    },

    async put(hash: string, data: Uint8Array): Promise<void> {
      const key = getKey(hash);
      const command = new commands.PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: data,
        ContentLength: data.length,
        ContentType: 'application/octet-stream',
      });
      await client.send(command);
    },

    async get(hash: string): Promise<Uint8Array | null> {
      const key = getKey(hash);
      try {
        const command = new commands.GetObjectCommand({
          Bucket: bucket,
          Key: key,
        });
        const response = (await client.send(command)) as {
          Body?: { transformToByteArray(): Promise<Uint8Array> };
        };
        if (!response.Body) return null;
        return response.Body.transformToByteArray();
      } catch (err) {
        if (isNotFoundError(err)) {
          return null;
        }
        throw err;
      }
    },

    async getStream(hash: string): Promise<ReadableStream<Uint8Array> | null> {
      const key = getKey(hash);
      try {
        const command = new commands.GetObjectCommand({
          Bucket: bucket,
          Key: key,
        });
        const response = (await client.send(command)) as {
          Body?: { transformToWebStream(): ReadableStream<Uint8Array> };
        };
        if (!response.Body) return null;
        return response.Body.transformToWebStream();
      } catch (err) {
        if (isNotFoundError(err)) {
          return null;
        }
        throw err;
      }
    },
  };
}

function isNotFoundError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e.name === 'NotFound' ||
    e.name === 'NoSuchKey' ||
    e.$metadata?.httpStatusCode === 404
  );
}

function hexToBase64(hex: string): string {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }

  // Use Buffer if available (Node/Bun), otherwise manual base64
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }

  // Manual base64 encoding
  const chars =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let result = '';
  const len = bytes.length;
  const remainder = len % 3;

  for (let i = 0; i < len - remainder; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1]!;
    const c = bytes[i + 2]!;
    result +=
      chars.charAt((a >> 2) & 0x3f) +
      chars.charAt(((a << 4) | (b >> 4)) & 0x3f) +
      chars.charAt(((b << 2) | (c >> 6)) & 0x3f) +
      chars.charAt(c & 0x3f);
  }

  if (remainder === 1) {
    const a = bytes[len - 1]!;
    result += `${chars.charAt((a >> 2) & 0x3f) + chars.charAt((a << 4) & 0x3f)}==`;
  } else if (remainder === 2) {
    const a = bytes[len - 2]!;
    const b = bytes[len - 1]!;
    result +=
      chars.charAt((a >> 2) & 0x3f) +
      chars.charAt(((a << 4) | (b >> 4)) & 0x3f) +
      chars.charAt((b << 2) & 0x3f) +
      '=';
  }

  return result;
}
