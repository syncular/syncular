import type { ScopeValues } from '@syncular/core';
import { type Kysely, sql } from 'kysely';
import type { SyncServerAuth } from '../handlers/types';
import type { SyncCoreDb } from '../schema';

const DEFAULT_SCOPE_CACHE_PARTITION_ID = 'default';
const DEFAULT_MEMORY_SCOPE_CACHE_TTL_MS = 30_000;
const DEFAULT_MEMORY_SCOPE_CACHE_MAX_ENTRIES = 5_000;
const DEFAULT_DATABASE_SCOPE_CACHE_TTL_MS = 60_000;
const DEFAULT_DATABASE_SCOPE_CACHE_TABLE = 'sync_scope_cache';

export interface ScopeCacheContext<
  DB extends SyncCoreDb = SyncCoreDb,
  Auth extends SyncServerAuth = SyncServerAuth,
> {
  db: Kysely<DB>;
  auth: Auth;
  table: string;
  cacheKey: string;
}

export interface ScopeCacheSetContext<
  DB extends SyncCoreDb = SyncCoreDb,
  Auth extends SyncServerAuth = SyncServerAuth,
> extends ScopeCacheContext<DB, Auth> {
  scopes: ScopeValues;
}

/**
 * Shared cache contract for scope resolution results.
 *
 * Pull requests always apply request-local memoization first.
 * This cache is used to share results across pulls.
 */
export interface ScopeCacheBackend {
  name: string;
  get<DB extends SyncCoreDb, Auth extends SyncServerAuth>(
    args: ScopeCacheContext<DB, Auth>
  ): Promise<ScopeValues | null>;
  set<DB extends SyncCoreDb, Auth extends SyncServerAuth>(
    args: ScopeCacheSetContext<DB, Auth>
  ): Promise<void>;
  delete?<DB extends SyncCoreDb, Auth extends SyncServerAuth>(
    args: ScopeCacheContext<DB, Auth>
  ): Promise<void>;
}

export function createDefaultScopeCacheKey(args: {
  table: string;
  auth: SyncServerAuth;
}): string {
  const partitionId = args.auth.partitionId ?? DEFAULT_SCOPE_CACHE_PARTITION_ID;
  return `${partitionId}\u0000${args.auth.actorId}\u0000${args.table}`;
}

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

function parseScopeValues(value: string): ScopeValues | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }

  const out: ScopeValues = {};
  for (const [scopeKey, scopeValue] of Object.entries(parsed)) {
    if (typeof scopeValue === 'string') {
      out[scopeKey] = scopeValue;
      continue;
    }

    if (
      Array.isArray(scopeValue) &&
      scopeValue.every((item) => typeof item === 'string')
    ) {
      out[scopeKey] = [...scopeValue];
      continue;
    }

    return null;
  }

  return out;
}

interface MemoryScopeCacheEntry {
  scopes: ScopeValues;
  expiresAt: number;
}

export interface MemoryScopeCacheOptions {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

export function createMemoryScopeCache(
  options?: MemoryScopeCacheOptions
): ScopeCacheBackend {
  const ttlMs = options?.ttlMs ?? DEFAULT_MEMORY_SCOPE_CACHE_TTL_MS;
  const maxEntries =
    options?.maxEntries ?? DEFAULT_MEMORY_SCOPE_CACHE_MAX_ENTRIES;
  const now = options?.now ?? Date.now;
  const buckets = new WeakMap<object, Map<string, MemoryScopeCacheEntry>>();

  function getBucket(db: object): Map<string, MemoryScopeCacheEntry> {
    const existing = buckets.get(db);
    if (existing) {
      return existing;
    }
    const created = new Map<string, MemoryScopeCacheEntry>();
    buckets.set(db, created);
    return created;
  }

  function evictOldest(bucket: Map<string, MemoryScopeCacheEntry>): void {
    while (bucket.size > maxEntries) {
      const oldestKey = bucket.keys().next().value;
      if (!oldestKey) {
        return;
      }
      bucket.delete(oldestKey);
    }
  }

  return {
    name: 'memory',
    async get(args) {
      const bucket = getBucket(args.db);
      const entry = bucket.get(args.cacheKey);
      if (!entry) {
        return null;
      }

      const nowMs = now();
      if (entry.expiresAt <= nowMs) {
        bucket.delete(args.cacheKey);
        return null;
      }

      return cloneScopeValues(entry.scopes);
    },
    async set(args) {
      const bucket = getBucket(args.db);
      if (ttlMs <= 0) {
        bucket.delete(args.cacheKey);
        return;
      }

      if (bucket.has(args.cacheKey)) {
        bucket.delete(args.cacheKey);
      }
      bucket.set(args.cacheKey, {
        scopes: cloneScopeValues(args.scopes),
        expiresAt: now() + ttlMs,
      });
      evictOldest(bucket);
    },
    async delete(args) {
      const bucket = getBucket(args.db);
      bucket.delete(args.cacheKey);
    },
  };
}

export interface DatabaseScopeCacheOptions {
  /**
   * Scope cache table name.
   * Default: `sync_scope_cache`
   */
  tableName?: string;
  /**
   * TTL for cache entries (milliseconds).
   * Default: 60000
   */
  ttlMs?: number;
  /**
   * Automatically creates the cache table.
   * Default: true
   */
  autoCreateTable?: boolean;
  now?: () => Date;
}

export function createDatabaseScopeCache(
  options?: DatabaseScopeCacheOptions
): ScopeCacheBackend {
  const tableName = options?.tableName ?? DEFAULT_DATABASE_SCOPE_CACHE_TABLE;
  const ttlMs = options?.ttlMs ?? DEFAULT_DATABASE_SCOPE_CACHE_TTL_MS;
  const autoCreateTable = options?.autoCreateTable ?? true;
  const now = options?.now ?? (() => new Date());
  const schemaReady = new WeakMap<object, Promise<void>>();

  async function ensureTable<DB extends SyncCoreDb>(db: Kysely<DB>) {
    if (!autoCreateTable) {
      return;
    }

    const existing = schemaReady.get(db);
    if (existing) {
      await existing;
      return;
    }

    const pending = sql`
      CREATE TABLE IF NOT EXISTS ${sql.table(tableName)} (
        cache_key TEXT PRIMARY KEY,
        scope_values TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `
      .execute(db)
      .then(() => undefined);
    schemaReady.set(db, pending);

    try {
      await pending;
    } catch (error) {
      schemaReady.delete(db);
      throw error;
    }
  }

  async function removeCacheRow<DB extends SyncCoreDb>(args: {
    db: Kysely<DB>;
    cacheKey: string;
  }): Promise<void> {
    await sql`
      DELETE FROM ${sql.table(tableName)}
      WHERE cache_key = ${args.cacheKey}
    `.execute(args.db);
  }

  return {
    name: 'database',
    async get(args) {
      await ensureTable(args.db);

      const rows = await sql<{
        scope_values: string;
        expires_at: string;
      }>`
        SELECT scope_values, expires_at
        FROM ${sql.table(tableName)}
        WHERE cache_key = ${args.cacheKey}
        LIMIT 1
      `.execute(args.db);

      const row = rows.rows[0];
      if (!row) {
        return null;
      }

      const nowIso = now().toISOString();
      if (row.expires_at <= nowIso) {
        await removeCacheRow({ db: args.db, cacheKey: args.cacheKey });
        return null;
      }

      const parsed = parseScopeValues(row.scope_values);
      if (!parsed) {
        await removeCacheRow({ db: args.db, cacheKey: args.cacheKey });
        return null;
      }

      return parsed;
    },
    async set(args) {
      await ensureTable(args.db);

      if (ttlMs <= 0) {
        await removeCacheRow({ db: args.db, cacheKey: args.cacheKey });
        return;
      }

      const createdAt = now();
      const expiresAt = new Date(createdAt.getTime() + ttlMs);
      await sql`
        INSERT INTO ${sql.table(tableName)} (
          cache_key,
          scope_values,
          expires_at,
          created_at
        )
        VALUES (
          ${args.cacheKey},
          ${JSON.stringify(cloneScopeValues(args.scopes))},
          ${expiresAt.toISOString()},
          ${createdAt.toISOString()}
        )
        ON CONFLICT (cache_key) DO UPDATE SET
          scope_values = EXCLUDED.scope_values,
          expires_at = EXCLUDED.expires_at,
          created_at = EXCLUDED.created_at
      `.execute(args.db);
    },
    async delete(args) {
      await ensureTable(args.db);
      await removeCacheRow({ db: args.db, cacheKey: args.cacheKey });
    },
  };
}
