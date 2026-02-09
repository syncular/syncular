/**
 * @syncular/server-hono - API Key Authentication Helper
 *
 * Provides utilities for validating API keys in relay/proxy routes.
 */

import type { ServerSyncDialect } from '@syncular/server';
import type { Context } from 'hono';
import { type Kysely, sql } from 'kysely';
import { type ApiKeyType, ApiKeyTypeSchema } from './console/schemas';

interface SyncApiKeysTable {
  key_id: string;
  key_hash: string;
  key_prefix: string;
  name: string;
  key_type: string;
  scope_keys: unknown | null;
  actor_id: string | null;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
}

type ApiKeyDb = {
  sync_api_keys: SyncApiKeysTable;
};

interface ValidateApiKeyResult {
  keyId: string;
  keyType: ApiKeyType;
  actorId: string | null;
  scopeKeys: string[];
}

/**
 * Validates an API key from Authorization header.
 * Updates last_used_at on successful validation.
 */
export async function validateApiKey<DB extends ApiKeyDb>(
  db: Kysely<DB>,
  dialect: ServerSyncDialect,
  authHeader: string | undefined
): Promise<ValidateApiKeyResult | null> {
  if (!authHeader?.startsWith('Bearer ')) {
    return null;
  }

  const secretKey = authHeader.slice(7);
  if (!secretKey || !secretKey.startsWith('sk_')) {
    return null;
  }

  // Hash the provided key
  const keyHash = await hashApiKey(secretKey);

  // Look up key by hash
  const rowResult = await sql<{
    key_id: string;
    key_type: string;
    actor_id: string | null;
    scope_keys: unknown | null;
    expires_at: string | null;
    revoked_at: string | null;
  }>`
    select key_id, key_type, actor_id, scope_keys, expires_at, revoked_at
    from ${sql.table('sync_api_keys')}
    where key_hash = ${keyHash}
    limit 1
  `.execute(db);
  const row = rowResult.rows[0];

  if (!row) {
    return null;
  }

  const parsedKeyType = ApiKeyTypeSchema.safeParse(row.key_type);
  if (!parsedKeyType.success) return null;

  // Check if revoked
  if (row.revoked_at) {
    return null;
  }

  // Check if expired
  if (row.expires_at) {
    const expiresAt = new Date(row.expires_at);
    if (expiresAt < new Date()) {
      return null;
    }
  }

  // Update last_used_at
  const now = new Date().toISOString();
  await sql`
    update ${sql.table('sync_api_keys')}
    set last_used_at = ${now}
    where key_id = ${row.key_id}
  `.execute(db);

  // Parse scopes
  const scopeKeys = dialect.dbToArray(row.scope_keys);

  return {
    keyId: row.key_id,
    keyType: parsedKeyType.data,
    actorId: row.actor_id,
    scopeKeys,
  };
}

/**
 * Creates an authenticator for relay/proxy routes.
 * Returns actorId from the API key if valid and allowed.
 */
export function createApiKeyAuthenticator<DB extends ApiKeyDb>(
  db: Kysely<DB>,
  dialect: ServerSyncDialect,
  allowedTypes: ApiKeyType[]
): (c: Context) => Promise<{ actorId: string } | null> {
  return async (c: Context) => {
    const authHeader = c.req.header('Authorization');
    const result = await validateApiKey(db, dialect, authHeader);

    if (!result) {
      return null;
    }

    // Check if key type is allowed
    if (!allowedTypes.includes(result.keyType)) {
      return null;
    }

    // Return actorId (use key's actorId if set, otherwise use a default)
    return {
      actorId: result.actorId ?? `api-key:${result.keyId}`,
    };
  };
}

/**
 * Middleware that validates API key and attaches result to context.
 */
export function apiKeyAuthMiddleware<DB extends ApiKeyDb>(
  db: Kysely<DB>,
  dialect: ServerSyncDialect,
  allowedTypes: ApiKeyType[]
) {
  return async (
    c: Context,
    next: () => Promise<void>
  ): Promise<Response | undefined> => {
    const authHeader = c.req.header('Authorization');
    const result = await validateApiKey(db, dialect, authHeader);

    if (!result) {
      return c.json({ error: 'UNAUTHENTICATED' }, 401);
    }

    if (!allowedTypes.includes(result.keyType)) {
      return c.json({ error: 'FORBIDDEN', message: 'Invalid key type' }, 403);
    }

    // Attach to context for downstream handlers
    c.set('apiKey', result);

    await next();
  };
}

// Hash function (same as in routes.ts)
async function hashApiKey(secretKey: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(secretKey);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray, (b) => b.toString(16).padStart(2, '0')).join('');
}
