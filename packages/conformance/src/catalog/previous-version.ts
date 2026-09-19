/**
 * RFC 0005 previous-version context (§7.4.6).
 *
 * A schema bump wipes the local replica before the server can re-bootstrap it.
 * Opted in, the §7.4.3 reset captures a bounded typed copy of the pre-bump rows
 * so the app can still answer "what did this look like before the upgrade"
 * while the replacement bootstrap is in flight. The container lives in a second
 * database file beside the replica; the ordinary query connection never
 * attaches it.
 *
 * These scenarios run on BOTH cores through the driver seam only: the feature
 * config, the read surface, the audit and the discard. A driver that lacks the
 * commands SKIPS (never a silent pass).
 */
import { check, checkEqual } from '../checks';
import type { ClientInstance } from '../driver';
import {
  FIXTURE_SCHEMA_V2,
  FIXTURE_SCHEMA_V2_DROP_META,
  task,
} from '../fixture';
import {
  type ClientHandle,
  ScenarioSkip,
  type Scenario,
  type ScenarioContext,
} from '../scenario';
import { seedTasks, syncIdle, syncOk } from './util';

const P1 = { project_id: ['p1'] } as const;

/** The feature flag under test; budgets left at the core defaults. */
const PREVIOUS_VERSION = { enabled: true } as const;

function requirePreviousVersion(api: ClientInstance): void {
  if (
    api.previousVersionSnapshot === undefined ||
    api.previousVersionAudit === undefined ||
    api.previousVersionDiscard === undefined
  ) {
    throw new ScenarioSkip(
      'client driver lacks the RFC 0005 previous-version commands',
    );
  }
}

/**
 * A v1 client that is already at the v2 floor, with one offline v1 row in its
 * mirror. The offline write is the pre-bump content the container must retain;
 * the floor stop is why nothing was bootstrapped into the v1 mirror first.
 */
async function flooredClientWithOfflineRow(
  ctx: ScenarioContext,
  options: { readonly previousVersionContext?: { readonly enabled: boolean } },
): Promise<{ readonly handle: ClientHandle; readonly commitId: string }> {
  const handle = await ctx.newClient({
    actorId: 'actor-a',
    clientId: 'client-a',
    allowed: P1,
    ...(options.previousVersionContext !== undefined
      ? { previousVersionContext: options.previousVersionContext }
      : {}),
  });
  requirePreviousVersion(handle.api);
  await handle.api.subscribe({ id: 'tasks', table: 'tasks', scopes: P1 });
  const floored = await syncOk(handle);
  checkEqual(
    floored.schemaFloor?.requiredSchemaVersion,
    2,
    'the v1 client stops at the v2 floor (§1.6)',
  );
  const commitId = await handle.api.mutate([
    {
      op: 'upsert',
      table: 'tasks',
      values: task('t2', 'p1', 'local-before-bump'),
    },
  ]);
  return { handle, commitId };
}

export const previousVersionScenarios: readonly Scenario[] = [
  {
    // RFC 0005 D8: the feature flag defaults OFF. A bump captures nothing and
    // the read surface reports `not-configured` — the 0.22.0 behaviour plus the
    // descriptor write and the unconditional orphan sweep.
    name: 'previous-version/default-off-is-not-configured',
    specRefs: ['§7.4.6', '§7.4.3'],
    server: { schema: FIXTURE_SCHEMA_V2 },
    async run(ctx) {
      await seedTasks(ctx, [task('t1', 'p1', 'server-v2')]);
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: P1,
      });
      requirePreviousVersion(a.api);
      await a.api.subscribe({ id: 'tasks', table: 'tasks', scopes: P1 });
      await syncOk(a);

      // App update with no opt-in: the reset runs, the feature stays off.
      await ctx.recreateClient(a, FIXTURE_SCHEMA_V2);
      const snapshot = await a.api.previousVersionSnapshot?.({
        table: 'tasks',
      });
      check(snapshot !== undefined, 'the driver exposes the read surface');
      checkEqual(snapshot?.available, false, 'no container is available');
      checkEqual(
        snapshot?.reason,
        'not-configured',
        'default-off reports not-configured',
      );
      checkEqual(
        snapshot?.state,
        'previousVersion',
        'state is always previousVersion',
      );
      checkEqual(snapshot?.rows, [], 'no rows are exposed');
    },
  },

  {
    // RFC 0005 D7 acceptance 2: opt-in capture after a schema bump returns the
    // pre-bump row, tagged with the OLD version and the running version.
    name: 'previous-version/opt-in-bump-captures-pre-bump-row',
    specRefs: ['§7.4.6', '§7.4.3'],
    server: { schema: FIXTURE_SCHEMA_V2 },
    async run(ctx) {
      await seedTasks(ctx, [task('t1', 'p1', 'server-v2')]);
      const { handle: a } = await flooredClientWithOfflineRow(ctx, {
        previousVersionContext: PREVIOUS_VERSION,
      });

      // "App ships new code": the v2 reset captures the pre-bump mirror.
      await ctx.recreateClient(a, FIXTURE_SCHEMA_V2);
      const snapshot = await a.api.previousVersionSnapshot?.({
        table: 'tasks',
      });
      checkEqual(snapshot?.available, true, 'the opt-in capture is available');
      checkEqual(
        snapshot?.state,
        'previousVersion',
        'state is previousVersion',
      );
      checkEqual(
        snapshot?.previousVersion,
        1,
        'the capture names the old version',
      );
      checkEqual(
        snapshot?.currentVersion,
        2,
        'the capture names the running version',
      );
      check(
        snapshot?.previousVersion !== snapshot?.currentVersion,
        'previousVersion differs from currentVersion',
      );
      checkEqual(
        snapshot?.rows,
        [
          {
            id: 't2',
            project_id: 'p1',
            title: 'local-before-bump',
            done: false,
            priority: null,
            meta: null,
          },
        ],
        'the pre-bump row round-trips through the container',
      );
      checkEqual(snapshot?.truncated, false, 'one row is not truncated');
    },
  },

  {
    // RFC 0005 A2/D9: the executable downgrade step is idempotent — the first
    // call removes the container and both metadata records, the second is a
    // no-op that reports absence rather than failure.
    name: 'previous-version/discard-is-idempotent',
    specRefs: ['§7.4.6', '§7.4.3'],
    server: { schema: FIXTURE_SCHEMA_V2 },
    async run(ctx) {
      await seedTasks(ctx, [task('t1', 'p1', 'server-v2')]);
      const { handle: a } = await flooredClientWithOfflineRow(ctx, {
        previousVersionContext: PREVIOUS_VERSION,
      });
      await ctx.recreateClient(a, FIXTURE_SCHEMA_V2);

      checkEqual(
        await a.api.previousVersionDiscard?.(),
        { present: true, discarded: true },
        'the first discard removes a present container',
      );
      checkEqual(
        await a.api.previousVersionDiscard?.(),
        { present: false, discarded: false },
        'the second discard is a no-op',
      );
      // The read surface agrees: nothing is left to read.
      const snapshot = await a.api.previousVersionSnapshot?.({
        table: 'tasks',
      });
      checkEqual(
        snapshot?.available,
        false,
        'no container survives the discard',
      );
    },
  },

  {
    // RFC 0005 D7: coverage completion is a lifetime trigger. Once the
    // replacement bootstrap is complete the container is discarded and the read
    // names `coverage-complete` — a lifecycle drop, not just a closed read.
    name: 'previous-version/coverage-completion-drops-container',
    specRefs: ['§7.4.6', '§7.4.5'],
    server: { schema: FIXTURE_SCHEMA_V2 },
    async run(ctx) {
      await seedTasks(ctx, [task('t1', 'p1', 'server-v2')]);
      const { handle: a } = await flooredClientWithOfflineRow(ctx, {
        previousVersionContext: PREVIOUS_VERSION,
      });
      await ctx.recreateClient(a, FIXTURE_SCHEMA_V2);

      // Readable while the replacement bootstrap is in flight.
      const before = await a.api.previousVersionSnapshot?.({ table: 'tasks' });
      checkEqual(before?.available, true, 'capture readable before coverage');

      // Re-bootstrap to completion; the next round's lifetime check discards.
      const upgraded = await syncIdle(a);
      checkEqual(upgraded.schemaFloor, undefined, 'converged at v2');
      const after = await a.api.previousVersionSnapshot?.({ table: 'tasks' });
      checkEqual(
        after?.available,
        false,
        'coverage completion closed the read',
      );
      checkEqual(
        after?.reason,
        'coverage-complete',
        'the lifecycle drop returns its reason',
      );
      checkEqual(
        await a.api.previousVersionDiscard?.(),
        { present: false, discarded: false },
        'the container is already gone',
      );
    },
  },

  {
    // RFC 0005 D6: the advisory pre-reset audit names the pending commit that
    // cannot re-encode under the new schema, with a typed reason and the
    // offending column only — never an operation or a row value.
    name: 'previous-version/audit-names-incompatible-commit',
    specRefs: ['§7.4.6', '§7.4.4'],
    server: { schema: FIXTURE_SCHEMA_V2_DROP_META },
    async run(ctx) {
      const { handle: a, commitId } = await flooredClientWithOfflineRow(ctx, {
        previousVersionContext: PREVIOUS_VERSION,
      });
      await ctx.recreateClient(a, FIXTURE_SCHEMA_V2_DROP_META);

      const audit = await a.api.previousVersionAudit?.();
      check(audit !== undefined, 'the audit is recorded on the reset');
      checkEqual(audit?.fromVersion, 1, 'the audit names the old version');
      checkEqual(audit?.toVersion, 2, 'the audit names the new version');
      checkEqual(audit?.pending, 1, 'one pending commit was examined');
      checkEqual(
        audit?.encodable,
        0,
        'the meta-carrying commit is incompatible',
      );
      checkEqual(audit?.truncated, false, 'one entry is not truncated');
      checkEqual(
        audit?.incompatible,
        [
          {
            commitId,
            table: 'tasks',
            reason: 'unknown-column',
            column: 'meta',
          },
        ],
        'the audit names the commit, table, reason and column only',
      );
    },
  },
];
