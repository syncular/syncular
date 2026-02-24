import { beforeEach, describe, expect, it } from 'bun:test';
import { createDatabase } from '@syncular/core';
import { ensureClientSyncSchema, type SyncClientDb } from '@syncular/client';
import { createBunSqliteDialect } from '@syncular/dialect-bun-sqlite';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';

interface TestDb extends SyncClientDb {}

describe('ensureClientSyncSchema compatibility upgrades', () => {
  let db: Kysely<TestDb>;

  beforeEach(() => {
    db = createDatabase<TestDb>({ dialect: createBunSqliteDialect({ path: ':memory:' }), family: 'sqlite' });
  });

  it('upgrades legacy internal sync tables without app-level shims', async () => {
    await sql`
      create table sync_subscription_state (
        state_id text not null,
        subscription_id text not null,
        shape text not null,
        scopes_json text not null default '{}',
        params_json text not null,
        cursor bigint not null,
        status text not null,
        created_at bigint not null,
        updated_at bigint not null
      )
    `.execute(db);

    await sql`
      insert into sync_subscription_state (
        state_id, subscription_id, shape, scopes_json, params_json,
        cursor, status, created_at, updated_at
      ) values ('default', 'sub-1', 'tasks', '{}', '{}', 1, 'active', 1, 1)
    `.execute(db);

    await sql`
      create table sync_outbox_commits (
        id text primary key,
        client_commit_id text not null,
        status text not null,
        operations_json text not null,
        last_response_json text,
        error text,
        created_at bigint not null,
        updated_at bigint not null,
        attempt_count integer not null default 0,
        acked_commit_seq bigint
      )
    `.execute(db);

    await sql`
      insert into sync_outbox_commits (
        id, client_commit_id, status, operations_json, created_at, updated_at
      ) values ('c1', 'commit-1', 'pending', '[]', 1, 1)
    `.execute(db);

    await sql`
      create table sync_conflicts (
        id text primary key,
        outbox_commit_id text not null,
        client_commit_id text not null,
        op_index integer not null,
        result_status text not null,
        message text not null,
        code text,
        server_version bigint,
        server_row_json text,
        created_at bigint not null
      )
    `.execute(db);

    await sql`
      insert into sync_conflicts (
        id, outbox_commit_id, client_commit_id, op_index, result_status,
        message, code, server_version, server_row_json, created_at
      ) values ('x1', 'c1', 'commit-1', 0, 'conflict', 'conflict', null, null, null, 1)
    `.execute(db);

    await ensureClientSyncSchema(db);

    const subscription = await db
      .selectFrom('sync_subscription_state')
      .select(['table', 'bootstrap_state_json'])
      .where('subscription_id', '=', 'sub-1')
      .executeTakeFirstOrThrow();
    expect(subscription.table).toBe('tasks');
    expect(subscription.bootstrap_state_json).toBeNull();

    const outbox = await db
      .selectFrom('sync_outbox_commits')
      .select(['schema_version'])
      .where('id', '=', 'c1')
      .executeTakeFirstOrThrow();
    expect(outbox.schema_version).toBe(1);

    const conflict = await db
      .selectFrom('sync_conflicts')
      .select(['resolved_at', 'resolution'])
      .where('id', '=', 'x1')
      .executeTakeFirstOrThrow();
    expect(conflict.resolved_at).toBeNull();
    expect(conflict.resolution).toBeNull();
  });

  it('is idempotent on current schema', async () => {
    await ensureClientSyncSchema(db);
    await ensureClientSyncSchema(db);

    await db
      .insertInto('sync_subscription_state')
      .values({
        state_id: 'default',
        subscription_id: 'sub-2',
        table: 'tasks',
        scopes_json: '{}',
        params_json: '{}',
        cursor: 0,
        bootstrap_state_json: null,
        status: 'active',
        created_at: 1,
        updated_at: 1,
      })
      .execute();

    const row = await db
      .selectFrom('sync_subscription_state')
      .select(['subscription_id'])
      .where('subscription_id', '=', 'sub-2')
      .executeTakeFirstOrThrow();
    expect(row.subscription_id).toBe('sub-2');
  });
});
