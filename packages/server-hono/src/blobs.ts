/**
 * @syncular/server-hono - Blob routes for media/binary handling
 *
 * Provides:
 * - POST /blobs/upload - Initiate a blob upload (get presigned URL)
 * - POST /blobs/:hash/complete - Complete a blob upload
 * - GET /blobs/:hash/url - Get a presigned download URL
 * - PUT /blobs/:hash/upload - Direct upload (for database adapter)
 * - GET /blobs/:hash/download - Direct download (for database adapter)
 */

import {
  BlobUploadCompleteResponseSchema,
  BlobUploadInitRequestSchema,
  BlobUploadInitResponseSchema,
  createIncrementalSha256,
  ErrorResponseSchema,
  parseBlobHash,
  sha256Hex,
} from '@syncular/core';
import type {
  BlobManager,
  BlobNotFoundError,
  BlobValidationError,
} from '@syncular/server';
import {
  type BlobTokenSigner,
  readBlobFromDatabase,
  type SyncBlobsDb,
  storeBlobInDatabase,
} from '@syncular/server';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { describeRoute, resolver, validator as zValidator } from 'hono-openapi';
import type { Kysely } from 'kysely';
import { z } from 'zod';

interface BlobAuthResult {
  actorId: string;
  partitionId?: string;
}

export interface CreateBlobRoutesOptions<DB extends SyncBlobsDb = SyncBlobsDb> {
  /** Blob manager instance */
  blobManager: BlobManager;
  /** Authentication function */
  authenticate: (c: Context) => Promise<BlobAuthResult | null>;
  /**
   * Token signer for database adapter direct uploads/downloads.
   * Required if using the database blob storage adapter.
   */
  tokenSigner?: BlobTokenSigner;
  /**
   * Database instance for direct blob storage.
   * Required if using the database blob storage adapter.
   */
  db?: Kysely<DB>;
  /**
   * Check whether an authenticated actor can access a blob hash.
   * This must enforce your tenant or ownership model.
   */
  canAccessBlob: (args: {
    actorId: string;
    hash: string;
    partitionId: string;
  }) => Promise<boolean>;
  /**
   * Maximum upload size in bytes.
   * Default: 100MB (104857600)
   */
  maxUploadSize?: number;
}

const hashParamsSchema = z.object({
  hash: z.string().min(1),
});

const tokenQuerySchema = z.object({
  token: z.string().min(1),
});

/**
 * Create blob routes for Hono.
 *
 * @example
 * ```typescript
 * const blobRoutes = createBlobRoutes({
 *   blobManager,
 *   authenticate: async (c) => {
 *     const token = c.req.header('Authorization')?.replace('Bearer ', '');
 *     if (!token) return null;
 *     const user = await verifyToken(token);
 *     return user ? { actorId: user.id } : null;
 *   },
 *   canAccessBlob: async ({ actorId, hash, partitionId }) => {
 *     // Enforce tenant/ownership permissions here.
 *     // partitionId defaults to "default" when not provided by auth.
 *     return true;
 *   },
 * });
 *
 * app.route('/api/sync', blobRoutes);
 * ```
 */
export function createBlobRoutes<DB extends SyncBlobsDb>(
  options: CreateBlobRoutesOptions<DB>
): Hono {
  const {
    blobManager,
    authenticate,
    tokenSigner,
    db,
    canAccessBlob,
    maxUploadSize = 100 * 1024 * 1024, // 100MB
  } = options;

  const routes = new Hono();

  // -------------------------------------------------------------------------
  // POST /blobs/upload - Initiate upload
  // -------------------------------------------------------------------------

  routes.post(
    '/blobs/upload',
    describeRoute({
      tags: ['blobs'],
      summary: 'Initiate blob upload',
      description:
        'Initiates a blob upload and returns a presigned URL for uploading',
      responses: {
        200: {
          description: 'Upload initiated (or blob already exists)',
          content: {
            'application/json': {
              schema: resolver(BlobUploadInitResponseSchema),
            },
          },
        },
        400: {
          description: 'Invalid request',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
        401: {
          description: 'Unauthenticated',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
      },
    }),
    zValidator('json', BlobUploadInitRequestSchema),
    async (c) => {
      const auth = await authenticate(c);
      if (!auth) return c.json({ error: 'UNAUTHENTICATED' }, 401);

      const body = c.req.valid('json');

      // Validate size
      if (body.size > maxUploadSize) {
        return c.json(
          {
            error: 'BLOB_TOO_LARGE',
            message: `Maximum upload size is ${maxUploadSize} bytes`,
          },
          400
        );
      }

      try {
        const partitionId = auth.partitionId ?? 'default';
        const result = await blobManager.initiateUpload({
          hash: body.hash,
          size: body.size,
          mimeType: body.mimeType,
          actorId: auth.actorId,
          partitionId,
        });

        return c.json(result, 200);
      } catch (err) {
        if (isBlobValidationError(err)) {
          return c.json(
            { error: 'INVALID_REQUEST', message: err.message },
            400
          );
        }
        throw err;
      }
    }
  );

  // -------------------------------------------------------------------------
  // POST /blobs/:hash/complete - Complete upload
  // -------------------------------------------------------------------------

  routes.post(
    '/blobs/:hash/complete',
    describeRoute({
      tags: ['blobs'],
      summary: 'Complete blob upload',
      description:
        'Marks a blob upload as complete after the client has uploaded to the presigned URL',
      responses: {
        200: {
          description: 'Upload completed',
          content: {
            'application/json': {
              schema: resolver(BlobUploadCompleteResponseSchema),
            },
          },
        },
        400: {
          description: 'Invalid request or upload failed',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
        401: {
          description: 'Unauthenticated',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
      },
    }),
    zValidator('param', hashParamsSchema),
    async (c) => {
      const auth = await authenticate(c);
      if (!auth) return c.json({ error: 'UNAUTHENTICATED' }, 401);

      const { hash } = c.req.valid('param');

      // Validate hash format
      if (!parseBlobHash(hash)) {
        return c.json(
          { error: 'INVALID_REQUEST', message: 'Invalid blob hash format' },
          400
        );
      }

      const partitionId = auth.partitionId ?? 'default';
      const result = await blobManager.completeUpload(hash, {
        actorId: auth.actorId,
        partitionId,
      });

      if (!result.ok) {
        if (result.error === 'FORBIDDEN') {
          return c.json({ error: 'FORBIDDEN' }, 403);
        }
        return c.json({ error: 'UPLOAD_FAILED', message: result.error }, 400);
      }

      return c.json(result, 200);
    }
  );

  // -------------------------------------------------------------------------
  // GET /blobs/:hash/url - Get download URL
  // -------------------------------------------------------------------------

  routes.get(
    '/blobs/:hash/url',
    describeRoute({
      tags: ['blobs'],
      summary: 'Get blob download URL',
      description: 'Returns a presigned URL for downloading a blob',
      responses: {
        200: {
          description: 'Download URL',
          content: {
            'application/json': {
              schema: resolver(
                z.object({
                  url: z.string().url(),
                  expiresAt: z.string(),
                  metadata: z.object({
                    hash: z.string(),
                    size: z.number(),
                    mimeType: z.string(),
                    createdAt: z.string(),
                    uploadComplete: z.boolean(),
                  }),
                })
              ),
            },
          },
        },
        401: {
          description: 'Unauthenticated',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
        403: {
          description: 'Forbidden',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
        404: {
          description: 'Not found',
          content: {
            'application/json': { schema: resolver(ErrorResponseSchema) },
          },
        },
      },
    }),
    zValidator('param', hashParamsSchema),
    async (c) => {
      const auth = await authenticate(c);
      if (!auth) return c.json({ error: 'UNAUTHENTICATED' }, 401);

      const { hash } = c.req.valid('param');

      // Validate hash format
      if (!parseBlobHash(hash)) {
        return c.json({ error: 'NOT_FOUND' }, 404);
      }

      const partitionId = auth.partitionId ?? 'default';
      const canAccess = await canAccessBlob({
        actorId: auth.actorId,
        hash,
        partitionId,
      });
      if (!canAccess) {
        return c.json({ error: 'FORBIDDEN' }, 403);
      }

      try {
        const result = await blobManager.getDownloadUrl({
          hash,
          actorId: auth.actorId,
          partitionId,
        });
        return c.json(result, 200);
      } catch (err) {
        if (isBlobNotFoundError(err)) {
          return c.json({ error: 'NOT_FOUND' }, 404);
        }
        throw err;
      }
    }
  );

  // -------------------------------------------------------------------------
  // PUT /blobs/:hash/upload - Direct upload (database adapter)
  // -------------------------------------------------------------------------

  if (tokenSigner && db) {
    routes.put(
      '/blobs/:hash/upload',
      describeRoute({
        tags: ['blobs'],
        summary: 'Direct blob upload',
        description:
          'Direct upload endpoint for database storage adapter. Requires a signed token.',
        responses: {
          200: {
            description: 'Upload successful',
          },
          400: {
            description: 'Invalid request',
            content: {
              'application/json': { schema: resolver(ErrorResponseSchema) },
            },
          },
          401: {
            description: 'Invalid or expired token',
            content: {
              'application/json': { schema: resolver(ErrorResponseSchema) },
            },
          },
        },
      }),
      zValidator('param', hashParamsSchema),
      zValidator('query', tokenQuerySchema),
      async (c) => {
        const { hash } = c.req.valid('param');
        const { token } = c.req.valid('query');

        // Verify token
        const payload = await tokenSigner.verify(token);
        if (!payload || payload.action !== 'upload' || payload.hash !== hash) {
          return c.json({ error: 'INVALID_TOKEN' }, 401);
        }

        const uploadRecord = await blobManager.getUploadRecord(hash, {
          partitionId: payload.partitionId,
        });
        if (!uploadRecord) {
          return c.json({ error: 'UPLOAD_NOT_FOUND' }, 404);
        }
        if (uploadRecord.status !== 'pending') {
          return c.json({ error: 'UPLOAD_NOT_PENDING' }, 409);
        }
        if (payload.size !== uploadRecord.size) {
          return c.json({ error: 'INVALID_TOKEN' }, 401);
        }
        if (uploadRecord.size > maxUploadSize) {
          return c.json(
            {
              error: 'BLOB_TOO_LARGE',
              message: `Maximum upload size is ${maxUploadSize} bytes`,
            },
            400
          );
        }

        const contentLengthHeader = c.req.header('Content-Length');
        if (contentLengthHeader) {
          const contentLength = Number(contentLengthHeader);
          if (!Number.isFinite(contentLength) || contentLength < 0) {
            return c.json(
              { error: 'INVALID_REQUEST', message: 'Invalid Content-Length' },
              400
            );
          }
          if (contentLength > maxUploadSize) {
            return c.json(
              {
                error: 'BLOB_TOO_LARGE',
                message: `Maximum upload size is ${maxUploadSize} bytes`,
              },
              400
            );
          }
          if (contentLength !== uploadRecord.size) {
            return c.json(
              {
                error: 'SIZE_MISMATCH',
                message: `Expected ${uploadRecord.size} bytes, got ${contentLength}`,
              },
              400
            );
          }
        }

        const mimeType =
          c.req.header('Content-Type') ??
          uploadRecord.mimeType ??
          'application/octet-stream';
        const storagePartitionOptions = { partitionId: payload.partitionId };

        const streamingUpload = blobManager.adapter.putStream
          ? await createValidatedUploadStream(c.req.raw, {
              expectedSize: uploadRecord.size,
              maxSize: maxUploadSize,
            })
          : null;

        if (streamingUpload && blobManager.adapter.putStream) {
          try {
            await blobManager.adapter.putStream(
              hash,
              streamingUpload.stream,
              { mimeType },
              storagePartitionOptions
            );
          } catch (err) {
            if (isBlobUploadBodyError(err)) {
              void streamingUpload.hashHex.catch(() => {});
              return c.json(
                {
                  error: err.code,
                  message: err.message,
                },
                400
              );
            }
            void streamingUpload.hashHex.catch(() => {});
            throw err;
          }

          const computedHash = await streamingUpload.hashHex;
          const expectedHex = parseBlobHash(hash);
          if (!expectedHex || computedHash !== expectedHex) {
            await deleteUploadedBlobBestEffort(blobManager, hash, {
              partitionId: payload.partitionId,
            });
            return c.json(
              {
                error: 'HASH_MISMATCH',
                message: 'Content hash does not match',
              },
              400
            );
          }

          return c.text('OK', 200);
        }

        let bodyBytes: Uint8Array;
        try {
          bodyBytes = await readRequestBodyWithLimit(c.req.raw, {
            expectedSize: uploadRecord.size,
            maxSize: maxUploadSize,
          });
        } catch (err) {
          if (isBlobUploadBodyError(err)) {
            return c.json(
              {
                error: err.code,
                message: err.message,
              },
              400
            );
          }
          throw err;
        }

        // Verify hash
        const computedHash = await computeSha256Hash(bodyBytes);
        const expectedHex = parseBlobHash(hash);
        if (!expectedHex || computedHash !== expectedHex) {
          return c.json(
            {
              error: 'HASH_MISMATCH',
              message: 'Content hash does not match',
            },
            400
          );
        }

        if (blobManager.adapter.put) {
          await blobManager.adapter.put(
            hash,
            bodyBytes,
            { mimeType },
            storagePartitionOptions
          );
        } else {
          await storeBlobInDatabase(db, {
            partitionId: payload.partitionId,
            hash,
            size: bodyBytes.length,
            mimeType,
            body: bodyBytes,
          });
        }

        return c.text('OK', 200);
      }
    );

    // -------------------------------------------------------------------------
    // GET /blobs/:hash/download - Direct download (database adapter)
    // -------------------------------------------------------------------------

    routes.get(
      '/blobs/:hash/download',
      describeRoute({
        tags: ['blobs'],
        summary: 'Direct blob download',
        description:
          'Direct download endpoint for database storage adapter. Requires a signed token.',
        responses: {
          200: {
            description: 'Blob content',
          },
          401: {
            description: 'Invalid or expired token',
            content: {
              'application/json': { schema: resolver(ErrorResponseSchema) },
            },
          },
          404: {
            description: 'Not found',
            content: {
              'application/json': { schema: resolver(ErrorResponseSchema) },
            },
          },
        },
      }),
      zValidator('param', hashParamsSchema),
      zValidator('query', tokenQuerySchema),
      async (c) => {
        const { hash } = c.req.valid('param');
        const { token } = c.req.valid('query');

        // Verify token
        const payload = await tokenSigner.verify(token);
        if (
          !payload ||
          payload.action !== 'download' ||
          payload.hash !== hash
        ) {
          return c.json({ error: 'INVALID_TOKEN' }, 401);
        }

        // Read via the blob adapter (R2, database, etc.)
        if (blobManager.adapter.get) {
          const data = await blobManager.adapter.get(hash, {
            partitionId: payload.partitionId,
          });
          if (!data) {
            return c.json({ error: 'NOT_FOUND' }, 404);
          }
          const meta = blobManager.adapter.getMetadata
            ? await blobManager.adapter.getMetadata(hash, {
                partitionId: payload.partitionId,
              })
            : null;
          return new Response(data as BodyInit, {
            status: 200,
            headers: {
              'Content-Type': meta?.mimeType ?? 'application/octet-stream',
              'Content-Length': String(data.length),
              'Cache-Control': 'private, max-age=31536000, immutable',
            },
          });
        }

        // Fallback: read from database directly
        const blob = await readBlobFromDatabase(db, hash, {
          partitionId: payload.partitionId,
        });
        if (!blob) {
          return c.json({ error: 'NOT_FOUND' }, 404);
        }

        return new Response(blob.body as BodyInit, {
          status: 200,
          headers: {
            'Content-Type': blob.mimeType,
            'Content-Length': String(blob.size),
            'Cache-Control': 'private, max-age=31536000, immutable',
          },
        });
      }
    );
  }

  return routes;
}

// ============================================================================
// Helpers
// ============================================================================

function isBlobValidationError(err: unknown): err is BlobValidationError {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { name?: string }).name === 'BlobValidationError'
  );
}

function isBlobNotFoundError(err: unknown): err is BlobNotFoundError {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { name?: string }).name === 'BlobNotFoundError'
  );
}

class BlobUploadBodyError extends Error {
  constructor(
    public readonly code: 'BLOB_TOO_LARGE' | 'SIZE_MISMATCH',
    message: string
  ) {
    super(message);
    this.name = 'BlobUploadBodyError';
  }
}

function isBlobUploadBodyError(err: unknown): err is BlobUploadBodyError {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { name?: string }).name === 'BlobUploadBodyError'
  );
}

async function deleteUploadedBlobBestEffort(
  blobManager: BlobManager,
  hash: string,
  options: { partitionId: string }
): Promise<void> {
  try {
    await blobManager.adapter.delete(hash, options);
  } catch {
    // Best-effort cleanup only.
  }
}

interface ValidatedUploadStream {
  stream: ReadableStream<Uint8Array>;
  hashHex: Promise<string>;
}

async function createValidatedUploadStream(
  request: Request,
  args: { expectedSize: number; maxSize: number }
): Promise<ValidatedUploadStream | null> {
  const body = request.body;
  if (!body) return null;

  const hasher = await createIncrementalSha256();
  const reader = body.getReader();

  let resolveHash: ((hashHex: string) => void) | null = null;
  let rejectHash: ((reason: Error) => void) | null = null;
  const hashHex = new Promise<string>((resolve, reject) => {
    resolveHash = resolve;
    rejectHash = reject;
  });

  let totalSize = 0;
  let finalized = false;

  const fail = (error: Error): void => {
    if (finalized) return;
    finalized = true;
    rejectHash?.(error);
  };

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          if (totalSize !== args.expectedSize) {
            const sizeError = new BlobUploadBodyError(
              'SIZE_MISMATCH',
              `Expected ${args.expectedSize} bytes, got ${totalSize}`
            );
            fail(sizeError);
            controller.error(sizeError);
            return;
          }
          if (!finalized) {
            try {
              const hash = await hasher.digestHex();
              finalized = true;
              resolveHash?.(hash);
            } catch (err) {
              const hashError =
                err instanceof Error
                  ? err
                  : new Error('Failed to finalize upload body hash');
              fail(hashError);
              controller.error(hashError);
              return;
            }
          }
          controller.close();
          return;
        }

        if (!value || value.length === 0) {
          return;
        }

        totalSize += value.length;
        if (totalSize > args.maxSize) {
          const limitError = new BlobUploadBodyError(
            'BLOB_TOO_LARGE',
            `Maximum upload size is ${args.maxSize} bytes`
          );
          fail(limitError);
          controller.error(limitError);
          return;
        }
        if (totalSize > args.expectedSize) {
          const mismatchError = new BlobUploadBodyError(
            'SIZE_MISMATCH',
            `Expected ${args.expectedSize} bytes, got more than expected`
          );
          fail(mismatchError);
          controller.error(mismatchError);
          return;
        }

        hasher.update(value);
        controller.enqueue(value);
      } catch (err) {
        const streamError =
          err instanceof Error ? err : new Error('Failed to read upload body');
        fail(streamError);
        controller.error(streamError);
      }
    },
    cancel() {
      reader.cancel().catch(() => {});
    },
  });

  return { stream, hashHex };
}

async function readRequestBodyWithLimit(
  request: Request,
  args: { expectedSize: number; maxSize: number }
): Promise<Uint8Array> {
  const body = request.body;
  if (!body) {
    if (args.expectedSize === 0) return new Uint8Array();
    throw new BlobUploadBodyError(
      'SIZE_MISMATCH',
      `Expected ${args.expectedSize} bytes, got 0`
    );
  }

  const reader = body.getReader();
  const merged = new Uint8Array(args.expectedSize);
  let totalSize = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || value.length === 0) continue;

    totalSize += value.length;
    if (totalSize > args.maxSize) {
      throw new BlobUploadBodyError(
        'BLOB_TOO_LARGE',
        `Maximum upload size is ${args.maxSize} bytes`
      );
    }
    if (totalSize > args.expectedSize) {
      throw new BlobUploadBodyError(
        'SIZE_MISMATCH',
        `Expected ${args.expectedSize} bytes, got more than expected`
      );
    }
    merged.set(value, totalSize - value.length);
  }

  if (totalSize !== args.expectedSize) {
    throw new BlobUploadBodyError(
      'SIZE_MISMATCH',
      `Expected ${args.expectedSize} bytes, got ${totalSize}`
    );
  }

  return merged;
}

async function computeSha256Hash(data: Uint8Array): Promise<string> {
  return sha256Hex(data);
}
