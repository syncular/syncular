import { describe, expect, it } from 'bun:test';
import {
  appendReturning,
  detectMutation,
  hasReturningWildcard,
} from './mutation-detector';

describe('detectMutation', () => {
  it('detects comment-prefixed update statements', () => {
    const detected = detectMutation(`
      /* admin tooling */
      UPDATE tasks
      SET title = 'updated'
      WHERE id = 't1'
    `);

    expect(detected).toEqual({
      operation: 'upsert',
      tableName: 'tasks',
    });
  });

  it('detects cte-prefixed update statements', () => {
    const detected = detectMutation(`
      WITH touched AS (
        SELECT id FROM tasks WHERE id = 't1'
      )
      UPDATE tasks
      SET title = 'updated'
      WHERE id IN (SELECT id FROM touched)
    `);

    expect(detected).toEqual({
      operation: 'upsert',
      tableName: 'tasks',
    });
  });

  it('returns null for cte-prefixed read queries', () => {
    const detected = detectMutation(`
      WITH filtered AS (
        SELECT id FROM tasks WHERE user_id = 'u1'
      )
      SELECT * FROM filtered
    `);

    expect(detected).toBeNull();
  });
});

describe('returning helpers', () => {
  it('recognizes wildcard RETURNING clauses', () => {
    expect(
      hasReturningWildcard('UPDATE tasks SET title = $1 RETURNING *')
    ).toBe(true);
    expect(
      hasReturningWildcard(
        'UPDATE tasks SET title = $1 RETURNING tasks.id, tasks.*'
      )
    ).toBe(true);
    expect(
      hasReturningWildcard('UPDATE tasks SET title = $1 RETURNING id')
    ).toBe(false);
  });

  it('appends RETURNING * when missing', () => {
    expect(appendReturning('UPDATE tasks SET title = $1')).toBe(
      'UPDATE tasks SET title = $1 RETURNING *'
    );
  });
});
