import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createDatabase } from '@syncular/core';
import type { Kysely } from 'kysely';
import { createBunSqliteDialect } from '../../../dialect-bun-sqlite/src';
import {
  createServerHandler,
  createServerHandlerCollection,
} from '../handlers';
import type { SyncCoreDb } from '../schema';
import { createDatabaseScopeCache, createDefaultScopeCacheKey } from './cache';
import { resolveEffectiveScopesForSubscriptions } from './resolve';

interface TasksTable {
  id: string;
  user_id: string;
  server_version: number;
}

interface TestDb extends SyncCoreDb {
  tasks: TasksTable;
}

interface ClientDb {
  tasks: TasksTable;
}

describe('resolveEffectiveScopesForSubscriptions cache behavior', () => {
  let db: Kysely<TestDb>;

  beforeEach(() => {
    db = createDatabase<TestDb>({
      dialect: createBunSqliteDialect({ path: ':memory:' }),
      family: 'sqlite',
    });
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('memoizes resolveScopes calls inside a single request', async () => {
    let resolveCalls = 0;
    const handler = createServerHandler<TestDb, ClientDb, 'tasks'>({
      table: 'tasks',
      scopes: ['user:{user_id}'],
      resolveScopes: async (ctx) => {
        resolveCalls += 1;
        return { user_id: [ctx.actorId] };
      },
    });
    const handlers = createServerHandlerCollection<TestDb>([handler]);

    const resolved = await resolveEffectiveScopesForSubscriptions({
      db,
      auth: { actorId: 'u1' },
      handlers,
      subscriptions: [
        { id: 'sub-1', table: 'tasks', scopes: { user_id: 'u1' }, cursor: -1 },
        { id: 'sub-2', table: 'tasks', scopes: { user_id: 'u1' }, cursor: -1 },
      ],
    });

    expect(resolveCalls).toBe(1);
    expect(resolved).toHaveLength(2);
    expect(resolved.every((entry) => entry.status === 'active')).toBe(true);
  });

  it('uses shared cache hit and skips resolveScopes', async () => {
    let resolveCalls = 0;
    let cacheGetCalls = 0;
    let cacheSetCalls = 0;
    const handler = createServerHandler<TestDb, ClientDb, 'tasks'>({
      table: 'tasks',
      scopes: ['user:{user_id}'],
      resolveScopes: async (ctx) => {
        resolveCalls += 1;
        return { user_id: [ctx.actorId] };
      },
    });
    const handlers = createServerHandlerCollection<TestDb>([handler]);

    const resolved = await resolveEffectiveScopesForSubscriptions({
      db,
      auth: { actorId: 'u1' },
      handlers,
      scopeCache: {
        name: 'test-cache',
        async get() {
          cacheGetCalls += 1;
          return { user_id: ['u1'] };
        },
        async set() {
          cacheSetCalls += 1;
        },
      },
      subscriptions: [
        { id: 'sub-1', table: 'tasks', scopes: { user_id: 'u1' }, cursor: -1 },
      ],
    });

    expect(resolveCalls).toBe(0);
    expect(cacheGetCalls).toBe(1);
    expect(cacheSetCalls).toBe(0);
    expect(resolved[0]?.status).toBe('active');
  });

  it('uses request-local memoization even with shared cache misses', async () => {
    let resolveCalls = 0;
    let cacheGetCalls = 0;
    let cacheSetCalls = 0;
    const handler = createServerHandler<TestDb, ClientDb, 'tasks'>({
      table: 'tasks',
      scopes: ['user:{user_id}'],
      resolveScopes: async (ctx) => {
        resolveCalls += 1;
        return { user_id: [ctx.actorId] };
      },
    });
    const handlers = createServerHandlerCollection<TestDb>([handler]);

    const resolved = await resolveEffectiveScopesForSubscriptions({
      db,
      auth: { actorId: 'u1' },
      handlers,
      scopeCache: {
        name: 'test-cache',
        async get() {
          cacheGetCalls += 1;
          return null;
        },
        async set() {
          cacheSetCalls += 1;
        },
      },
      subscriptions: [
        { id: 'sub-1', table: 'tasks', scopes: { user_id: 'u1' }, cursor: -1 },
        { id: 'sub-2', table: 'tasks', scopes: { user_id: 'u1' }, cursor: -1 },
      ],
    });

    expect(resolveCalls).toBe(1);
    expect(cacheGetCalls).toBe(1);
    expect(cacheSetCalls).toBe(1);
    expect(resolved).toHaveLength(2);
    expect(resolved.every((entry) => entry.status === 'active')).toBe(true);
  });

  it('roundtrips values through database scope cache', async () => {
    const scopeCache = createDatabaseScopeCache();
    const auth = { actorId: 'u1', partitionId: 'tenant-1' };
    const cacheKey = createDefaultScopeCacheKey({ auth, table: 'tasks' });
    const context = { db, auth, table: 'tasks', cacheKey };
    const scopes = { user_id: ['u1', 'u2'] };

    await scopeCache.set({ ...context, scopes });
    const cachedScopes = await scopeCache.get(context);

    expect(cachedScopes).toEqual(scopes);
  });

  it('expires entries in database scope cache', async () => {
    let nowMs = Date.now();
    const scopeCache = createDatabaseScopeCache({
      ttlMs: 25,
      now: () => new Date(nowMs),
    });
    const auth = { actorId: 'u1', partitionId: 'tenant-1' };
    const cacheKey = createDefaultScopeCacheKey({ auth, table: 'tasks' });
    const context = { db, auth, table: 'tasks', cacheKey };

    await scopeCache.set({
      ...context,
      scopes: { user_id: ['u1'] },
    });

    nowMs += 26;
    const cachedScopes = await scopeCache.get(context);
    expect(cachedScopes).toBeNull();
  });
});
