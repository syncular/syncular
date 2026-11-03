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
import type { DriverSchema, ValidatorInstallSpec } from '../driver';
import { task } from '../fixture';
import type { Scenario, ScenarioContext } from '../scenario';
import { expectConverged, syncFails, syncIdle, syncOk } from './util';

const P1 = { project_id: ['p1'] } as const;

/** The host code the max-length rule rejects with — a non-reserved prefix
 * (§6.7): distinguishable from every `sync.*`/`blob.*` protocol code. */
const TITLE_CODE = 'app.title_too_long';
/** The host code the immutable-transition rule rejects with. */
const IMMUTABLE_CODE = 'app.done_task_frozen';
const NUMERIC_SCOPE_SCHEMA: DriverSchema = {
  version: 1,
  tables: [
    {
      name: 'measurements',
      primaryKey: 'id',
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'scope_num', type: 'float', nullable: false },
        { name: 'title', type: 'string', nullable: false },
      ],
      scopes: [{ pattern: 'measurement:{scope_num}' }],
    },
  ],
};

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
    name: 'validators/rejected-base-waits-for-a-complete-pull',
    specRefs: ['§7.2', '§7.2.1', '§7.7'],
    requires: ['validators', 'scope-authorization'],
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
      const winner = await bootstrapped(ctx, 'fresh-winner', 'fresh-winner');
      const reader = await ctx.newClient({
        actorId: 'fresh-reader',
        clientId: 'fresh-reader',
        allowed: P1,
        retainFailedCommits: true,
      });
      await reader.api.subscribe({ id: 'tasks', table: 'tasks', scopes: P1 });
      await winner.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('t1', 'p1', 'old') },
      ]);
      await syncIdle(winner);
      await syncIdle(reader);
      await winner.api.patch('tasks', 't1', { title: 'winner' });
      await syncIdle(winner);
      const rejected = await reader.api.patch('tasks', 't1', {
        title: 'invalid-too-long',
      });
      reader.faults.deferNextPulls = 3;
      checkEqual(
        (await syncOk(reader)).rejected,
        [rejected],
        'the validator rejection is retained',
      );
      checkEqual(
        (await reader.api.commitOutcomes()).find(
          (outcome) => outcome.clientCommitId === rejected,
        )?.retainedRows?.[0]?.serverRow?.title,
        'old',
        'the before-image is visible while the pull is withheld',
      );
      check(
        await reader.api.syncNeeded(),
        'the omitted subscription requests a new pull',
      );
      const limited = await reader.api.syncUntilIdle(1);
      check(limited.ok, 'the bounded refresh completes its round');
      if (!limited.ok) return;
      check(
        limited.budgetExhausted === true,
        'a withheld pull cannot report idle',
      );
      checkEqual(
        await reader.api.proveCurrentBase(rejected, 1),
        {
          proven: false,
          reason: 'budget_exhausted',
        },
        'proof fails atomically while the pull is withheld',
      );
      reader.faults.dropNextRequests = 1;
      checkEqual(
        await reader.api.proveCurrentBase(rejected),
        {
          proven: false,
          reason: 'sync_failed',
        },
        'proof reports a failed drive without row data',
      );
      reader.faults.dropNextRequests = 1;
      await syncFails(reader, 'transport.lost', 'offline refresh');
      checkEqual(
        (await reader.api.commitOutcomes()).find(
          (outcome) => outcome.clientCommitId === rejected,
        )?.retainedRows?.[0]?.serverRow?.title,
        'old',
        'failed refresh keeps the prior base and intent',
      );
      await ctx.recreateClient(reader, ctx.schema);
      const proof = await reader.api.proveCurrentBase(rejected);
      check(proof.proven, 'a complete drive proves the base after restart');
      if (!proof.proven) return;
      checkEqual(
        proof.rows[0]?.serverRow?.title,
        'winner',
        'proof reads the winning row',
      );
      checkEqual(
        (await reader.api.commitOutcomes()).find(
          (outcome) => outcome.clientCommitId === rejected,
        )?.retainedRows?.[0]?.serverRow?.title,
        'winner',
        'a fresh idle drive delivers the winning base after restart',
      );
      const replacement = await reader.api.patch('tasks', 't1', {
        title: 'mine',
      });
      await reader.api.resolveCommitOutcome(
        rejected,
        'superseded',
        replacement,
      );
      await syncIdle(reader);
      await syncIdle(winner);
      await winner.api.patch('tasks', 't1', { title: 'winner2' });
      await syncIdle(winner);
      const second = await reader.api.patch('tasks', 't1', {
        title: 'invalid-again',
      });
      reader.faults.deferNextPulls = 1;
      checkEqual(
        (await syncOk(reader)).rejected,
        [second],
        'a second distinct-actor conflict is retained',
      );
      checkEqual(
        (await reader.api.commitOutcomes()).find(
          (outcome) => outcome.clientCommitId === second,
        )?.retainedRows?.[0]?.serverRow?.title,
        'mine',
        'the second rejection initially holds the prior delivered base',
      );
      await syncIdle(reader);
      checkEqual(
        (await reader.api.commitOutcomes()).find(
          (outcome) => outcome.clientCommitId === second,
        )?.retainedRows?.[0]?.serverRow?.title,
        'winner2',
        'the second catch-up delivers its winning base',
      );
      await ctx.server.setAllowedScopes('fresh-reader', { project_id: [] });
      checkEqual(
        await reader.api.proveCurrentBase(second),
        {
          proven: false,
          reason: 'revoked',
        },
        'revocation returns no row evidence',
      );
      checkEqual(
        (await reader.api.commitOutcomes()).find(
          (outcome) => outcome.clientCommitId === second,
        )?.retainedRows,
        undefined,
        'revocation removes retained row evidence',
      );
    },
  },
  {
    name: 'validators/prove-all-aggregate-bases',
    specRefs: ['§7.2.1', '§7.5', '§7.7'],
    requires: ['validators', 'scope-authorization'],
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
      const writer = await bootstrapped(
        ctx,
        'aggregate-writer',
        'aggregate-writer',
      );
      const reader = await ctx.newClient({
        actorId: 'aggregate-reader',
        clientId: 'aggregate-reader',
        allowed: P1,
        retainFailedCommits: true,
      });
      await reader.api.subscribe({ id: 'tasks', table: 'tasks', scopes: P1 });
      await writer.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('a', 'p1', 'old') },
        { op: 'upsert', table: 'tasks', values: task('b', 'p1', 'old') },
      ]);
      await syncIdle(writer);
      await syncIdle(reader);
      await writer.api.patch('tasks', 'a', { title: 'new-a' });
      await writer.api.patch('tasks', 'b', { title: 'new-b' });
      await syncIdle(writer);
      const rejected = await reader.api.mutate([
        {
          op: 'upsert',
          table: 'tasks',
          values: task('a', 'p1', 'too-long-to-accept'),
        },
        { op: 'upsert', table: 'tasks', values: task('b', 'p1', 'mine') },
      ]);
      reader.faults.deferNextPulls = 2;
      await syncOk(reader);
      checkEqual(
        await reader.api.proveCurrentBase(rejected, 1),
        { proven: false, reason: 'budget_exhausted' },
        'no partial aggregate proof',
      );
      const proof = await reader.api.proveCurrentBase(rejected);
      check(proof.proven, 'both aggregate bases are proven');
      if (!proof.proven) return;
      checkEqual(
        proof.rows.map((row) => row.serverRow?.title),
        ['new-a', 'new-b'],
        'both current bases come from the same proof',
      );
      checkEqual(
        proof.rows.map((row) => row.serverVersion),
        [2, 2],
        'both server versions are returned',
      );
    },
  },
  {
    name: 'validators/prove-aggregate-requires-every-scope',
    specRefs: ['§3.3', '§7.2.1', '§7.5'],
    requires: ['validators', 'scope-authorization'],
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
      const grants = { project_id: ['p1', 'p2'] };
      const writer = await ctx.newClient({
        actorId: 'coverage-writer',
        clientId: 'coverage-writer',
        allowed: grants,
      });
      const reader = await ctx.newClient({
        actorId: 'coverage-reader',
        clientId: 'coverage-reader',
        allowed: grants,
        retainFailedCommits: true,
      });
      await writer.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('a', 'p1', 'server-a') },
        { op: 'upsert', table: 'tasks', values: task('b', 'p2', 'server-b') },
      ]);
      await syncIdle(writer);
      await reader.api.subscribe({
        id: 'p1',
        table: 'tasks',
        scopes: { project_id: ['p1'] },
      });
      await syncIdle(reader);
      const rejected = await reader.api.mutate([
        {
          op: 'upsert',
          table: 'tasks',
          values: task('a', 'p1', 'too-long-to-accept'),
        },
        { op: 'upsert', table: 'tasks', values: task('b', 'p2', 'mine') },
      ]);
      await syncIdle(reader);
      checkEqual(
        await reader.api.proveCurrentBase(rejected),
        { proven: false, reason: 'missing_coverage' },
        'one uncovered row prevents any aggregate result',
      );
      await reader.api.subscribe({
        id: 'p2',
        table: 'tasks',
        scopes: { project_id: ['p2'] },
      });
      const proof = await reader.api.proveCurrentBase(rejected);
      check(proof.proven, 'separate subscriptions cover both retained rows');
      if (!proof.proven) return;
      checkEqual(
        proof.rows.map((row) => row.serverRow?.title),
        ['server-a', 'server-b'],
        'each authorized base is returned',
      );
      await ctx.server.setAllowedScopes('coverage-reader', P1);
      checkEqual(
        await reader.api.proveCurrentBase(rejected),
        { proven: false, reason: 'revoked' },
        'loss of one aggregate scope returns no rows',
      );
    },
  },
  {
    name: 'validators/prove-numeric-scope-values',
    specRefs: ['§3.1', '§7.2.1'],
    requires: ['validators', 'scope-authorization'],
    server: { schema: NUMERIC_SCOPE_SCHEMA },
    async run(ctx) {
      await install(ctx, [
        {
          table: 'measurements',
          rule: {
            kind: 'maxLength',
            column: 'title',
            max: 10,
            code: TITLE_CODE,
          },
        },
      ]);
      const scopes = { scope_num: ['1', '1e+21', '1e-7'] };
      const writer = await ctx.newClient({
        actorId: 'numeric-writer',
        clientId: 'numeric-writer',
        schema: NUMERIC_SCOPE_SCHEMA,
        allowed: scopes,
      });
      await writer.api.mutate([
        {
          op: 'upsert',
          table: 'measurements',
          values: { id: 'a', scope_num: 1, title: 'server' },
        },
        {
          op: 'upsert',
          table: 'measurements',
          values: { id: 'b', scope_num: 1e21, title: 'server' },
        },
        {
          op: 'upsert',
          table: 'measurements',
          values: { id: 'c', scope_num: 1e-7, title: 'server' },
        },
      ]);
      await syncIdle(writer);
      const client = await ctx.newClient({
        actorId: 'numeric-reader',
        clientId: 'numeric-reader',
        schema: NUMERIC_SCOPE_SCHEMA,
        allowed: scopes,
        retainFailedCommits: true,
      });
      await client.api.subscribe({
        id: 'numbers',
        table: 'measurements',
        scopes,
      });
      await syncIdle(client);
      const id = await client.api.mutate([
        {
          op: 'upsert',
          table: 'measurements',
          values: { id: 'a', scope_num: 1, title: 'too-long-to-accept' },
        },
        {
          op: 'upsert',
          table: 'measurements',
          values: { id: 'b', scope_num: 1e21, title: 'mine' },
        },
        {
          op: 'upsert',
          table: 'measurements',
          values: { id: 'c', scope_num: 1e-7, title: 'mine' },
        },
      ]);
      await syncIdle(client);
      const proof = await client.api.proveCurrentBase(id);
      check(
        proof.proven,
        'the complete numeric scope covers every retained row',
      );
      if (proof.proven)
        checkEqual(proof.rows.length, 3, 'all three rows are returned');
    },
  },
  {
    name: 'validators/unexpected-error-retries-as-static-rejection',
    specRefs: ['§6.3', '§6.7', '§2.3'],
    requires: ['validators'],
    async run(ctx) {
      await install(ctx, [
        {
          table: 'tasks',
          rule: {
            kind: 'unexpectedError',
            message: 'synthetic-private-validator-token',
          },
        },
      ]);
      const a = await bootstrapped(ctx, 'actor-a', 'client-a');
      const commit = await a.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('failed', 'p1') },
      ]);
      a.faults.dropNextResponses = 1;
      await syncFails(a, 'transport.lost', 'lost sanitized rejection');
      checkEqual(
        (await syncIdle(a)).rejected,
        [commit],
        'cached rejection drains the outbox',
      );
      checkEqual(
        (await a.api.rejections())[0]?.code,
        'sync.constraint_violation',
        'both clients retain the static public code',
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
