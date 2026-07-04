/**
 * Scope grant, revocation + purge, write-path authorization, and segment
 * re-authorization (SPEC.md §3, §5.5; Appendix B.4). Scopes are the
 * crown jewels — these scenarios pin fail-loud and fail-closed behavior.
 */
import { canonicalScopeJson } from '@syncular-v2/core';
import { check, checkEqual } from '../checks';
import type { DriverSchema } from '../driver';
import { doc, FIXTURE_SCHEMA, task } from '../fixture';
import { rawPullHeader, rawSubscription, responseSection } from '../raw';
import type { Scenario } from '../scenario';
import { seedRows, seedTasks, syncIdle, syncOk } from './util';

export const scopeScenarios: readonly Scenario[] = [
  {
    name: 'scopes/effective-is-requested-intersect-allowed',
    specRefs: ['§3.2'],
    async run(ctx) {
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: { project_id: ['p1'] },
      });
      await seedTasks(ctx, [task('t1', 'p1'), task('t2', 'p2')]);
      // Requested wider than allowed: the intersection filters delivery.
      await a.api.subscribe({
        id: 'tasks',
        table: 'tasks',
        scopes: { project_id: ['p1', 'p2'] },
      });
      await syncIdle(a);
      checkEqual(
        (await a.api.readRows('tasks')).map((row) => row.rowId),
        ['t1'],
        'only rows inside the effective grant were delivered',
      );
      const state = await a.api.subscriptionState('tasks');
      checkEqual(
        state?.effectiveScopes,
        { project_id: ['p1'] },
        'the effective scopes were echoed and persisted (§3.2 rule 6)',
      );
    },
  },

  {
    name: 'scopes/revocation-purges-exactly-the-grant',
    specRefs: ['§3.3', '§3.4', 'B.4'],
    async run(ctx) {
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: { project_id: ['p1', 'p2'] },
      });
      await seedTasks(ctx, [
        task('t1', 'p1', 'one'),
        task('t2', 'p1', 'two'),
        task('t3', 'p2', 'keep'),
      ]);
      await a.api.subscribe({
        id: 'sub-p1',
        table: 'tasks',
        scopes: { project_id: ['p1'] },
      });
      await a.api.subscribe({
        id: 'sub-p2',
        table: 'tasks',
        scopes: { project_id: ['p2'] },
      });
      await syncIdle(a);
      checkEqual((await a.api.readRows('tasks')).length, 3, 'all rows synced');

      // The host revokes p1; a pending write into p1 is now doomed.
      await ctx.server.setAllowedScopes('actor-a', { project_id: ['p2'] });
      await a.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('t1', 'p1', 'doomed') },
      ]);
      const report = await syncOk(a);
      check(report.revoked.includes('sub-p1'), 'sub-p1 was revoked');
      checkEqual(
        (await a.api.subscriptionState('sub-p1'))?.status,
        'revoked',
        'the client stopped pulling the subscription',
      );
      checkEqual(
        (await a.api.subscriptionState('sub-p1'))?.reasonCode,
        'sync.scope_revoked',
        'reason code delivered via SUB_START (§10.2)',
      );
      checkEqual(
        (await a.api.readRows('tasks')).map((row) => row.rowId),
        ['t3'],
        "exactly the revoked grant's rows were purged; p2 rows untouched",
      );
      checkEqual(
        await a.api.pendingCommitIds(),
        [],
        'doomed outbox writes do not replay into guaranteed rejections',
      );
      const t1 = (await ctx.server.readRows('tasks')).find(
        (row) => row.rowId === 't1',
      );
      checkEqual(t1?.values.title, 'one', 'the doomed write never applied');
      // The still-granted subscription keeps syncing.
      await seedTasks(ctx, [task('t4', 'p2', 'new')]);
      await syncIdle(a);
      checkEqual(
        (await a.api.readRows('tasks')).map((row) => row.rowId),
        ['t3', 't4'],
        'p2 stays live after the p1 revocation',
      );
    },
  },

  {
    name: 'scopes/fail-closed-without-local-mapping',
    specRefs: ['§3.3', '§5.6'],
    async run(ctx) {
      // A client whose generated schema lacks the projectId mapping for
      // docs: precision or nothing — it must not clear-approximate.
      const brokenSchema: DriverSchema = {
        version: FIXTURE_SCHEMA.version,
        tables: FIXTURE_SCHEMA.tables.map((table) =>
          table.name === 'docs'
            ? { ...table, scopes: [{ pattern: 'org:{org_id}' }] }
            : table,
        ),
      };
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        schema: brokenSchema,
        allowed: { projectId: ['p1'], org_id: ['o1'] },
      });
      await seedRows(ctx, 'docs', [doc('d1', 'o1', 'p1')]);
      await a.api.subscribe({
        id: 'docs',
        table: 'docs',
        scopes: { projectId: ['p1'] },
      });
      const report = await syncOk(a);
      check(
        report.failed.includes('docs'),
        'the subscription failed closed as a fatal configuration error',
      );
      checkEqual(
        (await a.api.subscriptionState('docs'))?.status,
        'failed',
        'syncing the table stopped',
      );
      checkEqual(
        (await a.api.readRows('docs')).length,
        0,
        'nothing was applied or cleared by approximation',
      );
    },
  },

  {
    name: 'scopes/resolver-failure-fails-loud-and-closed',
    specRefs: ['§3.2', '§3.4'],
    async run(ctx) {
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: { project_id: ['p1'] },
      });
      await seedTasks(ctx, [task('t1', 'p1')]);
      await a.api.subscribe({
        id: 'tasks',
        table: 'tasks',
        scopes: { project_id: ['p1'] },
      });
      await syncIdle(a);

      await ctx.server.setResolverFailing(true);
      const m1 = await a.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('t2', 'p1', 'blocked') },
      ]);
      const report = await syncOk(a);
      checkEqual(
        report.rejected,
        [m1],
        'writes reject while authorization is broken (§3.4 step 4)',
      );
      checkEqual(
        (await a.api.rejections())[0]?.code,
        'sync.forbidden',
        'the write rejects with sync.forbidden, never applies blind',
      );
      check(
        report.revoked.includes('tasks'),
        'the subscription revokes — no data on resolver errors (§3.2 rule 5)',
      );
      checkEqual(
        await ctx.server.getMaxCommitSeq(),
        1,
        'only the seed commit exists server-side',
      );

      // Recovery: the host fixes the resolver; a fresh subscription syncs.
      await ctx.server.setResolverFailing(false);
      await a.api.subscribe({
        id: 'tasks-2',
        table: 'tasks',
        scopes: { project_id: ['p1'] },
      });
      await syncIdle(a);
      checkEqual(
        (await a.api.readRows('tasks')).map((row) => row.rowId),
        ['t1'],
        'data returns once authorization works again',
      );
    },
  },

  {
    name: 'scopes/write-outside-grant-denied-and-scope-columns-immutable',
    specRefs: ['§3.4'],
    async run(ctx) {
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: { project_id: ['p1'] },
      });
      await a.api.subscribe({
        id: 'tasks',
        table: 'tasks',
        scopes: { project_id: ['p1'] },
      });
      await syncIdle(a);

      // Insert outside the grant: denied.
      const outside = await a.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('x1', 'p2', 'nope') },
      ]);
      const denied = await syncOk(a);
      checkEqual(denied.rejected, [outside], 'cross-scope insert rejected');
      checkEqual(
        (await a.api.rejections())[0]?.code,
        'sync.forbidden',
        'denial code',
      );
      checkEqual((await ctx.server.readRows('tasks')).length, 0, 'no write');

      // Re-homing by update: the scope column is stripped server-side.
      const b = await ctx.newClient({
        actorId: 'actor-b',
        clientId: 'client-b',
        allowed: { project_id: ['p1', 'p2'] },
      });
      await b.api.subscribe({
        id: 'tasks',
        table: 'tasks',
        scopes: { project_id: ['p1', 'p2'] },
      });
      await syncIdle(b);
      await b.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('t1', 'p1', 'home') },
      ]);
      await syncIdle(b);
      await b.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('t1', 'p2', 'moved?') },
      ]);
      await syncIdle(b);
      const t1 = (await ctx.server.readRows('tasks')).find(
        (row) => row.rowId === 't1',
      );
      checkEqual(
        t1?.values.project_id,
        'p1',
        'scope columns are immutable on update (§3.4 rule 5)',
      );
      checkEqual(t1?.scopes.project_id, 'p1', 'stored scopes unchanged');
      checkEqual(t1?.values.title, 'moved?', 'non-scope columns did update');
      // The client's optimistic p2 value reconciles back to p1.
      const local = (await b.api.readRows('tasks')).find(
        (row) => row.rowId === 't1',
      );
      checkEqual(
        local?.values.project_id,
        'p1',
        'the pull half reconciled the stripped column locally',
      );
    },
  },

  {
    name: 'scopes/segment-download-reauthorizes-every-time',
    specRefs: ['§5.5', '§3.5', '§5.1'],
    server: { limits: { inlineSegmentMaxBytes: 0 } },
    async run(ctx) {
      await ctx.server.setAllowedScopes('dl-actor', { project_id: ['p1'] });
      await seedTasks(ctx, [task('t1', 'p1', 'external')]);

      const pull = await ctx.rawSync(
        'dl-actor',
        [
          rawPullHeader(),
          rawSubscription('s1', 'tasks', { project_id: ['p1'] }, -1),
        ],
        { clientId: 'dl-client' },
      );
      check(pull.ok, 'bootstrap pull succeeded');
      if (!pull.ok) return;
      const section = responseSection(pull.message, 's1');
      const ref = section.body.find((frame) => frame.type === 'SEGMENT_REF');
      check(
        ref !== undefined && ref.type === 'SEGMENT_REF',
        'the segment was delivered as an external reference',
      );
      if (ref?.type !== 'SEGMENT_REF') return;
      const scopesHeader = canonicalScopeJson({ project_id: ['p1'] });

      // Authorized download works.
      const ok = await ctx.server.downloadSegment(
        'dl-actor',
        ref.segmentId,
        scopesHeader,
      );
      check(ok.ok, 'authorized download succeeded');

      // Unknown segment: not_found, never a byte.
      const missing = await ctx.server.downloadSegment(
        'dl-actor',
        `sha256:${'0'.repeat(64)}`,
        scopesHeader,
      );
      check(!missing.ok, 'unknown segment rejected');
      if (!missing.ok) {
        checkEqual(
          missing.error.code,
          'sync.not_found',
          'unknown segment code',
        );
      }

      // A different effective grant → digest mismatch → forbidden.
      await ctx.server.setAllowedScopes('dl-actor', {
        project_id: ['p1', 'p2'],
      });
      const mismatched = await ctx.server.downloadSegment(
        'dl-actor',
        ref.segmentId,
        canonicalScopeJson({ project_id: ['p2'] }),
      );
      check(!mismatched.ok, 'digest mismatch rejected');
      if (!mismatched.ok) {
        checkEqual(
          mismatched.error.code,
          'sync.forbidden',
          'scope digest mismatch is forbidden (§3.5)',
        );
      }

      // Revocation: the earlier reference is not a bearer capability.
      await ctx.server.setAllowedScopes('dl-actor', { project_id: ['p2'] });
      const revoked = await ctx.server.downloadSegment(
        'dl-actor',
        ref.segmentId,
        scopesHeader,
      );
      check(!revoked.ok, 'revoked download rejected');
      if (!revoked.ok) {
        checkEqual(
          revoked.error.code,
          'sync.forbidden',
          'every download re-authorizes (§5.5)',
        );
      }
    },
  },
];
