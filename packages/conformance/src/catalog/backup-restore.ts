import { check, checkEqual } from '../checks';
import { task } from '../fixture';
import type { Scenario } from '../scenario';
import { seedTasks, syncIdle, syncOk } from './util';

const P1 = { project_id: ['p1'] } as const;

export const backupRestoreScenarios: readonly Scenario[] = [
  {
    name: 'backup-restore/first-epoch-acquisition-preserves-ready-replica',
    specRefs: ['§2.1', '§7.1', '§7.5'],
    async run(ctx) {
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: P1,
      });
      await a.api.subscribe({ id: 'tasks', table: 'tasks', scopes: P1 });
      const id = await a.api.mutate([
        {
          op: 'upsert',
          table: 'tasks',
          values: task('offline', 'p1', 'before epoch'),
        },
      ]);
      const before = await a.api.subscriptionState('tasks');
      check(
        a.api.drainChangeBatches !== undefined &&
          a.api.executeStorageSql !== undefined &&
          a.api.querySnapshot !== undefined &&
          a.api.upgrading !== undefined &&
          a.api.prepareRound !== undefined &&
          a.api.completeRound !== undefined,
        'client supplies storage and observation evidence',
      );
      await a.api.executeStorageSql(
        'CREATE TRIGGER epoch_table_identity AFTER INSERT ON tasks BEGIN SELECT 1; END',
      );
      await a.api.drainChangeBatches();
      await a.api.prepareRound();
      const acquisition = await a.api.completeRound();
      check(acquisition.ok, 'epoch acquisition completes');
      const acquired = acquisition.report;
      checkEqual(
        acquired.resets,
        [],
        'first epoch acquisition reports no reset',
      );
      checkEqual(
        await a.api.upgrading(),
        false,
        'acquisition leaves the ready replica available',
      );
      check(
        (await a.api.drainChangeBatches()).every(
          (batch) => !batch.status?.upgrading,
        ),
        'every acquisition status avoids migrating',
      );
      checkEqual(
        await a.api.subscriptionState('tasks'),
        before,
        'acquisition preserves subscription progress',
      );
      checkEqual(
        await a.api.pendingCommitIds(),
        [id],
        'handshake does not send or discard pending intent',
      );
      checkEqual(
        (await a.api.readRows('tasks'))[0]?.values.title,
        'before epoch',
        'local intent stays visible',
      );
      checkEqual(
        (
          await a.api.querySnapshot(
            "SELECT name FROM sqlite_master WHERE name='epoch_table_identity'",
          )
        ).rows.length,
        1,
        'acquisition does not drop the table',
      );
      await syncIdle(a);
      checkEqual(
        await a.api.pendingCommitIds(),
        [],
        'the epoch-bound follow-up sends pending intent',
      );
      checkEqual(
        await a.api.upgrading(),
        false,
        'convergence never raises upgrading',
      );
    },
  },
  {
    name: 'backup-restore/log-epoch-resets-ahead-client',
    specRefs: ['§2.1', '§6.3'],
    requires: ['backup-restore'],
    async run(ctx) {
      const captureBackup = ctx.server.captureBackup;
      const restoreBackup = ctx.server.restoreBackup;
      if (captureBackup === undefined || restoreBackup === undefined) {
        throw new Error('backup-restore capability omits its server methods');
      }
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: P1,
      });
      await seedTasks(ctx, [task('before', 'p1', 'in backup')]);
      await a.api.subscribe({ id: 'tasks', table: 'tasks', scopes: P1 });
      await syncIdle(a);

      await captureBackup.call(ctx.server);
      await seedTasks(ctx, [task('lost', 'p1', 'after backup')]);
      await syncIdle(a);
      await a.api.mutate([
        {
          op: 'upsert',
          table: 'tasks',
          values: task('offline', 'p1', 'preserved outbox'),
        },
      ]);

      await restoreBackup.call(ctx.server);
      const reset = await syncOk(a);
      check(reset.resets.includes('tasks'), 'the epoch change reset the table');
      await syncIdle(a);

      checkEqual(
        (await a.api.readRows('tasks')).map((row) => row.rowId),
        ['before', 'offline'],
        'the reset removed post-backup rows and replayed offline work',
      );
      checkEqual(
        (await ctx.server.readRows('tasks')).map((row) => row.rowId),
        ['before', 'offline'],
        'the restored server accepted the preserved outbox once',
      );
    },
  },
];
