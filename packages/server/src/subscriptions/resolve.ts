import type { ScopeValues, SyncSubscriptionRequest } from '@syncular/core';
import type { Kysely } from 'kysely';
import type { SyncCoreDb } from '../schema';
import type { TableRegistry } from '../shapes/registry';

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
  shape: string;
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
 * Resolve effective scopes for subscriptions.
 *
 * For each subscription:
 * 1. Look up the shape by subscription.shape
 * 2. Call shape.resolveScopes() to get allowed scopes for this actor
 * 3. Intersect requested scopes with allowed scopes
 * 4. Mark as revoked if no effective scopes
 */
export async function resolveEffectiveScopesForSubscriptions<
  DB extends SyncCoreDb,
>(args: {
  db: Kysely<DB>;
  actorId: string;
  subscriptions: SyncSubscriptionRequest[];
  shapes: TableRegistry<DB>;
}): Promise<ResolvedSubscription[]> {
  const out: ResolvedSubscription[] = [];
  const seenIds = new Set<string>();

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

    if (!sub.shape || typeof sub.shape !== 'string') {
      throw new InvalidSubscriptionScopeError(
        `Subscription ${sub.id} requires a shape (table name)`
      );
    }

    const shape = args.shapes.get(sub.shape);
    if (!shape) {
      throw new InvalidSubscriptionScopeError(
        `Unknown shape: ${sub.shape} for subscription ${sub.id}`
      );
    }

    // Get allowed scopes from the shape
    let allowed: ScopeValues;
    try {
      allowed = await shape.resolveScopes({
        db: args.db,
        actorId: args.actorId,
      });
    } catch (resolveErr) {
      // Scope resolution failed - mark subscription as revoked
      // rather than failing the entire pull
      console.error(
        `[resolveScopes] Failed for shape ${sub.shape}, subscription ${sub.id}:`,
        resolveErr
      );
      out.push({
        id: sub.id,
        shape: sub.shape,
        scopes: {},
        params: sub.params,
        cursor: sub.cursor,
        bootstrapState: sub.bootstrapState ?? null,
        status: 'revoked',
      });
      continue;
    }

    // Intersect with requested scopes
    const requested = sub.scopes ?? {};
    const effective = intersectScopes(requested, allowed);

    if (scopesEmpty(effective)) {
      out.push({
        id: sub.id,
        shape: sub.shape,
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
      shape: sub.shape,
      scopes: effective,
      params: sub.params,
      cursor: sub.cursor,
      bootstrapState: sub.bootstrapState ?? null,
      status: 'active',
    });
  }

  return out;
}
