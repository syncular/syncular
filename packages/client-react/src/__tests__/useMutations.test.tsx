/**
 * Tests for useMutations hook
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import type { SyncClientDb } from '@syncular/client';
import { act, renderHook } from '@testing-library/react';
import type { Kysely } from 'kysely';
import type { ReactNode } from 'react';
import { createSyncularReact } from '../index';
import {
  createMockDb,
  createMockHandlerRegistry,
  createMockSync,
  createMockTransport,
} from './test-utils';

// DB schema for tests
// server_version has a DB default so it's optional for inserts but present on selects
interface TestDbTasks {
  id: string;
  title: string;
  completed: number;
  user_id: string;
  server_version?: number;
}

// TestDb includes app tables + sync tables (created by createMockDb)
interface TestDb extends SyncClientDb {
  tasks: TestDbTasks;
}

const { SyncProvider, useEngine, useMutations } = createSyncularReact<TestDb>();

describe('useMutations', () => {
  let db: Kysely<TestDb>;

  beforeEach(async () => {
    db = await createMockDb<TestDb>();

    // App table used in tests
    await db.schema
      .createTable('tasks')
      .ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('title', 'text', (col) => col.notNull())
      .addColumn('completed', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('user_id', 'text', (col) => col.notNull())
      .addColumn('server_version', 'integer', (col) =>
        col.notNull().defaultTo(0)
      )
      .execute();
  });

  function createWrapper() {
    const transport = createMockTransport();
    const handlers = createMockHandlerRegistry<TestDb>();
    const sync = createMockSync<TestDb>({ handlers });

    const Wrapper = ({ children }: { children: ReactNode }) => (
      <SyncProvider
        db={db}
        transport={transport}
        sync={sync}
        identity={{ actorId: 'test-actor' }}
        clientId="test-client"
        pollIntervalMs={999999}
        autoStart={false}
      >
        {children}
      </SyncProvider>
    );

    return Wrapper;
  }

  it('insert() generates id, writes local row, and enqueues one outbox commit', async () => {
    const { result } = renderHook(
      () => ({
        api: useMutations({ sync: false }),
        engine: useEngine(),
      }),
      { wrapper: createWrapper() }
    );

    let insertedId = '';
    await act(async () => {
      const res = await result.current.api.tasks.insert({
        title: 'Hello',
        completed: 0,
        user_id: 'test-actor',
      });
      insertedId = res.id;
      expect(res.commitId).toBeTruthy();
      expect(res.clientCommitId).toBeTruthy();
    });

    const row = await db
      .selectFrom('tasks')
      .selectAll()
      .where('id', '=', insertedId)
      .executeTakeFirstOrThrow();
    expect(row.title).toBe('Hello');

    const outbox = await db
      .selectFrom('sync_outbox_commits')
      .select(['id', 'operations_json'])
      .execute();
    expect(outbox.length).toBe(1);

    const ops = JSON.parse(outbox[0]!.operations_json);
    expect(ops.length).toBe(1);
    expect(ops[0].op).toBe('upsert');
    expect(ops[0].table).toBe('tasks');
    expect(ops[0].row_id).toBe(insertedId);
    expect(ops[0].payload.id).toBeUndefined();
    expect(ops[0].payload.server_version).toBeUndefined();

    // Fingerprinting: local mutation timestamps updated
    expect(
      result.current.engine.getMutationTimestamp('tasks', insertedId)
    ).toBeGreaterThan(0);
  });

  it('$commit() batches multiple ops into a single outbox commit', async () => {
    const { result } = renderHook(() => useMutations({ sync: false }), {
      wrapper: createWrapper(),
    });

    let ids: string[] = [];
    await act(async () => {
      const res = await result.current.$commit(async (tx) => {
        const a = await tx.tasks.insert({
          title: 'A',
          completed: 0,
          user_id: 'test-actor',
        });
        const b = await tx.tasks.insert({
          title: 'B',
          completed: 0,
          user_id: 'test-actor',
        });
        return [a, b];
      });
      ids = res.result;
      expect(res.commit.commitId).toBeTruthy();
    });

    const outbox = await db
      .selectFrom('sync_outbox_commits')
      .select(['operations_json'])
      .execute();
    expect(outbox.length).toBe(1);

    const ops: { row_id: string }[] = JSON.parse(outbox[0]!.operations_json);
    expect(ops.length).toBe(2);
    expect(new Set(ops.map((o) => o.row_id))).toEqual(new Set(ids));
  });

  it('update() patches only provided columns and auto-reads base_version from server_version', async () => {
    const { result } = renderHook(() => useMutations({ sync: false }), {
      wrapper: createWrapper(),
    });

    // Seed a row with server_version=7
    await db
      .insertInto('tasks')
      .values({
        id: 't1',
        title: 'Keep',
        completed: 0,
        user_id: 'test-actor',
        server_version: 7,
      })
      .execute();

    await act(async () => {
      await result.current.tasks.update('t1', { completed: 1 });
    });

    const row = await db
      .selectFrom('tasks')
      .selectAll()
      .where('id', '=', 't1')
      .executeTakeFirstOrThrow();
    expect(row.title).toBe('Keep');
    expect(row.completed).toBe(1);
    expect(row.server_version).toBe(7);

    const outbox = await db
      .selectFrom('sync_outbox_commits')
      .select(['operations_json'])
      .executeTakeFirstOrThrow();

    const ops = JSON.parse(outbox.operations_json);
    expect(ops.length).toBe(1);
    expect(ops[0].base_version).toBe(7);
  });
});
