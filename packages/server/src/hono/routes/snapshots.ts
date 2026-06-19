/**
 * Snapshot download routes:
 * - GET /snapshot-chunks/:chunkId
 * - GET /snapshot-artifacts/:artifactId
 */

import { ErrorResponseSchema } from '@syncular/core';
import type { SqlFamily, SyncCoreDb } from '@syncular/server';
import {
  InvalidSubscriptionScopeError,
  readScopedSnapshotArtifact,
  readSnapshotChunk,
  resolveEffectiveScopesForSubscriptions,
  scopesToSnapshotChunkScopeKey,
} from '@syncular/server';
import { describeRoute, resolver } from 'hono-openapi';
import { z } from 'zod';
import { syncError } from '../errors';
import { syncValidator as zValidator } from '../validation';
import type { SyncRoutesContext } from './context';
import {
  readSnapshotScopeValues,
  responseBodyOverLimit,
  type SyncAuthResult,
  snapshotArtifactParamsSchema,
  snapshotChunkParamsSchema,
  snapshotChunkQuerySchema,
} from './shared';

export function registerSnapshotRoutes<
  DB extends SyncCoreDb = SyncCoreDb,
  Auth extends SyncAuthResult = SyncAuthResult,
  F extends SqlFamily = SqlFamily,
>(ctx: SyncRoutesContext<DB, Auth, F>): void {
  const {
    routes,
    getAuth,
    options,
    handlerRegistry,
    maxSnapshotChunkResponseBytes,
    maxSnapshotArtifactResponseBytes,
  } = ctx;

  // -------------------------------------------------------------------------
  // GET /snapshot-chunks/:chunkId
  // -------------------------------------------------------------------------

  routes.get(
    '/snapshot-chunks/:chunkId',
    describeRoute({
      tags: ['sync'],
      summary: 'Download snapshot chunk',
      description: 'Download an encoded bootstrap snapshot chunk',
      responses: {
        200: {
          description: 'Snapshot chunk data (gzip-compressed framed JSON rows)',
          content: {
            'application/octet-stream': {
              schema: resolver(z.string()),
            },
          },
        },
        304: {
          description: 'Not modified (cached)',
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
    zValidator('param', snapshotChunkParamsSchema),
    zValidator('query', snapshotChunkQuerySchema),
    async (c) => {
      const auth = await getAuth(c);
      if (!auth) return syncError(c, 401, 'sync.auth_required');
      const partitionId = auth.partitionId ?? 'default';
      const query = c.req.valid('query');
      const requestedChunkScopes = readSnapshotScopeValues(c, query.scopes);

      const { chunkId } = c.req.valid('param');

      const chunk = await readSnapshotChunk(options.db, chunkId, {
        chunkStorage: options.chunkStorage,
      });
      if (!chunk) return syncError(c, 404, 'sync.not_found');
      if (chunk.partitionId !== partitionId) {
        return syncError(c, 403, 'sync.forbidden');
      }

      const nowIso = new Date().toISOString();
      if (chunk.expiresAt <= nowIso) {
        return syncError(c, 404, 'sync.not_found');
      }

      if (!requestedChunkScopes) {
        return syncError(
          c,
          400,
          'sync.invalid_request',
          'Snapshot chunk scope values are required'
        );
      }

      try {
        const resolved = await resolveEffectiveScopesForSubscriptions({
          db: options.db,
          auth,
          subscriptions: [
            {
              id: 'snapshot-chunk-authz',
              table: chunk.scope,
              scopes: requestedChunkScopes,
              cursor: 0,
              crdtStateVectors: [],
            },
          ],
          handlers: handlerRegistry,
          scopeCache: options.scopeCache,
        });
        const scopeAuth = resolved[0];
        if (!scopeAuth || scopeAuth.status !== 'active') {
          return syncError(c, 403, 'sync.forbidden');
        }

        const scopeHash = await scopesToSnapshotChunkScopeKey(scopeAuth.scopes);
        const scopedChunkKeyMatches =
          chunk.scopeKey.startsWith('snapshot-v2:') &&
          chunk.scopeKey.endsWith(`:scope:${scopeHash}`);
        if (!scopedChunkKeyMatches) {
          return syncError(c, 403, 'sync.forbidden');
        }
      } catch (error) {
        if (error instanceof InvalidSubscriptionScopeError) {
          return syncError(c, 403, 'sync.forbidden');
        }
        throw error;
      }

      const etag = `"sha256:${chunk.sha256}"`;
      const ifNoneMatch = c.req.header('if-none-match');
      if (ifNoneMatch && ifNoneMatch === etag) {
        return new Response(null, {
          status: 304,
          headers: {
            ETag: etag,
            'Cache-Control': 'private, max-age=0',
            Vary: 'Authorization, X-Syncular-Snapshot-Scopes',
          },
        });
      }

      const limitResponse = responseBodyOverLimit(c, {
        limit: 'maxSnapshotChunkResponseBytes',
        observed: chunk.byteLength,
        max: maxSnapshotChunkResponseBytes,
      });
      if (limitResponse) return limitResponse;

      return new Response(chunk.body as BodyInit, {
        status: 200,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(chunk.byteLength),
          ETag: etag,
          'Cache-Control': 'private, max-age=0',
          Vary: 'Authorization, X-Syncular-Snapshot-Scopes',
          'X-Sync-Chunk-Id': chunk.chunkId,
          'X-Sync-Chunk-Sha256': chunk.sha256,
          'X-Sync-Chunk-Encoding': chunk.encoding,
          'X-Sync-Chunk-Compression': chunk.compression,
        },
      });
    }
  );

  // -------------------------------------------------------------------------
  // GET /snapshot-artifacts/:artifactId
  // -------------------------------------------------------------------------

  routes.get(
    '/snapshot-artifacts/:artifactId',
    describeRoute({
      tags: ['sync'],
      summary: 'Download scoped snapshot artifact',
      description: 'Download a verified, scoped bootstrap snapshot artifact',
      responses: {
        200: {
          description: 'Scoped snapshot artifact bytes',
          content: {
            'application/octet-stream': {
              schema: resolver(z.string()),
            },
          },
        },
        304: {
          description: 'Not modified (cached)',
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
    zValidator('param', snapshotArtifactParamsSchema),
    zValidator('query', snapshotChunkQuerySchema),
    async (c) => {
      const auth = await getAuth(c);
      if (!auth) return syncError(c, 401, 'sync.auth_required');
      const artifactStorage = options.snapshotArtifactStorage;
      if (!artifactStorage) return syncError(c, 404, 'sync.not_found');

      const partitionId = auth.partitionId ?? 'default';
      const query = c.req.valid('query');
      const requestedArtifactScopes = readSnapshotScopeValues(c, query.scopes);
      const { artifactId } = c.req.valid('param');

      const artifact = await readScopedSnapshotArtifact(options.db, artifactId);
      if (!artifact) return syncError(c, 404, 'sync.not_found');
      if (artifact.partitionId !== partitionId) {
        return syncError(c, 403, 'sync.forbidden');
      }

      const nowIso = new Date().toISOString();
      if (artifact.expiresAt <= nowIso) {
        return syncError(c, 404, 'sync.not_found');
      }

      if (!requestedArtifactScopes) {
        return syncError(
          c,
          400,
          'sync.invalid_request',
          'Snapshot artifact scope values are required'
        );
      }

      try {
        const resolved = await resolveEffectiveScopesForSubscriptions({
          db: options.db,
          auth,
          subscriptions: [
            {
              id: artifact.subscriptionId,
              table: artifact.table,
              scopes: requestedArtifactScopes,
              cursor: 0,
              crdtStateVectors: [],
            },
          ],
          handlers: handlerRegistry,
          scopeCache: options.scopeCache,
        });
        const scopeAuth = resolved[0];
        if (!scopeAuth || scopeAuth.status !== 'active') {
          return syncError(c, 403, 'sync.forbidden');
        }

        const scopeHash = await scopesToSnapshotChunkScopeKey(scopeAuth.scopes);
        const scopedArtifactKeyMatches =
          artifact.scopeKey.startsWith('snapshot-artifact-v1:') &&
          artifact.scopeKey.endsWith(`:scope:${scopeHash}`);
        if (!scopedArtifactKeyMatches) {
          return syncError(c, 403, 'sync.forbidden');
        }
      } catch (error) {
        if (error instanceof InvalidSubscriptionScopeError) {
          return syncError(c, 403, 'sync.forbidden');
        }
        throw error;
      }

      const etag = `"sha256:${artifact.sha256}"`;
      const ifNoneMatch = c.req.header('if-none-match');
      if (ifNoneMatch && ifNoneMatch === etag) {
        return new Response(null, {
          status: 304,
          headers: {
            ETag: etag,
            'Cache-Control': 'private, max-age=0',
            Vary: 'Authorization, X-Syncular-Snapshot-Scopes',
          },
        });
      }

      const limitResponse = responseBodyOverLimit(c, {
        limit: 'maxSnapshotArtifactResponseBytes',
        observed: artifact.byteLength,
        max: maxSnapshotArtifactResponseBytes,
      });
      if (limitResponse) return limitResponse;

      let body: Uint8Array | ReadableStream<Uint8Array> | null = null;
      if (artifactStorage.readArtifactStream) {
        body = await artifactStorage.readArtifactStream(artifact);
      }
      body ??= await artifactStorage.readArtifact(artifact);
      if (!body) return syncError(c, 404, 'sync.not_found');

      return new Response(body as BodyInit, {
        status: 200,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(artifact.byteLength),
          ETag: etag,
          'Cache-Control': 'private, max-age=0',
          Vary: 'Authorization, X-Syncular-Snapshot-Scopes',
          'X-Sync-Artifact-Id': artifact.artifactId,
          'X-Sync-Artifact-Sha256': artifact.sha256,
          'X-Sync-Artifact-Kind': artifact.artifactKind,
          'X-Sync-Artifact-Compression': artifact.compression,
          'X-Sync-Artifact-Manifest-Digest': artifact.manifestDigest,
        },
      });
    }
  );
}
