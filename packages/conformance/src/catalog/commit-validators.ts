/** Whole-commit host validation (SPEC.md §6.8). */
import { check, checkEqual } from '../checks';
import type { CommitValidatorInstallSpec } from '../driver';
import { task } from '../fixture';
import type { Scenario, ScenarioContext } from '../scenario';
import { syncIdle, syncOk } from './util';

const P1 = { project_id: ['p1'] } as const;
const AUDIT_CODE = 'app.completion_audit_required';

async function install(
  ctx: ScenarioContext,
  spec?: CommitValidatorInstallSpec,
): Promise<void> {
  check(
    ctx.server.installCommitValidator !== undefined,
    'the commit-validators capability requires installCommitValidator',
  );
  await ctx.server.installCommitValidator?.(spec);
}

async function bootstrapped(ctx: ScenarioContext) {
  const handle = await ctx.newClient({
    actorId: 'actor-a',
    clientId: 'client-a',
    allowed: P1,
  });
  await handle.api.subscribe({ id: 'tasks', table: 'tasks', scopes: P1 });
  await syncIdle(handle);
  return handle;
}

export const commitValidatorScenarios: readonly Scenario[] = [
  {
    name: 'commit-validators/requires-sibling-and-rolls-back-candidate',
    specRefs: ['§6.3', '§6.4', '§6.8'],
    requires: ['commit-validators'],
    async run(ctx) {
      await install(ctx, {
        kind: 'requireSiblingWhen',
        table: 'tasks',
        column: 'done',
        equals: true,
        siblingRowIdSuffix: '-audit',
        code: AUDIT_CODE,
      });
      const a = await bootstrapped(ctx);

      const rejectedCommit = await a.api.mutate([
        {
          op: 'upsert',
          table: 'tasks',
          values: task('t1', 'p1', 'completed', true),
        },
        {
          op: 'upsert',
          table: 'tasks',
          values: task('ordinary-sibling', 'p1', 'ordinary', false),
        },
      ]);
      const rejectedReport = await syncIdle(a);
      checkEqual(
        rejectedReport.rejected,
        [rejectedCommit],
        'the aggregate commit is rejected',
      );
      checkEqual(
        (await ctx.server.readRows('tasks')).length,
        0,
        'all candidate rows roll back atomically',
      );
      const rejection = (await a.api.rejections())[0];
      checkEqual(
        rejection?.code,
        AUDIT_CODE,
        'the host code survives unchanged',
      );
      checkEqual(
        rejection?.opIndex,
        0,
        'the aggregate failure identifies its trigger',
      );
      checkEqual(
        rejection?.retryable,
        false,
        'the aggregate rejection is not retryable',
      );
      checkEqual(
        rejection?.details,
        {
          fieldPaths: ['done'],
          reason: 'missing_sibling_operation',
          requiredAction: 'repair_aggregate',
        },
        'both client cores preserve the structured repair hint',
      );

      const acceptedCommit = await a.api.mutate([
        {
          op: 'upsert',
          table: 'tasks',
          values: task('t2', 'p1', 'completed', true),
        },
        {
          op: 'upsert',
          table: 'tasks',
          values: task('t2-audit', 'p1', 'audit', false),
        },
      ]);
      const acceptedReport = await syncOk(a);
      check(
        acceptedReport.applied.includes(acceptedCommit),
        'the aggregate with its required sibling applies',
      );
      checkEqual(
        (await ctx.server.readRows('tasks')).map((row) => row.rowId),
        ['t2', 't2-audit'],
        'the accepted aggregate lands together',
      );
    },
  },
];
