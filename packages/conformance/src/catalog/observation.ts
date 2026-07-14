/** Cross-core RFC 0003 observation vectors. These assert the local reactive
 * contract itself (revision, atomic snapshot, exact domains, and sync intent),
 * not just eventual server convergence. The same scenarios run on the TS and
 * Rust client cores through their real command surfaces. */
import { check, checkEqual } from '../checks';
import type { ClientInstance } from '../driver';
import { FIXTURE_SCHEMA, task } from '../fixture';
import type { Scenario } from '../scenario';
import { seedTasks, syncIdle } from './util';

const BASE = { table: 'tasks', variable: 'project_id' } as const;

function requireObservation(client: ClientInstance) {
  check(client.localRevision !== undefined, 'localRevision is available');
  check(client.querySnapshot !== undefined, 'querySnapshot is available');
  check(
    client.drainChangeBatches !== undefined,
    'exact change batches are available',
  );
  check(client.drainSyncIntents !== undefined, 'sync intents are available');
  if (
    client.localRevision === undefined ||
    client.querySnapshot === undefined ||
    client.drainChangeBatches === undefined ||
    client.drainSyncIntents === undefined
  ) {
    throw new Error('client lacks the RFC 0003 observation surface');
  }
  return {
    localRevision: client.localRevision.bind(client),
    querySnapshot: client.querySnapshot.bind(client),
    drainChangeBatches: client.drainChangeBatches.bind(client),
    drainSyncIntents: client.drainSyncIntents.bind(client),
  };
}

export const observationScenarios: readonly Scenario[] = [
  {
    name: 'observation/optimistic-scope-move-and-atomic-snapshot',
    specRefs: ['§7.5', 'RFC-0003'],
    async run(ctx) {
      const handle = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: { project_id: ['p1', 'p2'] },
      });
      const observation = requireObservation(handle.api);
      await observation.drainChangeBatches();
      await observation.drainSyncIntents();

      await handle.api.mutate([
        {
          op: 'upsert',
          table: 'tasks',
          values: task('t1', 'p1', 'first'),
        },
      ]);
      checkEqual(await observation.localRevision(), '1', 'first revision');
      checkEqual(
        await observation.drainSyncIntents(),
        [{ kind: 'interactive' }],
        'local write produces one interactive intent',
      );
      const first = await observation.drainChangeBatches();
      checkEqual(first.length, 1, 'one transaction emits one batch');
      checkEqual(first[0]?.revision, '1', 'batch revision matches metadata');
      checkEqual(
        first[0]?.tables,
        [{ table: 'tasks', scopeKeys: ['project:p1'] }],
        'upsert carries its exact scope key',
      );
      checkEqual(first[0]?.status?.outbox, 1, 'status is in the same batch');

      const snapshot = await observation.querySnapshot(
        'SELECT id, project_id, title FROM tasks WHERE id = ?',
        ['t1'],
      );
      checkEqual(snapshot.revision, '1', 'snapshot revision is atomic');
      checkEqual(snapshot.rows.length, 1, 'snapshot sees optimistic row');
      checkEqual(snapshot.rows[0]?.title, 'first', 'snapshot row is current');

      await handle.api.mutate([
        {
          op: 'upsert',
          table: 'tasks',
          values: task('t1', 'p2', 'moved'),
        },
      ]);
      const moved = (await observation.drainChangeBatches())[0];
      checkEqual(moved?.revision, '2', 'scope move advances once');
      checkEqual(
        moved?.tables[0]?.scopeKeys,
        ['project:p1', 'project:p2'],
        'scope move routes both before and after keys',
      );

      await handle.api.mutate([{ op: 'delete', table: 'tasks', rowId: 't1' }]);
      const deleted = (await observation.drainChangeBatches())[0];
      checkEqual(deleted?.revision, '3', 'delete advances once');
      checkEqual(
        deleted?.tables,
        [{ table: 'tasks', scopeKeys: ['project:p2'] }],
        'delete routes the last visible scope',
      );
      const absent = await observation.querySnapshot(
        'SELECT id FROM tasks WHERE id = ?',
        ['t1'],
      );
      checkEqual(absent.revision, '3', 'delete snapshot is same revision');
      checkEqual(absent.rows, [], 'optimistic delete is visible atomically');
    },
  },
  {
    name: 'observation/zero-row-window-completion',
    specRefs: ['§4.8', '§7.5', 'RFC-0003'],
    async run(ctx) {
      const handle = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: { project_id: ['empty'] },
      });
      const observation = requireObservation(handle.api);
      await observation.drainChangeBatches();
      await observation.drainSyncIntents();

      await handle.api.setWindow?.(BASE, ['empty']);
      checkEqual(
        await observation.drainSyncIntents(),
        [{ kind: 'interactive' }],
        'window widening requests immediate sync',
      );
      const registered = await observation.drainChangeBatches();
      checkEqual(registered.length, 1, 'registration is one local batch');
      checkEqual(registered[0]?.tables, [], 'registration changes no rows');
      check(
        registered[0]?.windows[0]?.units.includes('empty') ?? false,
        'registration names the exact unit',
      );
      const pending = await observation.querySnapshot(
        'SELECT id FROM tasks WHERE project_id = ?',
        ['empty'],
        [{ base: BASE, units: ['empty'] }],
      );
      check(!pending.coverage.complete, 'pre-bootstrap emptiness is pending');
      checkEqual(pending.rows, [], 'pending unit honestly has zero local rows');

      await syncIdle(handle);
      const completion = await observation.drainChangeBatches();
      check(
        completion.some(
          (batch) =>
            batch.tables.length === 0 &&
            batch.windows.some((window) => window.units.includes('empty')),
        ),
        'zero-row completion emits an exact window-only batch',
      );
      const ready = await observation.querySnapshot(
        'SELECT id FROM tasks WHERE project_id = ?',
        ['empty'],
        [{ base: BASE, units: ['empty'] }],
      );
      check(ready.coverage.complete, 'zero-row bootstrap becomes complete');
      checkEqual(ready.rows, [], 'complete empty remains zero rows');
    },
  },
  {
    name: 'observation/persistent-open-catch-up-intent',
    specRefs: ['§7.5', '§8.4', 'RFC-0003'],
    async run(ctx) {
      const handle = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: { project_id: ['p1'] },
      });
      let observation = requireObservation(handle.api);
      await handle.api.setWindow?.(BASE, ['p1']);
      await syncIdle(handle);
      await observation.drainChangeBatches();
      await observation.drainSyncIntents();

      await ctx.recreateClient(handle, FIXTURE_SCHEMA);
      observation = requireObservation(handle.api);
      check(
        await handle.api.syncNeeded(),
        'persistent open marks catch-up work as needed',
      );
      checkEqual(
        await observation.drainSyncIntents(),
        [{ kind: 'interactive' }],
        'persistent open emits exactly one interactive catch-up intent',
      );

      await syncIdle(handle);
      check(
        !(await handle.api.syncNeeded()),
        'catch-up round clears the startup work signal',
      );
    },
  },
  {
    name: 'observation/remote-commit-exact-change',
    specRefs: ['§4.5', '§7.5', 'RFC-0003'],
    async run(ctx) {
      const handle = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: { project_id: ['p1'] },
      });
      const observation = requireObservation(handle.api);
      await handle.api.setWindow?.(BASE, ['p1']);
      await syncIdle(handle);
      await observation.drainChangeBatches();
      await observation.drainSyncIntents();
      const before = BigInt(await observation.localRevision());

      await seedTasks(ctx, [task('remote', 'p1', 'from-server')]);
      await syncIdle(handle);
      const batches = await observation.drainChangeBatches();
      const rowBatch = batches.find((batch) =>
        batch.tables.some(
          (table) =>
            table.table === 'tasks' && table.scopeKeys?.includes('project:p1'),
        ),
      );
      check(
        rowBatch !== undefined,
        'remote apply emits exact tasks/project:p1',
      );
      check(
        BigInt(rowBatch?.revision ?? '0') > before,
        'remote apply advances the persisted local revision',
      );
      const snapshot = await observation.querySnapshot(
        'SELECT id, title FROM tasks WHERE id = ?',
        ['remote'],
      );
      checkEqual(
        snapshot.rows[0]?.title,
        'from-server',
        'remote row is visible',
      );
      check(
        BigInt(snapshot.revision) >= BigInt(rowBatch?.revision ?? '0'),
        'snapshot is not older than its change batch',
      );
    },
  },
  {
    name: 'observation/window-shrink-and-rollback',
    specRefs: ['§4.8', '§7.5', 'RFC-0003'],
    async run(ctx) {
      const handle = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: { project_id: ['p1', 'p2'] },
      });
      const observation = requireObservation(handle.api);
      await seedTasks(ctx, [task('one', 'p1'), task('two', 'p2')]);
      await handle.api.setWindow?.(BASE, ['p1', 'p2']);
      await syncIdle(handle);
      await observation.drainChangeBatches();
      await observation.drainSyncIntents();

      await handle.api.setWindow?.(BASE, ['p2']);
      const shrink = await observation.drainChangeBatches();
      checkEqual(shrink.length, 1, 'shrink is one observer transaction');
      checkEqual(
        shrink[0]?.tables,
        [{ table: 'tasks', scopeKeys: ['project:p1'] }],
        'shrink reports only the evicted unit rows',
      );
      check(
        shrink[0]?.windows.some((window) => window.units.includes('p1')) ??
          false,
        'shrink reports the departed coverage unit',
      );
      checkEqual(
        await observation.drainSyncIntents(),
        [{ kind: 'interactive' }],
        'shrink immediately re-registers the realtime subscription set',
      );

      const revision = await observation.localRevision();
      let rejected = false;
      try {
        await handle.api.mutate([
          {
            op: 'upsert',
            table: 'tasks',
            values: { id: 'invalid-missing-required-fields' },
          },
        ]);
      } catch {
        rejected = true;
      }
      check(rejected, 'invalid transaction is rejected');
      checkEqual(
        await observation.localRevision(),
        revision,
        'rollback does not advance revision',
      );
      checkEqual(
        await observation.drainChangeBatches(),
        [],
        'rollback emits no observer batch',
      );
      checkEqual(
        await observation.drainSyncIntents(),
        [],
        'rollback emits no sync intent',
      );
    },
  },
];
