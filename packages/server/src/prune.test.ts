import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createDatabase } from '@syncular/core';
import { createBunSqliteDialect } from '../../dialect-bun-sqlite/src';
import { createSqliteServerDialect } from '../../server-dialect-sqlite/src';
import { ensureSyncSchema } from './migrate';
import { maybePruneSync } from './prune';
import type { SyncCoreDb } from './schema';

interface TestDb extends SyncCoreDb {}

const dialect = createSqliteServerDialect();

describe('maybePruneSync', () => {
  let db: ReturnType<typeof createDatabase<TestDb>>;

  beforeEach(async () => {
    db = createDatabase<TestDb>({
      dialect: createBunSqliteDialect({ path: ':memory:' }),
      family: 'sqlite',
    });
    await ensureSyncSchema(db, dialect);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('prunes partitions independently', async () => {
    for (let i = 1; i <= 3; i += 1) {
      await db
        .insertInto('sync_commits')
        .values({
          partition_id: 'default',
          actor_id: 'u1',
          client_id: 'default-client',
          client_commit_id: `default-${i}`,
        })
        .execute();
      await db
        .insertInto('sync_commits')
        .values({
          partition_id: 'tenant-b',
          actor_id: 'u2',
          client_id: 'tenant-b-client',
          client_commit_id: `tenant-b-${i}`,
        })
        .execute();
    }

    const nowIso = new Date().toISOString();
    await db
      .insertInto('sync_client_cursors')
      .values([
        {
          partition_id: 'default',
          client_id: 'default-client',
          actor_id: 'u1',
          cursor: 3,
          effective_scopes: '{}',
          updated_at: nowIso,
        },
        {
          partition_id: 'tenant-b',
          client_id: 'tenant-b-client',
          actor_id: 'u2',
          cursor: 0,
          effective_scopes: '{}',
          updated_at: nowIso,
        },
      ])
      .execute();

    const deleted = await maybePruneSync(db, {
      minIntervalMs: 0,
      options: {
        activeWindowMs: 60_000,
        fallbackMaxAgeMs: 0,
        keepNewestCommits: 1,
      },
    });

    expect(deleted).toBe(2);

    const remainingDefault = await db
      .selectFrom('sync_commits')
      .select(({ fn }) => fn.countAll().as('count'))
      .where('partition_id', '=', 'default')
      .executeTakeFirstOrThrow();
    const remainingTenantB = await db
      .selectFrom('sync_commits')
      .select(({ fn }) => fn.countAll().as('count'))
      .where('partition_id', '=', 'tenant-b')
      .executeTakeFirstOrThrow();

    expect(Number(remainingDefault.count)).toBe(1);
    expect(Number(remainingTenantB.count)).toBe(3);
  });
});
