import {
  extractScopeVars,
  type ScopeValues,
  type SyncSubscriptionRequest,
} from '@syncular/core';
import type { Kysely } from 'kysely';
import {
  getServerHandler,
  type ServerHandlerCollection,
} from '../handlers/collection';
import type { SyncServerAuth } from '../handlers/types';
import type { SyncCoreDb } from '../schema';
import { createDefaultScopeCacheKey, type ScopeCacheBackend } from './cache';

export class InvalidSubscriptionScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSubscriptionScopeError';
  }
}

/**
 * Resolved subscription with effective scopes.
 */
export interface ResolvedSubscription {
  id: string;
  table: string;
  scopes: ScopeValues;
  params: Record<string, unknown> | undefined;
  cursor: number;
  bootstrapState?: SyncSubscriptionRequest['bootstrapState'];
  status: 'active' | 'revoked';
}

/**
 * Intersect requested scopes with allowed scopes.
 *
 * For each key in requested:
 * - If allowed has the same key, intersect the values
 * - If allowed doesn't have the key, exclude it (no access)
 *
 * Returns only keys where there's intersection.
 */
function intersectScopes(
  requested: ScopeValues,
  allowed: ScopeValues
): ScopeValues {
  const result: ScopeValues = {};

  for (const [key, reqValues] of Object.entries(requested)) {
    const allowedValues = allowed[key];
    if (allowedValues === undefined) {
      // No access to this scope key
      continue;
    }

    const reqArray = Array.isArray(reqValues) ? reqValues : [reqValues];
    const allowedArray = Array.isArray(allowedValues)
      ? allowedValues
      : [allowedValues];

    // Wildcard: allowed '*' means "allow any requested values for this key".
    if (allowedArray.includes('*')) {
      result[key] = reqValues;
      continue;
    }
    const allowedSet = new Set(allowedArray);

    // Intersect
    const intersection = reqArray.filter((v) => allowedSet.has(v));

    if (intersection.length > 0) {
      // Keep as array if original was array, otherwise single value
      result[key] =
        intersection.length === 1 && !Array.isArray(reqValues)
          ? intersection[0]!
          : intersection;
    }
  }

  return result;
}

/**
 * Check if scopes are empty (no effective scope values).
 */
function scopesEmpty(scopes: ScopeValues): boolean {
  for (const value of Object.values(scopes)) {
    const arr = Array.isArray(value) ? value : [value];
    if (arr.length > 0) return false;
  }
  return true;
}

/**
 * Collect valid scope keys from handler scope patterns.
 */
function collectScopeKeys(scopePatterns: readonly string[]): Set<string> {
  const keys = new Set<string>();
  for (const pattern of scopePatterns) {
    for (const key of extractScopeVars(pattern)) {
      keys.add(key);
    }
  }
  return keys;
}

function validateScopeKeys(args: {
  scopeValues: ScopeValues;
  validScopeKeys: Set<string>;
  source: string;
  subscriptionId: string;
  table: string;
}): void {
  for (const scopeKey of Object.keys(args.scopeValues)) {
    if (args.validScopeKeys.has(scopeKey)) {
      continue;
    }
    const expectedKeys =
      args.validScopeKeys.size > 0
        ? Array.from(args.validScopeKeys).sort().join(', ')
        : '(none)';
    throw new InvalidSubscriptionScopeError(
      `Invalid scope key "${scopeKey}" in ${args.source} for subscription "${args.subscriptionId}" on table "${args.table}". Expected keys: ${expectedKeys}`
    );
  }
}

/**
 * Resolve effective scopes for subscriptions.
 *
 * For each subscription:
 * 1. Look up the table handler by subscription.table
 * 2. Call handler.resolveScopes() to get allowed scopes for this actor
 * 3. Intersect requested scopes with allowed scopes
 * 4. Mark as revoked if no effective scopes
 */
export async function resolveEffectiveScopesForSubscriptions<
  DB extends SyncCoreDb,
  Auth extends SyncServerAuth,
>(args: {
  db: Kysely<DB>;
  auth: Auth;
  subscriptions: SyncSubscriptionRequest[];
  handlers: ServerHandlerCollection<DB, Auth>;
  scopeCache?: ScopeCacheBackend;
}): Promise<ResolvedSubscription[]> {
  const out: ResolvedSubscription[] = [];
  const seenIds = new Set<string>();
  const requestScopeCache = new Map<string, ScopeValues | null>();

  for (const sub of args.subscriptions) {
    if (!sub.id || typeof sub.id !== 'string') {
      throw new InvalidSubscriptionScopeError('Subscription id is required');
    }
    if (seenIds.has(sub.id)) {
      throw new InvalidSubscriptionScopeError(
        `Duplicate subscription id: ${sub.id}`
      );
    }
    seenIds.add(sub.id);

    if (!sub.table || typeof sub.table !== 'string') {
      throw new InvalidSubscriptionScopeError(
        `Subscription ${sub.id} requires a table name`
      );
    }

    const handler = getServerHandler(args.handlers, sub.table);
    if (!handler) {
      throw new InvalidSubscriptionScopeError(
        `Unknown table: ${sub.table} for subscription ${sub.id}`
      );
    }

    const validScopeKeys = collectScopeKeys(handler.scopePatterns);
    const requested = sub.scopes ?? {};
    validateScopeKeys({
      scopeValues: requested,
      validScopeKeys,
      source: 'requested scopes',
      subscriptionId: sub.id,
      table: sub.table,
    });

    // Resolve allowed scopes with request-local memoization first, then
    // optional shared cache backend, then table handler.
    const scopeCacheKey = createDefaultScopeCacheKey({
      auth: args.auth,
      table: sub.table,
    });
    let allowed: ScopeValues | null;
    if (requestScopeCache.has(scopeCacheKey)) {
      allowed = requestScopeCache.get(scopeCacheKey) ?? null;
    } else {
      allowed = null;
      let sharedCacheHit = false;

      if (args.scopeCache) {
        try {
          const cachedAllowed = await args.scopeCache.get({
            db: args.db,
            auth: args.auth,
            table: sub.table,
            cacheKey: scopeCacheKey,
          });
          if (cachedAllowed !== null) {
            allowed = cachedAllowed;
            sharedCacheHit = true;
          }
        } catch (cacheErr) {
          console.error(
            `[scopeCache.get] Failed for table ${sub.table}, subscription ${sub.id}:`,
            cacheErr
          );
        }
      }

      if (!sharedCacheHit) {
        try {
          allowed = await handler.resolveScopes({
            db: args.db,
            actorId: args.auth.actorId,
            auth: args.auth,
          });
        } catch (resolveErr) {
          // Scope resolution failed - mark subscription as revoked
          // rather than failing the entire pull
          console.error(
            `[resolveScopes] Failed for table ${sub.table}, subscription ${sub.id}:`,
            resolveErr
          );
          requestScopeCache.set(scopeCacheKey, null);
          out.push({
            id: sub.id,
            table: sub.table,
            scopes: {},
            params: sub.params,
            cursor: sub.cursor,
            bootstrapState: sub.bootstrapState ?? null,
            status: 'revoked',
          });
          continue;
        }

        if (args.scopeCache && allowed !== null) {
          try {
            await args.scopeCache.set({
              db: args.db,
              auth: args.auth,
              table: sub.table,
              cacheKey: scopeCacheKey,
              scopes: allowed,
            });
          } catch (cacheErr) {
            console.error(
              `[scopeCache.set] Failed for table ${sub.table}, subscription ${sub.id}:`,
              cacheErr
            );
          }
        }
      }

      requestScopeCache.set(scopeCacheKey, allowed);
    }

    if (!allowed) {
      out.push({
        id: sub.id,
        table: sub.table,
        scopes: {},
        params: sub.params,
        cursor: sub.cursor,
        bootstrapState: sub.bootstrapState ?? null,
        status: 'revoked',
      });
      continue;
    }

    validateScopeKeys({
      scopeValues: allowed,
      validScopeKeys,
      source: 'resolveScopes() result',
      subscriptionId: sub.id,
      table: sub.table,
    });

    // Intersect with requested scopes
    const effective = intersectScopes(requested, allowed);

    if (scopesEmpty(effective)) {
      out.push({
        id: sub.id,
        table: sub.table,
        scopes: {},
        params: sub.params,
        cursor: sub.cursor,
        bootstrapState: sub.bootstrapState ?? null,
        status: 'revoked',
      });
      continue;
    }

    out.push({
      id: sub.id,
      table: sub.table,
      scopes: effective,
      params: sub.params,
      cursor: sub.cursor,
      bootstrapState: sub.bootstrapState ?? null,
      status: 'active',
    });
  }

  return out;
}
