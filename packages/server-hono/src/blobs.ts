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
  ErrorResponseSchema,
  parseBlobHash,
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
   * Optional: Check if actor can access a blob.
   * By default, any authenticated actor can access any completed blob.
   * Provide this to implement scope-based access control.
   */
  canAccessBlob?: (args: { actorId: string; hash: string }) => Promise<boolean>;
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
        const result = await blobManager.initiateUpload({
          hash: body.hash,
          size: body.size,
          mimeType: body.mimeType,
          actorId: auth.actorId,
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

      const result = await blobManager.completeUpload(hash);

      if (!result.ok) {
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

      // Check access if canAccessBlob is provided
      if (canAccessBlob) {
        const canAccess = await canAccessBlob({ actorId: auth.actorId, hash });
        if (!canAccess) {
          return c.json({ error: 'FORBIDDEN' }, 403);
        }
      }

      try {
        const result = await blobManager.getDownloadUrl({
          hash,
          actorId: auth.actorId,
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

        // Get upload metadata
        const metadata = await blobManager.getMetadata(hash);

        // Read body
        const body = await c.req.arrayBuffer();
        const bodyBytes = new Uint8Array(body);

        // Verify size
        const expectedSize = metadata?.size;
        if (expectedSize !== undefined && bodyBytes.length !== expectedSize) {
          return c.json(
            {
              error: 'SIZE_MISMATCH',
              message: `Expected ${expectedSize} bytes, got ${bodyBytes.length}`,
            },
            400
          );
        }

        // Verify hash
        const computedHash = await computeSha256Hash(bodyBytes);
        const expectedHex = parseBlobHash(hash);
        if (computedHash !== expectedHex) {
          return c.json(
            {
              error: 'HASH_MISMATCH',
              message: 'Content hash does not match',
            },
            400
          );
        }

        // Store via the blob adapter (R2, database, etc.)
        const mimeType =
          c.req.header('Content-Type') ??
          metadata?.mimeType ??
          'application/octet-stream';

        if (blobManager.adapter.put) {
          await blobManager.adapter.put(hash, bodyBytes, { mimeType });
        } else {
          await storeBlobInDatabase(db, {
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
          const data = await blobManager.adapter.get(hash);
          if (!data) {
            return c.json({ error: 'NOT_FOUND' }, 404);
          }
          const meta = blobManager.adapter.getMetadata
            ? await blobManager.adapter.getMetadata(hash)
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
        const blob = await readBlobFromDatabase(db, hash);
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

async function computeSha256Hash(data: Uint8Array): Promise<string> {
  // Create a new ArrayBuffer copy to satisfy TypeScript's strict typing
  const buffer = new Uint8Array(data).buffer as ArrayBuffer;
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
