/** Whole-commit host validation (SPEC.md §6.8). */
import { check, checkEqual } from '../checks';
import type { CommitValidatorInstallSpec } from '../driver';
import { task } from '../fixture';
import type { Scenario, ScenarioContext } from '../scenario';
import { syncFails, syncIdle, syncOk } from './util';

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
  {
    // Batch reads answer the same candidate state as single reads: a staged
    // upsert is present, a staged delete and an absent id are missing, and an
    // untouched stored row is present. Any disagreement rejects the commit.
    name: 'commit-validators/batch-read-matches-single-reads',
    specRefs: ['§6.3', '§6.8'],
    requires: ['commit-validators'],
    async run(ctx) {
      await install(ctx, {
        kind: 'rowsMatchSingles',
        table: 'tasks',
        extraRowId: 'stored-untouched',
        absentRowId: 'conformance-absent-row',
        code: 'app.get_rows_mismatch',
      });
      const a = await bootstrapped(ctx);
      await a.api.mutate([
        {
          op: 'upsert',
          table: 'tasks',
          values: task('stored-untouched', 'p1', 'untouched'),
        },
        {
          op: 'upsert',
          table: 'tasks',
          values: task('stored-deleted', 'p1', 'deleted'),
        },
      ]);
      await syncOk(a);

      const commit = await a.api.mutate([
        {
          op: 'upsert',
          table: 'tasks',
          values: task('staged', 'p1', 'staged'),
        },
        { op: 'delete', table: 'tasks', rowId: 'stored-deleted' },
      ]);
      const report = await syncOk(a);
      check(
        report.applied.includes(commit),
        'a batch read that matches single reads applies the commit',
      );
      checkEqual(
        (await ctx.server.readRows('tasks')).map((row) => row.rowId),
        ['staged', 'stored-untouched'],
        'the staged upsert lands and the staged delete stays absent',
      );
    },
  },
  {
    // An unexpected throw is a host fault, not a rule refusal: the client
    // sees the distinct `sync.validator_error` code, and the bounded thrown
    // message rides the §6.3.1 details on both cores. The cached rejection
    // replays the identical answer without re-running the validator.
    name: 'commit-validators/unexpected-throw-is-a-host-fault',
    specRefs: ['§6.3', '§6.4', '§6.8', '§10.2'],
    requires: ['commit-validators'],
    async run(ctx) {
      const thrown = 'synthetic-thrown-validator-token';
      await install(ctx, { kind: 'throwUnexpected', message: thrown });
      const a = await bootstrapped(ctx);
      const commit = await a.api.mutate([
        {
          op: 'upsert',
          table: 'tasks',
          values: task('t1', 'p1'),
        },
      ]);
      a.faults.dropNextResponses = 1;
      await syncFails(a, 'transport.lost', 'lost sanitized rejection');
      checkEqual(
        (await syncIdle(a)).rejected,
        [commit],
        'cached rejection drains the outbox',
      );
      const rejection = (await a.api.rejections())[0];
      checkEqual(
        rejection?.code,
        'sync.validator_error',
        'both clients surface the host-fault code',
      );
      checkEqual(rejection?.opIndex, 0, 'attributed to the first operation');
      checkEqual(
        rejection?.retryable,
        false,
        'the host fault is not retryable',
      );
      checkEqual(
        rejection?.details,
        {
          reason: 'validator_threw',
          references: { validator: 'commit', message: thrown },
        },
        'both clients preserve the bounded thrown message',
      );
      checkEqual(
        await ctx.server.readRows('tasks'),
        [],
        'unexpected failure writes no rows',
      );
      checkEqual(
        await a.api.pendingCommitIds(),
        [],
        'cached rejection consumes the pending commit',
      );
    },
  },
];
