import { check, checkEqual } from '../checks';
import { ALL_SCOPES, task } from '../fixture';
import { rawPushCommit, rawUpsert, responsePushResults } from '../raw';
import type { Scenario } from '../scenario';

export const remoteProducerScenarios: readonly Scenario[] = [
  {
    name: 'remote-producer/push-only-idempotency',
    specRefs: ['§6.9', '§2.3', '§6.4'],
    async run(ctx) {
      await ctx.server.setAllowedScopes('worker', ALL_SCOPES);
      const frames = [
        rawPushCommit('job-42', [
          rawUpsert(
            ctx.serverSchema,
            'tasks',
            task('task-42', 'p1', 'database-less'),
          ),
        ]),
      ];
      const options = {
        clientId: 'headless-producer',
        schemaVersion: ctx.serverSchema.version,
      };
      const first = await ctx.rawSync('worker', frames, options);
      check(first.ok, 'push-only request applies without a pull section');
      if (!first.ok) return;
      checkEqual(
        responsePushResults(first.message)[0]?.status,
        'applied',
        'first delivery applies',
      );
      const replay = await ctx.rawSync('worker', frames, options);
      check(replay.ok, 'identical push-only retry succeeds');
      if (!replay.ok) return;
      checkEqual(
        responsePushResults(replay.message)[0]?.status,
        'cached',
        'identical push-only retry is cached',
      );
      checkEqual(
        await ctx.server.getMaxCommitSeq(),
        1,
        'retry allocated no second commit sequence',
      );
    },
  },
];
