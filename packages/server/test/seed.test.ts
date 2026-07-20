/**
 * The public seeding helper (RFC 0002 §2.5): app-shaped mutations ride the
 * real push path, re-running replays idempotently, and failures are loud.
 */
import { describe, expect, test } from 'bun:test';
import { decodeRow } from '@syncular/core';
import { seedMutations } from '@syncular/server';
import { makeContext, TASK_COLUMNS, TEST_SCHEMA } from './helpers';

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

  test('documents non-destructive recovery when a seed actor changes', async () => {
    const { ctx, storage } = makeContext();
    const base = {
      partition: 'part-1',
      actorId: 'seed-user',
      clientId: 'catalog-seed-user',
      commitId: 'catalog-v1',
    };
    await seedMutations(ctx, base, [
      {
        table: 'tasks',
        op: 'upsert',
        values: {
          id: 'catalog-row',
          projectId: 'p1',
          title: 'seed actor',
          done: false,
        },
      },
    ]);

    await expect(
      seedMutations(
        ctx,
        {
          ...base,
          actorId: 'server-authority',
          commitId: 'catalog-v2',
        },
        [
          {
            table: 'tasks',
            op: 'upsert',
            values: {
              id: 'catalog-row',
              projectId: 'p1',
              title: 'server authority',
              done: false,
            },
          },
        ],
      ),
    ).rejects.toMatchObject({ code: 'sync.invalid_client_id' });

    await seedMutations(
      ctx,
      {
        partition: 'part-1',
        actorId: 'server-authority',
        clientId: 'catalog-server-authority',
        commitId: 'catalog-v2',
      },
      [
        {
          table: 'tasks',
          op: 'upsert',
          values: {
            id: 'catalog-row',
            projectId: 'p1',
            title: 'server authority',
            done: false,
          },
        },
      ],
    );

    const recovered = await storage.getRow('part-1', 'tasks', 'catalog-row');
    expect(
      decodeRow(TASK_COLUMNS, recovered?.payload ?? new Uint8Array())[2],
    ).toBe('server authority');
    expect(await storage.getMaxCommitSeq('part-1')).toBe(2);
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

  test('accepts the pinned generated alias for underscore-separated digit segments', async () => {
    const schema = {
      ...TEST_SCHEMA,
      tables: [
        ...TEST_SCHEMA.tables,
        {
          name: 'addresses',
          columns: [
            { name: 'id', type: 'string' as const, nullable: false },
            { name: 'project_id', type: 'string' as const, nullable: false },
            {
              name: 'address_line_1',
              type: 'string' as const,
              nullable: false,
            },
          ],
          primaryKey: 'id',
          scopes: ['project:{project_id}'],
        },
      ],
    };
    const { ctx, storage } = makeContext({ schema });
    await seedMutations(ctx, { partition: 'part-1', actorId: 'actor-1' }, [
      {
        table: 'addresses',
        op: 'upsert',
        values: {
          id: 'address-1',
          projectId: 'p1',
          addressLine1: 'First line',
        },
      },
    ]);
    expect(
      await storage.getRow('part-1', 'addresses', 'address-1'),
    ).toBeDefined();
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
