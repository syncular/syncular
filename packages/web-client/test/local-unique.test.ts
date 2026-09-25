/**
 * §7.1 local unique indexes: a local commit that violates a declared
 * secondary unique index against the visible state fails with
 * `sync.constraint_violation` and records nothing.
 */
import { describe, expect, test } from 'bun:test';
import type { ClientSchema } from '@syncular/client';
import { ClientSyncError } from '../src/errors';
import { CLIENT_SCHEMA, makeClient, makeServer } from './helpers';

const UNIQUE_SCHEMA: ClientSchema = {
  ...CLIENT_SCHEMA,
  tables: CLIENT_SCHEMA.tables.map((table) =>
    table.name === 'tasks'
      ? {
          ...table,
          indexes: [
            {
              name: 'idx_tasks_project_title',
              columns: ['project_id', 'title'],
              unique: true,
            },
          ],
        }
      : table,
  ),
};

function task(id: string, projectId: string, title: string) {
  return {
    op: 'upsert' as const,
    table: 'tasks',
    values: { id, project_id: projectId, title, done: false },
  };
}

function thrown(fn: () => unknown): ClientSyncError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ClientSyncError) return error;
    throw error;
  }
  throw new Error('expected a ClientSyncError');
}

describe('local secondary unique indexes', () => {
  test('a colliding commit fails loudly and enqueues nothing', async () => {
    const { client, db } = await makeClient(makeServer(), {
      clientId: 'unique-client',
      schema: UNIQUE_SCHEMA,
    });
    const revision = client.localRevision;
    const error = thrown(() =>
      client.mutate([task('t1', 'p1', 'same'), task('t2', 'p1', 'same')]),
    );
    expect(error.code).toBe('sync.constraint_violation');
    expect(error.message).toBe('local write violates a unique constraint');
    expect(db.query('SELECT id FROM tasks')).toEqual([]);
    expect(client.pendingCommits()).toEqual([]);
    expect(client.localRevision).toEqual(revision);

    const first = client.mutate([task('t1', 'p1', 'same')]);
    expect(thrown(() => client.mutate([task('t2', 'p1', 'same')])).code).toBe(
      'sync.constraint_violation',
    );
    client.mutate([task('t2', 'p1', 'other')]);
    expect(
      thrown(() => client.patch('tasks', 't2', { title: 'same' })).code,
    ).toBe('sync.constraint_violation');
    expect(client.pendingCommits().map((c) => c.clientCommitId)[0]).toBe(first);
    expect(client.pendingCommits()).toHaveLength(2);

    // Another project, and a value freed earlier in the same commit, apply.
    client.mutate([task('t3', 'p2', 'same')]);
    client.mutate([task('t1', 'p1', 'renamed'), task('t4', 'p1', 'same')]);
    expect(
      db
        .query('SELECT id, title FROM tasks ORDER BY id')
        .map((row) => [row.id, row.title]),
    ).toEqual([
      ['t1', 'renamed'],
      ['t2', 'other'],
      ['t3', 'same'],
      ['t4', 'same'],
    ]);
    expect(client.pendingCommits()).toHaveLength(4);
  });
});
