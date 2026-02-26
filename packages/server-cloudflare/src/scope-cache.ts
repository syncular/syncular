/**
 * Durable Object-backed scope cache for @syncular/server.
 *
 * This module provides two parts:
 * 1) `createDurableObjectScopeCache()` - cache backend to pass to createSyncServer/createSyncRoutes
 * 2) `ScopeCacheDurableObject` - Durable Object class that stores scope entries in DO storage
 */

type ScopeValues = Record<string, string | string[]>;

interface ScopeCacheContext {
  db: object;
  auth: {
    actorId: string;
    partitionId?: string;
  };
  table: string;
  cacheKey: string;
}

interface ScopeCacheSetContext extends ScopeCacheContext {
  scopes: ScopeValues;
}

interface ScopeCacheBackend {
  name: string;
  get(args: ScopeCacheContext): Promise<ScopeValues | null>;
  set(args: ScopeCacheSetContext): Promise<void>;
  delete?(args: ScopeCacheContext): Promise<void>;
}

const DEFAULT_SCOPE_CACHE_TTL_MS = 60_000;
const DEFAULT_SCOPE_CACHE_DO_NAME = 'syncular-scope-cache';
const DEFAULT_SCOPE_CACHE_PATH = '/scope-cache';
const JSON_HEADERS = { 'content-type': 'application/json' };

interface ScopeCacheLookup {
  cacheKey: string;
  partitionId: string;
  actorId: string;
  table: string;
}

type ScopeCacheRequestBody =
  | {
      action: 'get';
      cacheKey: string;
    }
  | {
      action: 'set';
      cacheKey: string;
      scopes: ScopeValues;
      ttlMs: number;
    }
  | {
      action: 'delete';
      cacheKey: string;
    };

function cloneScopeValues(scopes: ScopeValues): ScopeValues {
  const cloned: ScopeValues = {};
  for (const [key, value] of Object.entries(scopes)) {
    if (typeof value === 'string') {
      cloned[key] = value;
      continue;
    }
    cloned[key] = [...value];
  }
  return cloned;
}

function isScopeValues(value: unknown): value is ScopeValues {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  for (const scopeValue of Object.values(value)) {
    if (typeof scopeValue === 'string') {
      continue;
    }
    if (
      Array.isArray(scopeValue) &&
      scopeValue.every((entry) => typeof entry === 'string')
    ) {
      continue;
    }
    return false;
  }
  return true;
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(parsed)) {
    out[key] = entry;
  }
  return out;
}

async function parseRequestBody(
  request: Request
): Promise<ScopeCacheRequestBody | null> {
  let body: string;
  try {
    body = await request.text();
  } catch {
    return null;
  }

  const parsed = parseJsonObject(body);
  if (!parsed) {
    return null;
  }

  const action = parsed.action;
  const cacheKey = parsed.cacheKey;
  if (typeof action !== 'string' || typeof cacheKey !== 'string') {
    return null;
  }

  if (action === 'get') {
    return { action: 'get', cacheKey };
  }

  if (action === 'delete') {
    return { action: 'delete', cacheKey };
  }

  if (action === 'set') {
    const ttlMs = parsed.ttlMs;
    const scopes = parsed.scopes;
    if (
      typeof ttlMs !== 'number' ||
      Number.isNaN(ttlMs) ||
      !Number.isFinite(ttlMs)
    ) {
      return null;
    }
    if (!isScopeValues(scopes)) {
      return null;
    }
    return {
      action: 'set',
      cacheKey,
      scopes: cloneScopeValues(scopes),
      ttlMs,
    };
  }

  return null;
}

interface StoredScopeCacheValue {
  scopes: ScopeValues;
  expiresAt: number;
}

/**
 * Durable Object for scope cache entries.
 *
 * Bind this class in your Worker as a separate DO namespace.
 */
export class ScopeCacheDurableObject {
  private readonly state: DurableObjectState;

  constructor(state: DurableObjectState, _env: object) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    const payload = await parseRequestBody(request);
    if (!payload) {
      return new Response('Invalid scope cache request', { status: 400 });
    }

    if (payload.action === 'get') {
      const entry = await this.state.storage.get<StoredScopeCacheValue>(
        payload.cacheKey
      );
      if (!entry) {
        return Response.json({ scopes: null });
      }

      if (entry.expiresAt <= Date.now()) {
        await this.state.storage.delete(payload.cacheKey);
        return Response.json({ scopes: null });
      }

      return Response.json({ scopes: cloneScopeValues(entry.scopes) });
    }

    if (payload.action === 'set') {
      if (payload.ttlMs <= 0) {
        await this.state.storage.delete(payload.cacheKey);
        return Response.json({ ok: true });
      }

      await this.state.storage.put(payload.cacheKey, {
        scopes: cloneScopeValues(payload.scopes),
        expiresAt: Date.now() + payload.ttlMs,
      } satisfies StoredScopeCacheValue);

      return Response.json({ ok: true });
    }

    await this.state.storage.delete(payload.cacheKey);
    return Response.json({ ok: true });
  }
}

export interface DurableObjectScopeCacheOptions {
  namespace: DurableObjectNamespace;
  ttlMs?: number;
  path?: string;
  getStubId?: (
    namespace: DurableObjectNamespace,
    lookup: ScopeCacheLookup
  ) => DurableObjectId;
}

/**
 * Create a scope cache backend that reads/writes through a Durable Object.
 */
export function createDurableObjectScopeCache(
  options: DurableObjectScopeCacheOptions
): ScopeCacheBackend {
  const ttlMs = options.ttlMs ?? DEFAULT_SCOPE_CACHE_TTL_MS;
  const path = options.path ?? DEFAULT_SCOPE_CACHE_PATH;
  const getStubId =
    options.getStubId ??
    ((namespace: DurableObjectNamespace) =>
      namespace.idFromName(DEFAULT_SCOPE_CACHE_DO_NAME));

  async function callDurableObject(
    lookup: ScopeCacheLookup,
    body: ScopeCacheRequestBody
  ): Promise<Record<string, unknown>> {
    const id = getStubId(options.namespace, lookup);
    const stub = options.namespace.get(id);
    const response = await stub.fetch(`https://scope-cache${path}`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(
        `Scope cache durable object request failed: ${response.status}`
      );
    }

    const parsed = parseJsonObject(await response.text());
    if (!parsed) {
      throw new Error('Scope cache durable object response was not JSON');
    }

    return parsed;
  }

  return {
    name: 'durable-object',
    async get(args) {
      const lookup: ScopeCacheLookup = {
        cacheKey: args.cacheKey,
        partitionId: args.auth.partitionId ?? 'default',
        actorId: args.auth.actorId,
        table: args.table,
      };

      const response = await callDurableObject(lookup, {
        action: 'get',
        cacheKey: args.cacheKey,
      });
      const scopes = response.scopes;
      if (scopes === null || scopes === undefined) {
        return null;
      }

      if (!isScopeValues(scopes)) {
        return null;
      }

      return cloneScopeValues(scopes);
    },
    async set(args) {
      const lookup: ScopeCacheLookup = {
        cacheKey: args.cacheKey,
        partitionId: args.auth.partitionId ?? 'default',
        actorId: args.auth.actorId,
        table: args.table,
      };

      await callDurableObject(lookup, {
        action: 'set',
        cacheKey: args.cacheKey,
        scopes: cloneScopeValues(args.scopes),
        ttlMs,
      });
    },
    async delete(args) {
      const lookup: ScopeCacheLookup = {
        cacheKey: args.cacheKey,
        partitionId: args.auth.partitionId ?? 'default',
        actorId: args.auth.actorId,
        table: args.table,
      };

      await callDurableObject(lookup, {
        action: 'delete',
        cacheKey: args.cacheKey,
      });
    },
  };
}
