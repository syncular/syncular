import { check, checkEqual } from '../checks';
import { task } from '../fixture';
import type { Scenario } from '../scenario';
import { seedTasks, syncIdle, syncOk } from './util';

const P1 = { project_id: ['p1'] } as const;

export const backupRestoreScenarios: readonly Scenario[] = [
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
