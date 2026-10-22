/**
 * Scope-value erasure (SPEC.md §4.6.1): the erased rows leave every client
 * through ordinary deletes, a fresh bootstrap finds nothing of the binding,
 * and an incremental pull from before the erasure carries no payload of it.
 */
import { check, checkEqual } from '../checks';
import { task } from '../fixture';
import { rawPullHeader, rawSubscription, responseSection } from '../raw';
import type { Scenario } from '../scenario';
import { seedTasks, syncIdle } from './util';

const BOTH = { project_id: ['p1', 'p2'] } as const;

export const erasureScenarios: readonly Scenario[] = [
  {
    name: 'erasure/scope-value-leaves-clients-bootstrap-and-log',
    specRefs: ['§4.6.1', '§4.5', '§4.7'],
    requires: ['erasure'],
    async run(ctx) {
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: BOTH,
      });
      await a.api.subscribe({ id: 'tasks', table: 'tasks', scopes: BOTH });
      await syncIdle(a);
      await seedTasks(ctx, [
        task('t1', 'p1', 'personal'),
        task('t2', 'p1', 'personal too'),
        task('t3', 'p2', 'kept'),
      ]);
      await syncIdle(a);
      checkEqual(
        (await a.api.readRows('tasks')).map((row) => row.rowId),
        ['t1', 't2', 't3'],
        'the client holds both bindings before the erasure',
      );

      // One row per erasure commit: the binding leaves in two commits.
      await ctx.server.eraseScopeValue!('project_id', 'p1', 1);

      await syncIdle(a);
      checkEqual(
        (await a.api.readRows('tasks')).map((row) => row.rowId),
        ['t3'],
        'the erasure deletes reached the client that held the rows',
      );
      checkEqual(
        (await ctx.server.readRows('tasks')).map((row) => row.rowId),
        ['t3'],
        'the server keeps only the other binding',
      );

      const b = await ctx.newClient({
        actorId: 'actor-b',
        clientId: 'client-b',
        allowed: BOTH,
      });
      await b.api.subscribe({ id: 'tasks', table: 'tasks', scopes: BOTH });
      await syncIdle(b);
      checkEqual(
        (await b.api.readRows('tasks')).map((row) => row.rowId),
        ['t3'],
        'a fresh bootstrap finds nothing of the erased binding',
      );

      // An incremental pull from before the seed reads the log itself.
      await ctx.server.setAllowedScopes('raw-actor', BOTH);
      const pull = await ctx.rawSync(
        'raw-actor',
        [
          rawPullHeader(),
          rawSubscription('s1', 'tasks', { project_id: ['p1'] }, 0),
        ],
        { clientId: 'raw-client' },
      );
      check(pull.ok, 'incremental pull succeeded');
      if (!pull.ok) return;
      const changes = responseSection(pull.message, 's1').body.flatMap(
        (frame) => (frame.type === 'COMMIT' ? frame.changes : []),
      );
      checkEqual(
        changes.map((change) => `${change.op}:${change.rowId}`).sort(),
        ['delete:t1', 'delete:t2'],
        'the log of the binding holds the erasure deletes and no payload',
      );
    },
  },
];
