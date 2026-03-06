import { beforeEach, describe, expect, it } from 'bun:test';
import type { SyncClientDb } from '@syncular/client';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { ReactNode } from 'react';
import { createSyncularReact } from '../index';
import {
  createMockDb,
  createMockHandlerRegistry,
  createMockSync,
  createMockTransport,
} from './test-utils';

const { SyncProvider, useEngine, useSyncQuery } =
  createSyncularReact<SyncClientDb>();

describe('useSyncQuery branching', () => {
  let db: Kysely<SyncClientDb>;

  beforeEach(async () => {
    db = await createMockDb();
  });

  function createWrapper() {
    const transport = createMockTransport();
    const handlers = createMockHandlerRegistry();
    const sync = createMockSync({ handlers });

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

  it('does not leak joined tables from an abandoned builder branch', async () => {
    await db.schema
      .createTable('users')
      .ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('name', 'text', (col) => col.notNull())
      .execute();

    await db.schema
      .createTable('tasks')
      .ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('user_id', 'text', (col) => col.notNull())
      .addColumn('title', 'text', (col) => col.notNull())
      .execute();

    await sql`
      insert into ${sql.table('users')} (${sql.ref('id')}, ${sql.ref('name')})
      values (${sql.val('user-1')}, ${sql.val('Alice')})
    `.execute(db);

    await sql`
      insert into ${sql.table('tasks')} (
        ${sql.ref('id')},
        ${sql.ref('user_id')},
        ${sql.ref('title')}
      )
      values (
        ${sql.val('task-1')},
        ${sql.val('user-1')},
        ${sql.val('First task')}
      )
    `.execute(db);

    let executions = 0;

    const { result } = renderHook(
      () => {
        const engine = useEngine();
        const query = useSyncQuery(({ selectFrom }) => {
          executions += 1;

          const base = selectFrom('tasks');
          void base.innerJoin('users', 'users.id', 'tasks.user_id');

          return base
            .select(['tasks.id as id', 'tasks.title as title'])
            .orderBy('tasks.id', 'asc');
        });

        return { engine, query };
      },
      { wrapper: createWrapper() }
    );

    await waitFor(() => {
      expect(result.current.query.isLoading).toBe(false);
      expect(result.current.query.data?.[0]).toMatchObject({
        id: 'task-1',
        title: 'First task',
      });
    });

    const initialExecutions = executions;

    await act(async () => {
      await sql`
        update ${sql.table('users')}
        set ${sql.ref('name')} = ${sql.val('Bob')}
        where ${sql.ref('id')} = ${sql.val('user-1')}
      `.execute(db);

      result.current.engine.recordLocalMutations([
        {
          table: 'users',
          rowId: 'user-1',
          op: 'upsert',
        },
      ]);
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(executions).toBe(initialExecutions);

    await act(async () => {
      await sql`
        update ${sql.table('tasks')}
        set ${sql.ref('title')} = ${sql.val('First task updated')}
        where ${sql.ref('id')} = ${sql.val('task-1')}
      `.execute(db);

      result.current.engine.recordLocalMutations([
        {
          table: 'tasks',
          rowId: 'task-1',
          op: 'upsert',
        },
      ]);
    });

    await waitFor(() => {
      expect(executions).toBeGreaterThan(initialExecutions);
      expect(result.current.query.data?.[0]).toMatchObject({
        id: 'task-1',
        title: 'First task updated',
      });
    });
  });
});
