/**
 * Declared references (SPEC.md §6.11, Appendix B.19): the server enforces
 * `REFERENCES parent(pk) ON DELETE RESTRICT | CASCADE | SET NULL` once per
 * commit over candidate state, so a commit that deletes a parent and its
 * children together passes and a cascade stays inside one authorization
 * boundary.
 */
import { check, checkEqual } from '../checks';
import { item, project, REFERENCE_FIXTURE_SCHEMA } from '../fixture';
import type { Scenario, ScenarioContext } from '../scenario';
import { expectConverged, syncIdle, syncOk } from './util';

const SCOPE = { project_id: ['*'] } as const;
const SUBSCRIBE = { project_id: ['p1'] } as const;

async function bootstrapped(
  ctx: ScenarioContext,
  actorId: string,
  clientId: string,
) {
  const handle = await ctx.newClient({
    actorId,
    clientId,
    allowed: SCOPE,
    schema: REFERENCE_FIXTURE_SCHEMA,
  });
  await handle.api.subscribe({
    id: 'projects',
    table: 'projects',
    scopes: SUBSCRIBE,
  });
  await handle.api.subscribe({
    id: 'items',
    table: 'items',
    scopes: SUBSCRIBE,
  });
  await syncIdle(handle);
  return handle;
}

export const referenceScenarios: readonly Scenario[] = [
  {
    name: 'references/missing-parent-rejects',
    specRefs: ['§6.11', 'B.19'],
    server: { schema: REFERENCE_FIXTURE_SCHEMA },
    async run(ctx) {
      const a = await bootstrapped(ctx, 'actor-a', 'client-a');
      await a.api.mutate([
        { op: 'upsert', table: 'projects', values: project('p1', 'P1') },
      ]);
      await syncIdle(a);

      const rejected = await a.api.mutate([
        {
          op: 'upsert',
          table: 'items',
          values: item('i1', 'p1', 'item', { restrict: 'ghost' }),
        },
      ]);
      const report = await syncOk(a);
      checkEqual(report.rejected, [rejected], 'the child insert is rejected');
      const rejection = (await a.api.rejections())[0];
      checkEqual(
        rejection?.code,
        'sync.reference_violation',
        'the reference rejection code',
      );
      checkEqual(
        rejection?.details?.reason,
        'missing_parent',
        'the machine reason names the failing case',
      );
      checkEqual(
        rejection?.details?.fieldPaths,
        ['restrict_parent'],
        'the offending column rides fieldPaths',
      );
      checkEqual(
        rejection?.details?.references,
        { parent: 'projects', row: 'ghost' },
        'the absent parent identity rides references',
      );
      checkEqual(
        (await ctx.server.readRows('items')).length,
        0,
        'the commit rolls back whole',
      );
      checkEqual(
        await a.api.readRows('items'),
        [],
        'the rejected optimistic insert disappears locally (§7.2)',
      );
    },
  },

  {
    name: 'references/restrict-blocks-parent-delete',
    specRefs: ['§6.11', 'B.19'],
    server: { schema: REFERENCE_FIXTURE_SCHEMA },
    async run(ctx) {
      const a = await bootstrapped(ctx, 'actor-a', 'client-a');
      await a.api.mutate([
        { op: 'upsert', table: 'projects', values: project('p1', 'P1') },
      ]);
      await syncIdle(a);
      await a.api.mutate([
        {
          op: 'upsert',
          table: 'items',
          values: item('i1', 'p1', 'item', { restrict: 'p1' }),
        },
      ]);
      await syncIdle(a);

      const rejected = await a.api.mutate([
        { op: 'delete', table: 'projects', rowId: 'p1' },
      ]);
      const report = await syncOk(a);
      checkEqual(report.rejected, [rejected], 'the parent delete is rejected');
      const rejection = (await a.api.rejections())[0];
      checkEqual(
        rejection?.details?.reason,
        'restricted_delete',
        'RESTRICT reports its own reason',
      );
      checkEqual(
        rejection?.details?.references,
        { child: 'items' },
        'the child table rides references',
      );
      checkEqual(
        (await ctx.server.readRows('projects')).length,
        1,
        'the parent survives the rejected delete',
      );

      // With the child gone, the same delete applies.
      await a.api.mutate([{ op: 'delete', table: 'items', rowId: 'i1' }]);
      await syncIdle(a);
      await a.api.mutate([{ op: 'delete', table: 'projects', rowId: 'p1' }]);
      await syncOk(a);
      checkEqual(
        (await ctx.server.readRows('projects')).length,
        0,
        'the parent delete applies once no child remains',
      );
    },
  },

  {
    name: 'references/child-insert-after-parent-delete-rejects',
    specRefs: ['§6.11', 'B.19'],
    server: { schema: REFERENCE_FIXTURE_SCHEMA },
    async run(ctx) {
      const a = await bootstrapped(ctx, 'actor-a', 'client-a');
      await a.api.mutate([
        { op: 'upsert', table: 'projects', values: project('p1', 'P1') },
      ]);
      await syncIdle(a);
      await a.api.mutate([{ op: 'delete', table: 'projects', rowId: 'p1' }]);
      await syncOk(a);

      const rejected = await a.api.mutate([
        {
          op: 'upsert',
          table: 'items',
          values: item('i1', 'p1', 'item', { restrict: 'p1' }),
        },
      ]);
      const report = await syncOk(a);
      checkEqual(
        report.rejected,
        [rejected],
        'the late child insert is rejected',
      );
      checkEqual(
        (await a.api.rejections())[0]?.details?.reason,
        'missing_parent',
        'the other arrival order yields the sibling outcome',
      );
    },
  },

  {
    name: 'references/cascade-deletes-children-in-commit',
    specRefs: ['§6.11', 'B.19'],
    server: { schema: REFERENCE_FIXTURE_SCHEMA },
    async run(ctx) {
      const a = await bootstrapped(ctx, 'actor-a', 'client-a');
      const b = await bootstrapped(ctx, 'actor-b', 'client-b');
      await a.api.mutate([
        { op: 'upsert', table: 'projects', values: project('p1', 'P1') },
      ]);
      await syncIdle(a);
      await a.api.mutate([
        {
          op: 'upsert',
          table: 'items',
          values: item('i1', 'p1', 'item', { cascade: 'p1' }),
        },
      ]);
      await syncIdle(a);
      await syncIdle(b);

      const applied = await a.api.mutate([
        { op: 'delete', table: 'projects', rowId: 'p1' },
      ]);
      const report = await syncOk(a);
      check(
        report.applied.includes(applied),
        'the cascade delete applies in one commit',
      );
      await syncIdle(b);
      checkEqual(
        (await ctx.server.readRows('items')).length,
        0,
        'the cascade removed the child server-side',
      );
      await expectConverged(ctx, 'items', [a, b], {
        variable: 'project_id',
        values: ['p1'],
      });
      checkEqual(
        await a.api.readRows('items'),
        [],
        'the subscriber sees the child removed',
      );
    },
  },

  {
    name: 'references/set-null-clears-child-column',
    specRefs: ['§6.11', 'B.19'],
    server: { schema: REFERENCE_FIXTURE_SCHEMA },
    async run(ctx) {
      const a = await bootstrapped(ctx, 'actor-a', 'client-a');
      const b = await bootstrapped(ctx, 'actor-b', 'client-b');
      await a.api.mutate([
        { op: 'upsert', table: 'projects', values: project('p1', 'P1') },
      ]);
      await syncIdle(a);
      await a.api.mutate([
        {
          op: 'upsert',
          table: 'items',
          values: item('i1', 'p1', 'item', { nullify: 'p1' }),
        },
      ]);
      await syncIdle(a);
      await syncIdle(b);

      await a.api.mutate([{ op: 'delete', table: 'projects', rowId: 'p1' }]);
      await syncIdle(a);
      await syncIdle(b);
      const rows = await ctx.server.readRows('items');
      checkEqual(rows.length, 1, 'SET NULL keeps the child row');
      checkEqual(
        rows[0]?.values.nullify_parent,
        null,
        'the reference column is nulled',
      );
      checkEqual(rows[0]?.version, 2, 'the NULL write bumps the row version');
      await expectConverged(ctx, 'items', [a, b], {
        variable: 'project_id',
        values: ['p1'],
      });
    },
  },

  {
    name: 'references/delete-parent-and-children-together-passes-restrict',
    specRefs: ['§6.11', 'B.19'],
    server: { schema: REFERENCE_FIXTURE_SCHEMA },
    async run(ctx) {
      const a = await bootstrapped(ctx, 'actor-a', 'client-a');
      await a.api.mutate([
        { op: 'upsert', table: 'projects', values: project('p1', 'P1') },
      ]);
      await syncIdle(a);
      await a.api.mutate([
        {
          op: 'upsert',
          table: 'items',
          values: item('i1', 'p1', 'item', { restrict: 'p1' }),
        },
      ]);
      await syncIdle(a);

      const applied = await a.api.mutate([
        { op: 'delete', table: 'items', rowId: 'i1' },
        { op: 'delete', table: 'projects', rowId: 'p1' },
      ]);
      const report = await syncOk(a);
      check(
        report.applied.includes(applied),
        'candidate state lets the aggregate delete pass RESTRICT',
      );
      checkEqual(
        (await ctx.server.readRows('projects')).length,
        0,
        'the parent delete applied',
      );
      checkEqual(
        (await ctx.server.readRows('items')).length,
        0,
        'the sibling child delete applied',
      );
    },
  },

  {
    name: 'references/cascade-limit-rejects',
    specRefs: ['§6.11', 'B.19'],
    server: {
      schema: REFERENCE_FIXTURE_SCHEMA,
      limits: { maxCascadeOperationsPerCommit: 3 },
    },
    async run(ctx) {
      const a = await bootstrapped(ctx, 'actor-a', 'client-a');
      await a.api.mutate([
        { op: 'upsert', table: 'projects', values: project('p1', 'P1') },
      ]);
      await syncIdle(a);
      await a.api.mutate(
        ['i1', 'i2', 'i3', 'i4'].map((id) => ({
          op: 'upsert' as const,
          table: 'items',
          values: item(id, 'p1', 'item', { cascade: 'p1' }),
        })),
      );
      await syncIdle(a);

      const rejected = await a.api.mutate([
        { op: 'delete', table: 'projects', rowId: 'p1' },
      ]);
      const report = await syncOk(a);
      checkEqual(
        report.rejected,
        [rejected],
        'a cascade past the cap is rejected',
      );
      checkEqual(
        (await a.api.rejections())[0]?.details?.reason,
        'cascade_limit',
        'the cap reports its own reason',
      );
      checkEqual(
        (await ctx.server.readRows('items')).length,
        4,
        'the whole cascade rolls back',
      );
      checkEqual(
        (await ctx.server.readRows('projects')).length,
        1,
        'the parent survives the rejected cascade',
      );
    },
  },
];
