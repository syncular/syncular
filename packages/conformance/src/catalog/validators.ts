/**
 * Server-side write-validation hooks (SPEC.md §6.7): an optional per-table
 * validator runs after decode + §3.4 scope authorization, inside the
 * commit transaction. A throw rejects the whole commit atomically (§6.4)
 * with a host-defined code the client surfaces unchanged in its rejection
 * record (§6.3) — proven on BOTH cores (the scenarios run in each pairing).
 *
 * The validators are installed on the server under test through the
 * JSON-able `installValidators` seam; the ts-server driver compiles each
 * declarative rule into the real host callback the library runs. There is
 * no Rust server in any pairing, so validation enforcement is TS-server
 * only by construction — what the Rust core must prove is that it surfaces
 * the host code unchanged, which is exactly what these client-driven
 * scenarios assert.
 */
import { check, checkEqual } from '../checks';
import type { ValidatorInstallSpec } from '../driver';
import { task } from '../fixture';
import type { Scenario, ScenarioContext } from '../scenario';
import { expectConverged, syncIdle, syncOk } from './util';

const P1 = { project_id: ['p1'] } as const;

/** The host code the max-length rule rejects with — a non-reserved prefix
 * (§6.7): distinguishable from every `sync.*`/`blob.*` protocol code. */
const TITLE_CODE = 'app.title_too_long';
/** The host code the immutable-transition rule rejects with. */
const IMMUTABLE_CODE = 'app.done_task_frozen';

async function install(
  ctx: ScenarioContext,
  specs: readonly ValidatorInstallSpec[],
): Promise<void> {
  check(
    ctx.server.installValidators !== undefined,
    'the validators capability requires installValidators',
  );
  await ctx.server.installValidators?.(specs);
}

async function bootstrapped(
  ctx: ScenarioContext,
  actorId: string,
  clientId: string,
) {
  const handle = await ctx.newClient({ actorId, clientId, allowed: P1 });
  await handle.api.subscribe({ id: 'tasks', table: 'tasks', scopes: P1 });
  await syncIdle(handle);
  return handle;
}

export const validatorScenarios: readonly Scenario[] = [
  {
    // A validator rejects: the commit rolls back atomically (its sibling
    // insert with it, §6.4) and the host code surfaces in the client's
    // rejection record on both cores (§6.3, §6.7).
    name: 'validators/reject-rolls-back-with-host-code',
    specRefs: ['§6.3', '§6.4', '§6.7'],
    requires: ['validators'],
    async run(ctx) {
      await install(ctx, [
        {
          table: 'tasks',
          rule: {
            kind: 'maxLength',
            column: 'title',
            max: 10,
            code: TITLE_CODE,
          },
        },
      ]);
      const a = await bootstrapped(ctx, 'actor-a', 'client-a');

      await a.api.mutate([
        {
          op: 'upsert',
          table: 'tasks',
          values: task('existing', 'p1', 'accepted'),
        },
      ]);
      await syncOk(a);

      // One commit: a too-long update of a confirmed row (rejected by the
      // validator) plus a sibling insert. §6.4 rolls the WHOLE commit back.
      const commit = await a.api.mutate([
        {
          op: 'upsert',
          table: 'tasks',
          values: task(
            'existing',
            'p1',
            'this title is definitely over ten chars',
          ),
        },
        { op: 'upsert', table: 'tasks', values: task('sibling', 'p1', 'ok') },
      ]);
      const report = await syncIdle(a);
      checkEqual(report.rejected, [commit], 'the whole commit was rejected');

      const rejection = (await a.api.rejections())[0];
      checkEqual(
        rejection?.code,
        TITLE_CODE,
        'the host validation code surfaces unchanged in the rejection record (§6.7)',
      );
      checkEqual(
        rejection?.opIndex,
        0,
        'the rejection points at the terminating operation (§6.3)',
      );
      checkEqual(
        rejection?.retryable,
        false,
        'a validation rejection is not retryable',
      );
      checkEqual(
        rejection?.details,
        {
          fieldPaths: ['title'],
          reason: 'max_length_exceeded',
          requiredAction: 'edit_fields',
        },
        'bounded structured correction details round-trip on both client cores',
      );

      // §6.4: NOTHING from the commit reached storage — the sibling insert
      // rolled back and the prior row stayed accepted.
      checkEqual(
        (await ctx.server.readRows('tasks')).map((row) => ({
          rowId: row.rowId,
          title: row.values.title,
        })),
        [{ rowId: 'existing', title: 'accepted' }],
        'the whole commit rolled back atomically on the server',
      );
      checkEqual(
        (await a.api.readRows('tasks')).map((row) => ({
          rowId: row.rowId,
          title: row.values.title,
        })),
        [{ rowId: 'existing', title: 'accepted' }],
        'the rejected optimistic update and sibling disappear locally immediately (§7.2)',
      );
    },
  },

  {
    // A validator passes: the write applies and converges normally — the
    // hook is transparent when it accepts.
    name: 'validators/accept-applies-and-converges',
    specRefs: ['§6.4', '§6.7'],
    requires: ['validators'],
    async run(ctx) {
      await install(ctx, [
        {
          table: 'tasks',
          rule: {
            kind: 'maxLength',
            column: 'title',
            max: 10,
            code: TITLE_CODE,
          },
        },
      ]);
      const a = await bootstrapped(ctx, 'actor-a', 'client-a');
      const b = await bootstrapped(ctx, 'actor-b', 'client-b');

      const commit = await a.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('ok1', 'p1', 'short') },
      ]);
      const report = await syncOk(a);
      checkEqual(report.rejected, [], 'an accepted write is not rejected');
      checkEqual(
        (await a.api.rejections()).length,
        0,
        'no rejection record for an accepted write',
      );
      check(report.applied.includes(commit), 'the accepted commit applied');
      // The write drained from the outbox — it was accepted, not deferred.
      checkEqual(
        (await a.api.pendingCommitIds()).includes(commit),
        false,
        'the accepted commit left the outbox',
      );

      await syncIdle(a);
      await syncIdle(b);
      const rows = (await ctx.server.readRows('tasks')).map((r) => r.rowId);
      checkEqual(rows, ['ok1'], 'the accepted row landed server-side');
      await expectConverged(ctx, 'tasks', [a, b], {
        variable: 'project_id',
        values: ['p1'],
      });
    },
  },

  {
    // Validator OFF (none installed): behavior is unchanged — a title that
    // would violate the rule applies, because no validator is configured.
    // Proves the feature is off by default and adds nothing when absent.
    name: 'validators/off-is-unchanged',
    specRefs: ['§6.7'],
    requires: ['validators'],
    async run(ctx) {
      // Deliberately install NOTHING (empty ⇒ feature off).
      await install(ctx, []);
      const a = await bootstrapped(ctx, 'actor-a', 'client-a');

      const commit = await a.api.mutate([
        {
          op: 'upsert',
          table: 'tasks',
          values: task(
            'long',
            'p1',
            'a very long title that would fail a maxLength rule',
          ),
        },
      ]);
      const report = await syncOk(a);
      check(
        report.applied.includes(commit),
        'with no validator, the write applies',
      );
      checkEqual(
        (await a.api.rejections()).length,
        0,
        'no rejection when the feature is off',
      );
      checkEqual(
        (await ctx.server.readRows('tasks')).map((r) => r.rowId),
        ['long'],
        'the row landed unvalidated',
      );
    },
  },

  {
    // The validator sees the STORED row on an update (the transition-rule
    // proof): a task frozen once `done` becomes true — the validator reads
    // op.stored to enforce it. The insert and the toggle-to-done both pass;
    // a later title change on the now-done row is rejected.
    name: 'validators/sees-stored-row-on-update',
    specRefs: ['§6.7'],
    requires: ['validators'],
    async run(ctx) {
      await install(ctx, [
        {
          table: 'tasks',
          rule: {
            kind: 'immutableWhen',
            column: 'title',
            guardColumn: 'done',
            guardValue: true,
            code: IMMUTABLE_CODE,
          },
        },
      ]);
      const a = await bootstrapped(ctx, 'actor-a', 'client-a');

      // Insert (stored = undefined ⇒ rule does not fire) then mark done.
      await a.api.mutate([
        {
          op: 'upsert',
          table: 'tasks',
          values: task('t1', 'p1', 'first', false),
        },
      ]);
      await syncIdle(a);
      const done = await a.api.mutate([
        {
          op: 'upsert',
          table: 'tasks',
          values: task('t1', 'p1', 'first', true),
        },
      ]);
      const report1 = await syncOk(a);
      check(report1.applied.includes(done), 'marking the task done applies');
      await syncIdle(a);

      // Now change the title of the DONE row: the validator reads the
      // stored row (done === true) and rejects the transition (§6.7).
      const rename = await a.api.mutate([
        {
          op: 'upsert',
          table: 'tasks',
          values: task('t1', 'p1', 'renamed', true),
        },
      ]);
      const report2 = await syncIdle(a);
      checkEqual(
        report2.rejected,
        [rename],
        'the title change on a done task is rejected',
      );
      const rejection = (await a.api.rejections())[0];
      checkEqual(
        rejection?.code,
        IMMUTABLE_CODE,
        'the stored-row transition rule surfaces its host code (§6.7)',
      );

      // The stored row is untouched: title still "first", done still true.
      const rows = await ctx.server.readRows('tasks');
      checkEqual(rows.length, 1, 'exactly one row');
      checkEqual(
        rows[0]?.values.title,
        'first',
        'the rejected update did not change the row',
      );
      checkEqual(rows[0]?.values.done, true, 'the row is still done');
    },
  },
];
