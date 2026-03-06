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

describe('useSyncQuery structural sharing', () => {
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

  it('preserves positional identity when joined rows share the same keyField', async () => {
    await db.schema
      .createTable('tasks')
      .ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('title', 'text', (col) => col.notNull())
      .execute();

    await db.schema
      .createTable('task_notes')
      .ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('task_id', 'text', (col) => col.notNull())
      .addColumn('note', 'text', (col) => col.notNull())
      .execute();

    await sql`
      insert into ${sql.table('tasks')} (${sql.ref('id')}, ${sql.ref('title')})
      values (${sql.val('task-1')}, ${sql.val('Task')})
    `.execute(db);

    await sql`
      insert into ${sql.table('task_notes')} (
        ${sql.ref('id')},
        ${sql.ref('task_id')},
        ${sql.ref('note')}
      )
      values
        (${sql.val('note-1')}, ${sql.val('task-1')}, ${sql.val('First note')}),
        (${sql.val('note-2')}, ${sql.val('task-1')}, ${sql.val('Second note')})
    `.execute(db);

    const { result } = renderHook(
      () => {
        const engine = useEngine();
        const query = useSyncQuery(({ selectFrom }) =>
          selectFrom('tasks')
            .innerJoin('task_notes', 'task_notes.task_id', 'tasks.id')
            .select([
              'tasks.id as id',
              'tasks.title as title',
              'task_notes.id as noteId',
              'task_notes.note as note',
            ])
            .orderBy('task_notes.id', 'asc')
        );

        return { engine, query };
      },
      { wrapper: createWrapper() }
    );

    await waitFor(() => {
      expect(result.current.query.isLoading).toBe(false);
      expect(result.current.query.data?.length).toBe(2);
    });

    const firstRow = result.current.query.data?.[0];
    const secondRow = result.current.query.data?.[1];

    await act(async () => {
      await sql`
        update ${sql.table('task_notes')}
        set ${sql.ref('note')} = ${sql.val('Second note updated')}
        where ${sql.ref('id')} = ${sql.val('note-2')}
      `.execute(db);

      result.current.engine.recordLocalMutations([
        {
          table: 'task_notes',
          rowId: 'note-2',
          op: 'upsert',
        },
      ]);
    });

    await waitFor(() => {
      expect(result.current.query.data?.[1]).toMatchObject({
        id: 'task-1',
        noteId: 'note-2',
        note: 'Second note updated',
      });
    });

    expect(result.current.query.data?.[0]).toBe(firstRow);
    expect(result.current.query.data?.[1]).not.toBe(secondRow);
  });
});
