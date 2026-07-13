/**
 * The public seeding helper (RFC 0002 §2.5): app-shaped mutations ride the
 * real push path, re-running replays idempotently, and failures are loud.
 */
import { describe, expect, test } from 'bun:test';
import { seedMutations } from '@syncular/server';
import { makeContext } from './helpers';

describe('seedMutations', () => {
  test('seeds rows through the real push path, idempotently', async () => {
    const { ctx, storage } = makeContext();
    const mutations = [
      {
        table: 'tasks',
        op: 'upsert' as const,
        // camelCase keys are accepted (the generated row types' casing);
        // missing nullable columns (priority, meta) become NULL.
        values: { id: 't1', projectId: 'p1', title: 'seeded', done: false },
      },
      {
        table: 'tasks',
        op: 'upsert' as const,
        values: { id: 't2', project_id: 'p1', title: 'second', done: true },
      },
    ];
    await seedMutations(
      ctx,
      { partition: 'part-1', actorId: 'actor-1' },
      mutations,
    );
    expect(await storage.getMaxCommitSeq('part-1')).toBe(1);
    const row = await storage.getRow('part-1', 'tasks', 't1');
    expect(row?.serverVersion).toBe(1);
    expect(row?.scopes).toEqual({ project_id: 'p1' });

    // Same commit id → the §2.3 idempotency cache replays; nothing doubles.
    await seedMutations(
      ctx,
      { partition: 'part-1', actorId: 'actor-1' },
      mutations,
    );
    expect(await storage.getMaxCommitSeq('part-1')).toBe(1);

    // A second batch under a new commit id lands as its own commit.
    await seedMutations(
      ctx,
      { partition: 'part-1', actorId: 'actor-1', commitId: 'seed-commit-2' },
      [{ table: 'tasks', op: 'delete' as const, rowId: 't2' }],
    );
    expect(await storage.getMaxCommitSeq('part-1')).toBe(2);
    expect(await storage.getRow('part-1', 'tasks', 't2')).toBeUndefined();
  });

  test('an unknown table or column fails loud', async () => {
    const { ctx } = makeContext();
    const target = { partition: 'part-1', actorId: 'actor-1' };
    await expect(
      seedMutations(ctx, target, [
        { table: 'nope', op: 'upsert', values: { id: 'x' } },
      ]),
    ).rejects.toThrow(/unknown table/);
    await expect(
      seedMutations(ctx, target, [
        {
          table: 'tasks',
          op: 'upsert',
          values: {
            id: 't1',
            project_id: 'p1',
            title: 'x',
            done: false,
            bogus: 1,
          },
        },
      ]),
    ).rejects.toThrow(/unknown column/);
  });

  test('a rejected push surfaces the operation error', async () => {
    const { ctx, scopes } = makeContext();
    // Constrain the actor's scopes so the write is forbidden.
    scopes.value = { project_id: ['other'], projectId: ['other'], org_id: [] };
    await expect(
      seedMutations(ctx, { partition: 'part-1', actorId: 'actor-1' }, [
        {
          table: 'tasks',
          op: 'upsert',
          values: { id: 't1', project_id: 'p1', title: 'x', done: false },
        },
      ]),
    ).rejects.toThrow(/rejected/);
  });
});
