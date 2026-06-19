/**
 * Filesystem blob storage adapter.
 *
 * Stores blobs as files on disk with 2-level hash-based subdirectories.
 * Uploads/downloads go through the server's blob routes using signed tokens
 * (same pattern as the database adapter).
 */

import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  BlobSignDownloadOptions,
  BlobSignedUpload,
  BlobSignUploadOptions,
  BlobStorageAdapter,
} from '@syncular/core';

export interface BlobTokenSigner {
  sign(
    payload:
      | {
          hash: string;
          partitionId: string;
          action: 'upload';
          size: number;
          expiresAt: number;
        }
      | {
          hash: string;
          partitionId: string;
          action: 'download';
          expiresAt: number;
        },
    expiresInSeconds: number
  ): Promise<string>;
}

function hasErrnoCode(error: unknown, code: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  return (error as { code?: unknown }).code === code;
}

export interface FilesystemBlobStorageAdapterOptions {
  /** Directory root for blob files */
  basePath: string;
  /** Server base URL for upload/download routes (e.g. "/api/sync") */
  baseUrl: string;
  /** Token signer for authorization */
  tokenSigner: BlobTokenSigner;
}

/**
 * Resolve hash to a 2-level subdirectory path:
 * `{basePath}/{hex[0..2]}/{hex[2..4]}/{hex}`
 */
function normalizePartitionId(partitionId?: string): string {
  const raw = partitionId?.trim();
  if (!raw) return 'default';
  return raw;
}

function hashToFilePath(
  basePath: string,
  hash: string,
  partitionId?: string
): string {
  const hex = hash.startsWith('sha256:') ? hash.slice(7) : hash;
  const normalizedPartition = normalizePartitionId(partitionId);
  if (!partitionId || normalizedPartition === 'default') {
    return join(basePath, hex.slice(0, 2), hex.slice(2, 4), hex);
  }
  const partitionPath = encodeURIComponent(normalizedPartition);
  return join(basePath, partitionPath, hex.slice(0, 2), hex.slice(2, 4), hex);
}

function tmpPath(filePath: string): string {
  return `${filePath}.${Date.now()}.tmp`;
}

/**
 * Create a filesystem blob storage adapter.
 *
 * @example
 * ```typescript
 * const adapter = createFilesystemBlobStorageAdapter({
 *   basePath: '/data/blobs',
 *   baseUrl: 'https://api.example.com/api/sync',
 *   tokenSigner: createHmacTokenSigner(process.env.BLOB_SECRET!),
 * });
 * ```
 */
export function createFilesystemBlobStorageAdapter(
  options: FilesystemBlobStorageAdapterOptions
): BlobStorageAdapter {
  const { basePath, tokenSigner } = options;
  const normalizedBaseUrl = options.baseUrl.replace(/\/$/, '');

  return {
    name: 'filesystem',

    async signUpload(opts: BlobSignUploadOptions): Promise<BlobSignedUpload> {
      const partitionId = normalizePartitionId(opts.partitionId);
      const expiresAt = Date.now() + opts.expiresIn * 1000;
      const token = await tokenSigner.sign(
        {
          hash: opts.hash,
          partitionId,
          action: 'upload',
          size: opts.size,
          expiresAt,
        },
        opts.expiresIn
      );

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
      const partitionId = normalizePartitionId(opts.partitionId);
      const expiresAt = Date.now() + opts.expiresIn * 1000;
      const token = await tokenSigner.sign(
        { hash: opts.hash, partitionId, action: 'download', expiresAt },
        opts.expiresIn
      );

      return `${normalizedBaseUrl}/blobs/${encodeURIComponent(opts.hash)}/download?token=${encodeURIComponent(token)}`;
    },

    async exists(
      hash: string,
      options?: { partitionId?: string }
    ): Promise<boolean> {
      try {
        await stat(hashToFilePath(basePath, hash, options?.partitionId));
        return true;
      } catch {
        return false;
      }
    },

    async delete(
      hash: string,
      options?: { partitionId?: string }
    ): Promise<void> {
      try {
        await unlink(hashToFilePath(basePath, hash, options?.partitionId));
      } catch (err) {
        if (!hasErrnoCode(err, 'ENOENT')) throw err;
      }
    },

    async getMetadata(
      hash: string,
      options?: { partitionId?: string }
    ): Promise<{ size: number; mimeType?: string } | null> {
      try {
        const fileStats = await stat(
          hashToFilePath(basePath, hash, options?.partitionId)
        );
        return { size: fileStats.size };
      } catch {
        return null;
      }
    },

    async put(
      hash: string,
      data: Uint8Array,
      _metadata?: Record<string, unknown>,
      options?: { partitionId?: string }
    ): Promise<void> {
      const filePath = hashToFilePath(basePath, hash, options?.partitionId);
      const tmp = tmpPath(filePath);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(tmp, data);
      await rename(tmp, filePath);
    },

    async putStream(
      hash: string,
      stream: ReadableStream<Uint8Array>,
      _metadata?: Record<string, unknown>,
      options?: { partitionId?: string }
    ): Promise<void> {
      const filePath = hashToFilePath(basePath, hash, options?.partitionId);
      const tmp = tmpPath(filePath);
      await mkdir(dirname(filePath), { recursive: true });

      const fh = await open(tmp, 'w');
      try {
        const reader = stream.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          await fh.write(value);
        }
      } finally {
        await fh.close();
      }

      await rename(tmp, filePath);
    },

    async get(
      hash: string,
      options?: { partitionId?: string }
    ): Promise<Uint8Array | null> {
      try {
        const data = await readFile(
          hashToFilePath(basePath, hash, options?.partitionId)
        );
        return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      } catch (err) {
        if (hasErrnoCode(err, 'ENOENT')) return null;
        throw err;
      }
    },

    async getStream(
      hash: string,
      options?: { partitionId?: string }
    ): Promise<ReadableStream<Uint8Array> | null> {
      let data: Uint8Array;
      try {
        data = await readFile(
          hashToFilePath(basePath, hash, options?.partitionId)
        );
      } catch (err) {
        if (hasErrnoCode(err, 'ENOENT')) return null;
        throw err;
      }
      const bytes = new Uint8Array(
        data.buffer,
        data.byteOffset,
        data.byteLength
      );
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });
    },
  };
}
