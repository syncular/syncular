/**
 * @syncular/server-hono - Console API key routes.
 *
 * Extracted from console/routes.ts without behavior changes.
 */

import { ErrorResponseSchema, logSyncEvent } from '@syncular/core';
import { coerceNumber } from '@syncular/server';
import { resolver } from 'hono-openapi';
import { consoleValidator as zValidator } from '../../validation';
import { describeConsoleRoute } from '../route-descriptor';
import {
  type ApiKeyType,
  type ConsoleApiKey,
  ConsoleApiKeyBulkRevokeRequestSchema,
  type ConsoleApiKeyBulkRevokeResponse,
  ConsoleApiKeyBulkRevokeResponseSchema,
  ConsoleApiKeyCreateRequestSchema,
  type ConsoleApiKeyCreateResponse,
  ConsoleApiKeyCreateResponseSchema,
  ConsoleApiKeyRevokeResponseSchema,
  ConsoleApiKeySchema,
  type ConsolePaginatedResponse,
  ConsolePaginatedResponseSchema,
} from '../schemas';
import type { ConsoleRoutesContext } from './context';
import {
  apiKeyIdParamSchema,
  apiKeysQuerySchema,
  consoleNotFound,
  consoleRouteError,
  generateKeyId,
  generateSecretKey,
  hashApiKey,
} from './shared';

export function registerApiKeyRoutes(ctx: ConsoleRoutesContext): void {
  const { routes, options, db } = ctx;

  // -------------------------------------------------------------------------
  // GET /api-keys - List all API keys
  // -------------------------------------------------------------------------

  routes.get(
    '/api-keys',
    describeConsoleRoute({
      summary: 'List API keys',
      responses: {
        200: {
          description: 'Paginated API key list',
          content: {
            'application/json': {
              schema: resolver(
                ConsolePaginatedResponseSchema(ConsoleApiKeySchema)
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
      },
    }),
    zValidator('query', apiKeysQuerySchema),
    async (c) => {
      const {
        limit,
        offset,
        type: keyType,
        status,
        expiresWithinDays,
      } = c.req.valid('query');

      let query = db
        .selectFrom('sync_api_keys')
        .select([
          'key_id',
          'key_prefix',
          'name',
          'key_type',
          'scope_keys',
          'actor_id',
          'created_at',
          'expires_at',
          'last_used_at',
          'revoked_at',
        ]);

      let countQuery = db
        .selectFrom('sync_api_keys')
        .select(({ fn }) => fn.countAll().as('total'));

      if (keyType) {
        query = query.where('key_type', '=', keyType);
        countQuery = countQuery.where('key_type', '=', keyType);
      }

      const now = new Date();
      const nowIso = now.toISOString();
      const expiringThresholdIso = new Date(
        now.getTime() + (expiresWithinDays ?? 14) * 24 * 60 * 60 * 1000
      ).toISOString();

      if (status === 'active') {
        query = query
          .where('revoked_at', 'is', null)
          .where((eb) =>
            eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', nowIso)])
          );
        countQuery = countQuery
          .where('revoked_at', 'is', null)
          .where((eb) =>
            eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', nowIso)])
          );
      } else if (status === 'revoked') {
        query = query.where('revoked_at', 'is not', null);
        countQuery = countQuery.where('revoked_at', 'is not', null);
      } else if (status === 'expiring') {
        query = query
          .where('revoked_at', 'is', null)
          .where('expires_at', '>', nowIso)
          .where('expires_at', '<=', expiringThresholdIso);
        countQuery = countQuery
          .where('revoked_at', 'is', null)
          .where('expires_at', '>', nowIso)
          .where('expires_at', '<=', expiringThresholdIso);
      }

      const [rows, countRow] = await Promise.all([
        query
          .orderBy('created_at', 'desc')
          .limit(limit)
          .offset(offset)
          .execute(),
        countQuery.executeTakeFirst(),
      ]);

      const items: ConsoleApiKey[] = rows.map((row) => ({
        keyId: row.key_id ?? '',
        keyPrefix: row.key_prefix ?? '',
        name: row.name ?? '',
        keyType: row.key_type as ApiKeyType,
        scopeKeys: options.dialect.dbToArray(row.scope_keys),
        actorId: row.actor_id ?? null,
        createdAt: row.created_at ?? '',
        expiresAt: row.expires_at ?? null,
        lastUsedAt: row.last_used_at ?? null,
        revokedAt: row.revoked_at ?? null,
      }));

      const totalCount = coerceNumber(countRow?.total) ?? 0;

      const response: ConsolePaginatedResponse<ConsoleApiKey> = {
        items,
        total: totalCount,
        offset,
        limit,
      };

      c.header('X-Total-Count', String(totalCount));
      return c.json(response, 200);
    }
  );

  // -------------------------------------------------------------------------
  // POST /api-keys - Create new API key
  // -------------------------------------------------------------------------

  routes.post(
    '/api-keys',
    describeConsoleRoute({
      summary: 'Create API key',
      responses: {
        201: {
          description: 'Created API key',
          content: {
            'application/json': {
              schema: resolver(ConsoleApiKeyCreateResponseSchema),
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
    zValidator('json', ConsoleApiKeyCreateRequestSchema),
    async (c) => {
      const body = c.req.valid('json');

      // Generate key components
      const keyId = generateKeyId();
      const secretKey = generateSecretKey(body.keyType);
      const keyHash = await hashApiKey(secretKey);
      const keyPrefix = secretKey.slice(0, 12);

      // Calculate expiry
      let expiresAt: string | null = null;
      if (body.expiresInDays && body.expiresInDays > 0) {
        expiresAt = new Date(
          Date.now() + body.expiresInDays * 24 * 60 * 60 * 1000
        ).toISOString();
      }

      const scopeKeys = body.scopeKeys ?? [];
      const now = new Date().toISOString();

      // Insert into database
      await db
        .insertInto('sync_api_keys')
        .values({
          key_id: keyId,
          key_hash: keyHash,
          key_prefix: keyPrefix,
          name: body.name,
          key_type: body.keyType,
          scope_keys: options.dialect.arrayToDb(scopeKeys),
          actor_id: body.actorId ?? null,
          created_at: now,
          expires_at: expiresAt,
          last_used_at: null,
          revoked_at: null,
        })
        .execute();

      logSyncEvent({
        event: 'console.create_api_key',
        consoleUserId: c.var.consoleAuth.consoleUserId,
        keyId,
        keyType: body.keyType,
      });

      const key: ConsoleApiKey = {
        keyId,
        keyPrefix,
        name: body.name,
        keyType: body.keyType,
        scopeKeys,
        actorId: body.actorId ?? null,
        createdAt: now,
        expiresAt,
        lastUsedAt: null,
        revokedAt: null,
      };

      const response: ConsoleApiKeyCreateResponse = {
        key,
        secretKey,
      };

      return c.json(response, 201);
    }
  );

  // -------------------------------------------------------------------------
  // GET /api-keys/:id - Get single API key
  // -------------------------------------------------------------------------

  routes.get(
    '/api-keys/:id',
    describeConsoleRoute({
      summary: 'Get API key',
      responses: {
        200: {
          description: 'API key details',
          content: {
            'application/json': { schema: resolver(ConsoleApiKeySchema) },
          },
        },
        401: {
          description: 'Unauthenticated',
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
    zValidator('param', apiKeyIdParamSchema),
    async (c) => {
      const { id: keyId } = c.req.valid('param');

      const row = await db
        .selectFrom('sync_api_keys')
        .select([
          'key_id',
          'key_prefix',
          'name',
          'key_type',
          'scope_keys',
          'actor_id',
          'created_at',
          'expires_at',
          'last_used_at',
          'revoked_at',
        ])
        .where('key_id', '=', keyId)
        .executeTakeFirst();

      if (!row) {
        return consoleNotFound(c);
      }

      const key: ConsoleApiKey = {
        keyId: row.key_id ?? '',
        keyPrefix: row.key_prefix ?? '',
        name: row.name ?? '',
        keyType: row.key_type as ApiKeyType,
        scopeKeys: options.dialect.dbToArray(row.scope_keys),
        actorId: row.actor_id ?? null,
        createdAt: row.created_at ?? '',
        expiresAt: row.expires_at ?? null,
        lastUsedAt: row.last_used_at ?? null,
        revokedAt: row.revoked_at ?? null,
      };

      return c.json(key, 200);
    }
  );

  // -------------------------------------------------------------------------
  // DELETE /api-keys/:id - Revoke API key (soft delete)
  // -------------------------------------------------------------------------

  routes.delete(
    '/api-keys/:id',
    describeConsoleRoute({
      summary: 'Revoke API key',
      responses: {
        200: {
          description: 'Revoke result',
          content: {
            'application/json': {
              schema: resolver(ConsoleApiKeyRevokeResponseSchema),
            },
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
    zValidator('param', apiKeyIdParamSchema),
    async (c) => {
      const { id: keyId } = c.req.valid('param');
      const now = new Date().toISOString();

      const res = await db
        .updateTable('sync_api_keys')
        .set({ revoked_at: now })
        .where('key_id', '=', keyId)
        .where('revoked_at', 'is', null)
        .executeTakeFirst();

      const revoked = Number(res?.numUpdatedRows ?? 0) > 0;

      logSyncEvent({
        event: 'console.revoke_api_key',
        consoleUserId: c.var.consoleAuth.consoleUserId,
        keyId,
        revoked,
      });

      return c.json({ revoked }, 200);
    }
  );

  // -------------------------------------------------------------------------
  // POST /api-keys/bulk-revoke - Revoke multiple API keys
  // -------------------------------------------------------------------------

  routes.post(
    '/api-keys/bulk-revoke',
    describeConsoleRoute({
      summary: 'Bulk revoke API keys',
      responses: {
        200: {
          description: 'Bulk revoke result',
          content: {
            'application/json': {
              schema: resolver(ConsoleApiKeyBulkRevokeResponseSchema),
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
    zValidator('json', ConsoleApiKeyBulkRevokeRequestSchema),
    async (c) => {
      const body = c.req.valid('json');
      const keyIds = [...new Set(body.keyIds.map((keyId) => keyId.trim()))]
        .filter((keyId) => keyId.length > 0)
        .slice(0, 200);

      if (keyIds.length === 0) {
        return consoleRouteError(
          c,
          400,
          'console.invalid_request',
          'No API key IDs provided'
        );
      }

      const now = new Date().toISOString();
      const existingRows = await db
        .selectFrom('sync_api_keys')
        .select(['key_id', 'revoked_at'])
        .where('key_id', 'in', keyIds)
        .execute();

      const existingById = new Map(
        existingRows.map((row) => [row.key_id, row.revoked_at])
      );

      const notFoundKeyIds: string[] = [];
      const alreadyRevokedKeyIds: string[] = [];
      const revokeCandidateKeyIds: string[] = [];

      for (const keyId of keyIds) {
        const revokedAt = existingById.get(keyId);
        if (revokedAt === undefined) {
          notFoundKeyIds.push(keyId);
        } else if (revokedAt !== null) {
          alreadyRevokedKeyIds.push(keyId);
        } else {
          revokeCandidateKeyIds.push(keyId);
        }
      }

      let revokedCount = 0;
      if (revokeCandidateKeyIds.length > 0) {
        const updateResult = await db
          .updateTable('sync_api_keys')
          .set({ revoked_at: now })
          .where('key_id', 'in', revokeCandidateKeyIds)
          .where('revoked_at', 'is', null)
          .executeTakeFirst();

        revokedCount = Number(updateResult?.numUpdatedRows ?? 0);
      }

      const response: ConsoleApiKeyBulkRevokeResponse = {
        requestedCount: keyIds.length,
        revokedCount,
        alreadyRevokedCount: alreadyRevokedKeyIds.length,
        notFoundCount: notFoundKeyIds.length,
        revokedKeyIds: revokeCandidateKeyIds,
        alreadyRevokedKeyIds,
        notFoundKeyIds,
      };

      logSyncEvent({
        event: 'console.bulk_revoke_api_keys',
        consoleUserId: c.var.consoleAuth.consoleUserId,
        requestedCount: response.requestedCount,
        revokedCount: response.revokedCount,
        alreadyRevokedCount: response.alreadyRevokedCount,
        notFoundCount: response.notFoundCount,
      });

      return c.json(response, 200);
    }
  );

  // -------------------------------------------------------------------------
  // POST /api-keys/:id/rotate/stage - Stage rotate API key (keep old active)
  // -------------------------------------------------------------------------

  routes.post(
    '/api-keys/:id/rotate/stage',
    describeConsoleRoute({
      summary: 'Stage rotate API key',
      responses: {
        200: {
          description: 'Staged API key replacement',
          content: {
            'application/json': {
              schema: resolver(ConsoleApiKeyCreateResponseSchema),
            },
          },
        },
        401: {
          description: 'Unauthenticated',
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
    zValidator('param', apiKeyIdParamSchema),
    async (c) => {
      const { id: keyId } = c.req.valid('param');
      const now = new Date().toISOString();

      const existingRow = await db
        .selectFrom('sync_api_keys')
        .select([
          'name',
          'key_type',
          'scope_keys',
          'actor_id',
          'expires_at',
          'revoked_at',
        ])
        .where('key_id', '=', keyId)
        .where('revoked_at', 'is', null)
        .executeTakeFirst();

      if (!existingRow) {
        return consoleNotFound(c);
      }

      const newKeyId = generateKeyId();
      const keyType = existingRow.key_type as ApiKeyType;
      const secretKey = generateSecretKey(keyType);
      const keyHash = await hashApiKey(secretKey);
      const keyPrefix = secretKey.slice(0, 12);
      const scopeKeys = options.dialect.dbToArray(existingRow.scope_keys);

      await db
        .insertInto('sync_api_keys')
        .values({
          key_id: newKeyId,
          key_hash: keyHash,
          key_prefix: keyPrefix,
          name: existingRow.name,
          key_type: keyType,
          scope_keys: options.dialect.arrayToDb(scopeKeys),
          actor_id: existingRow.actor_id ?? null,
          created_at: now,
          expires_at: existingRow.expires_at,
          last_used_at: null,
          revoked_at: null,
        })
        .execute();

      logSyncEvent({
        event: 'console.stage_rotate_api_key',
        consoleUserId: c.var.consoleAuth.consoleUserId,
        oldKeyId: keyId,
        newKeyId,
      });

      const key: ConsoleApiKey = {
        keyId: newKeyId,
        keyPrefix,
        name: existingRow.name,
        keyType,
        scopeKeys,
        actorId: existingRow.actor_id ?? null,
        createdAt: now,
        expiresAt: existingRow.expires_at ?? null,
        lastUsedAt: null,
        revokedAt: null,
      };

      const response: ConsoleApiKeyCreateResponse = {
        key,
        secretKey,
      };

      return c.json(response, 200);
    }
  );

  // -------------------------------------------------------------------------
  // POST /api-keys/:id/rotate - Rotate API key
  // -------------------------------------------------------------------------

  routes.post(
    '/api-keys/:id/rotate',
    describeConsoleRoute({
      summary: 'Rotate API key',
      responses: {
        200: {
          description: 'Rotated API key',
          content: {
            'application/json': {
              schema: resolver(ConsoleApiKeyCreateResponseSchema),
            },
          },
        },
        401: {
          description: 'Unauthenticated',
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
    zValidator('param', apiKeyIdParamSchema),
    async (c) => {
      const { id: keyId } = c.req.valid('param');
      const now = new Date().toISOString();

      // Get existing key
      const existingRow = await db
        .selectFrom('sync_api_keys')
        .select([
          'key_id',
          'name',
          'key_type',
          'scope_keys',
          'actor_id',
          'expires_at',
        ])
        .where('key_id', '=', keyId)
        .where('revoked_at', 'is', null)
        .executeTakeFirst();

      if (!existingRow) {
        return consoleNotFound(c);
      }

      // Revoke old key
      await db
        .updateTable('sync_api_keys')
        .set({ revoked_at: now })
        .where('key_id', '=', keyId)
        .execute();

      // Create new key with same properties
      const newKeyId = generateKeyId();
      const keyType = existingRow.key_type as ApiKeyType;
      const secretKey = generateSecretKey(keyType);
      const keyHash = await hashApiKey(secretKey);
      const keyPrefix = secretKey.slice(0, 12);

      const scopeKeys = options.dialect.dbToArray(existingRow.scope_keys);

      await db
        .insertInto('sync_api_keys')
        .values({
          key_id: newKeyId,
          key_hash: keyHash,
          key_prefix: keyPrefix,
          name: existingRow.name,
          key_type: keyType,
          scope_keys: options.dialect.arrayToDb(scopeKeys),
          actor_id: existingRow.actor_id ?? null,
          created_at: now,
          expires_at: existingRow.expires_at,
          last_used_at: null,
          revoked_at: null,
        })
        .execute();

      logSyncEvent({
        event: 'console.rotate_api_key',
        consoleUserId: c.var.consoleAuth.consoleUserId,
        oldKeyId: keyId,
        newKeyId,
      });

      const key: ConsoleApiKey = {
        keyId: newKeyId,
        keyPrefix,
        name: existingRow.name,
        keyType,
        scopeKeys,
        actorId: existingRow.actor_id ?? null,
        createdAt: now,
        expiresAt: existingRow.expires_at ?? null,
        lastUsedAt: null,
        revokedAt: null,
      };

      const response: ConsoleApiKeyCreateResponse = {
        key,
        secretKey,
      };

      return c.json(response, 200);
    }
  );

  // -----------------------------------------------------------------------
}
