/**
 * Bootstrap paths: inline and external segments, paging + interrupted
 * resume, integrity failures, and segment expiry (SPEC.md §4.7, §5,
 * §1.4; Appendix B.5).
 */

import { canonicalScopeJson } from '@syncular/core';
import { check, checkEqual } from '../checks';
import { task } from '../fixture';
import { rawPullHeader, rawSubscription, responseSection } from '../raw';
import type { Scenario } from '../scenario';
import { expectConverged, seedTasks, syncIdle, syncOk } from './util';

const P1 = { project_id: ['p1'] } as const;

export const bootstrapScenarios: readonly Scenario[] = [
  {
    name: 'bootstrap/fresh-inline-and-handoff-at-pin',
    specRefs: ['§4.7', '§5.2', '§5.7'],
    async run(ctx) {
      await seedTasks(ctx, [
        task('t1', 'p1', 'one'),
        task('t2', 'p1', 'two'),
        task('t3', 'p1', 'three'),
      ]);
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: P1,
      });
      await a.api.subscribe({ id: 'tasks', table: 'tasks', scopes: P1 });

      const first = await syncOk(a);
      checkEqual(first.segmentRowsApplied, 3, 'snapshot arrived as segments');
      checkEqual(
        first.bootstrapping,
        [],
        'small bootstrap completed in one pull',
      );
      const pin = await ctx.server.getMaxCommitSeq();
      checkEqual(
        (await a.api.subscriptionState('tasks'))?.cursor,
        pin,
        'SUB_END.nextCursor is the bootstrap pin (§4.7)',
      );

      // Handoff: post-pin commits arrive incrementally, no re-bootstrap.
      await seedTasks(ctx, [task('t4', 'p1', 'after-pin')]);
      const second = await syncOk(a);
      checkEqual(second.segmentRowsApplied, 0, 'no second bootstrap');
      checkEqual(second.commitsApplied, 1, 'incremental pull took over');
      // Values AND versions converge: segment row records carry the
      // rows' server_version (§5.2/§5.6).
      await expectConverged(ctx, 'tasks', [a], {
        variable: 'project_id',
        values: ['p1'],
      });
      const t4 = (await a.api.readRows('tasks')).find(
        (row) => row.rowId === 't4',
      );
      checkEqual(
        t4?.version,
        1,
        'the commit-delivered row carries its server_version (§4.5)',
      );
    },
  },

  {
    name: 'bootstrap/paged-external-resume-after-interruption',
    specRefs: ['§4.7', '§5.1', '§5.4', '§5.6', '§1.4', 'B.5'],
    server: { limits: { inlineSegmentMaxBytes: 0 } },
    async run(ctx) {
      await seedTasks(
        ctx,
        ['t1', 't2', 't3', 't4', 't5'].map((id) => task(id, 'p1', `row ${id}`)),
      );
      // accept 0b0011 pins the rows lane: this scenario is about §4.7
      // paging + resume, which the whole-table sqlite lane (§5.3) skips.
      const limits = {
        limitSnapshotRows: 2,
        maxSnapshotPages: 1,
        accept: 0b0011,
      };

      // Control: an uninterrupted paged bootstrap.
      const control = await ctx.newClient({
        actorId: 'actor-c',
        clientId: 'client-control',
        allowed: P1,
        limits,
      });
      await control.api.subscribe({ id: 'tasks', table: 'tasks', scopes: P1 });
      await syncIdle(control);

      // Interrupted: lose a response mid-bootstrap, then resume.
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: P1,
        limits,
      });
      await a.api.subscribe({ id: 'tasks', table: 'tasks', scopes: P1 });
      const page1 = await syncOk(a);
      checkEqual(page1.segmentRowsApplied, 2, 'first page applied');
      check(
        (await a.api.subscriptionState('tasks'))?.hasResumeToken === true,
        'the resume token was persisted at SUB_END',
      );

      a.faults.dropNextResponses = 1;
      const lost = await a.api.sync();
      check(!lost.ok, 'the mid-bootstrap response was lost');
      check(
        (await a.api.subscriptionState('tasks'))?.hasResumeToken === true,
        'the lost round persisted nothing — the token still points at the last completed page (§1.4)',
      );

      const resumed = await syncIdle(a);
      checkEqual(resumed.bootstrapping, [], 'bootstrap completed after resume');
      const controlRows = await control.api.readRows('tasks');
      const resumedRows = await a.api.readRows('tasks');
      checkEqual(
        resumedRows,
        controlRows,
        'no rows lost or duplicated versus the uninterrupted bootstrap (B.5)',
      );
      await expectConverged(ctx, 'tasks', [a, control], {
        variable: 'project_id',
        values: ['p1'],
      });
    },
  },

  {
    name: 'bootstrap/segment-truncation-discards-and-recovers',
    specRefs: ['§5.1', '§5.6', '§1.4'],
    server: { limits: { inlineSegmentMaxBytes: 0 } },
    async run(ctx) {
      await seedTasks(ctx, [task('t1', 'p1'), task('t2', 'p1')]);
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: P1,
      });
      await a.api.subscribe({ id: 'tasks', table: 'tasks', scopes: P1 });

      // Byte truncation at the segment hop → content-address mismatch →
      // the segment is discarded, nothing persists.
      a.faults.truncateNextSegmentDownload = true;
      const result = await a.api.sync();
      check(!result.ok, 'the truncated segment failed the sync round');
      const state = await a.api.subscriptionState('tasks');
      checkEqual(state?.cursor, -1, 'the cursor did not advance (§1.4 rule 5)');
      checkEqual(state?.hasResumeToken, false, 'no resume token persisted');
      checkEqual((await a.api.readRows('tasks')).length, 0, 'nothing applied');

      // The re-pull mints fresh descriptors and converges.
      await syncIdle(a);
      await expectConverged(ctx, 'tasks', [a], {
        variable: 'project_id',
        values: ['p1'],
      });
    },
  },

  {
    name: 'bootstrap/response-truncation-aborts-without-persisting',
    specRefs: ['§1.4', '§1.2'],
    async run(ctx) {
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: P1,
      });
      await a.api.subscribe({ id: 'tasks', table: 'tasks', scopes: P1 });
      await syncIdle(a);
      const cursorBefore = (await a.api.subscriptionState('tasks'))?.cursor;

      await seedTasks(ctx, [task('t1', 'p1', 'cut off')]);
      a.faults.truncateNextResponse = true;
      const result = await a.api.sync();
      check(!result.ok, 'a truncated envelope is a decode error');
      if (!result.ok) {
        checkEqual(
          result.errorCode,
          'sync.invalid_request',
          'truncation surfaces the §1.2 decode error',
        );
      }
      checkEqual(
        (await a.api.subscriptionState('tasks'))?.cursor,
        cursorBefore,
        'the aborted round persisted no cursor (§1.4 rule 5)',
      );
      checkEqual((await a.api.readRows('tasks')).length, 0, 'no partial apply');

      // Re-pull idempotency repairs everything.
      await syncIdle(a);
      await expectConverged(ctx, 'tasks', [a], {
        variable: 'project_id',
        values: ['p1'],
      });
    },
  },

  {
    // B.9: segment row records carry server_version (§5.2), so a
    // bootstrap alone seeds §6.2 optimistic concurrency — no commit
    // delivery needed before a baseVersion-carrying push.
    name: 'bootstrap/segment-versions-seed-base-version',
    specRefs: ['§5.2', '§5.6', '§6.2', 'B.9'],
    async run(ctx) {
      // t1 reaches v2 pre-bootstrap; t2 stays at v1.
      await seedTasks(ctx, [task('t1', 'p1', 'one'), task('t2', 'p1', 'two')]);
      await seedTasks(ctx, [task('t1', 'p1', 'one-updated')]);

      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: P1,
      });
      await a.api.subscribe({ id: 'tasks', table: 'tasks', scopes: P1 });
      const first = await syncOk(a);
      checkEqual(first.segmentRowsApplied, 2, 'both rows arrived as segments');
      checkEqual(
        first.commitsApplied,
        0,
        'no COMMIT frames were delivered — versions come from segments only',
      );
      // §5.6: segment-applied rows carry the server's exact versions.
      await expectConverged(ctx, 'tasks', [a], {
        variable: 'project_id',
        values: ['p1'],
      });
      const t1Local = (await a.api.readRows('tasks')).find(
        (row) => row.rowId === 't1',
      );
      checkEqual(t1Local?.version, 2, 'segment delivered t1 at v2 (§5.2)');

      // A baseVersion push seeded purely by the segment applies cleanly.
      await a.api.mutate([
        {
          op: 'upsert',
          table: 'tasks',
          values: task('t1', 'p1', 'guarded-edit'),
          baseVersion: t1Local?.version ?? -1,
        },
      ]);
      const guarded = await syncOk(a);
      checkEqual(guarded.rejected, [], 'the guarded push applied');
      checkEqual(guarded.conflicts, 0, 'no conflict on a correct baseVersion');
      const t1Server = (await ctx.server.readRows('tasks')).find(
        (row) => row.rowId === 't1',
      );
      checkEqual(t1Server?.version, 3, 'server incremented v2 → v3 (§6.2)');
      checkEqual(t1Server?.values.title, 'guarded-edit', 'the edit landed');

      // A stale baseVersion on the other segment-bootstrapped row
      // conflicts instead of silently overwriting.
      const mStale = await a.api.mutate([
        {
          op: 'upsert',
          table: 'tasks',
          values: task('t2', 'p1', 'stale-edit'),
          baseVersion: 7,
        },
      ]);
      const stale = await syncOk(a);
      checkEqual(stale.rejected, [mStale], 'the stale commit was rejected');
      checkEqual(stale.conflicts, 1, 'exactly one conflict surfaced');
      const conflict = (await a.api.conflicts())[0];
      checkEqual(conflict?.code, 'sync.version_conflict', 'conflict code');
      checkEqual(conflict?.rowId, 't2', 'conflict rowId');
      checkEqual(
        conflict?.serverVersion,
        1,
        'the conflict record names the real server version (§6.3)',
      );

      // §6.5 keep-local rebase: re-push with the conflict's serverVersion
      // (the server never re-delivers the unchanged t2, so resolution —
      // not another pull — is what converges the row, §7.2).
      await a.api.mutate([
        {
          op: 'upsert',
          table: 'tasks',
          values: task('t2', 'p1', 'rebased-edit'),
          baseVersion: conflict?.serverVersion ?? -1,
        },
      ]);
      await syncIdle(a);
      await expectConverged(ctx, 'tasks', [a], {
        variable: 'project_id',
        values: ['p1'],
      });
    },
  },

  {
    name: 'bootstrap/segment-expiry-recovery',
    specRefs: ['§5.1', '§5.5', '§10.2'],
    server: { limits: { inlineSegmentMaxBytes: 0 } },
    async run(ctx) {
      await ctx.server.setAllowedScopes('exp-actor', P1);
      await seedTasks(ctx, [task('t1', 'p1', 'ttl')]);
      const scopesHeader = canonicalScopeJson({ project_id: ['p1'] });
      const pullFrames = [
        rawPullHeader(),
        rawSubscription('s1', 'tasks', P1, -1),
      ];

      const pull = await ctx.rawSync('exp-actor', pullFrames, {
        clientId: 'exp-client',
      });
      check(pull.ok, 'bootstrap pull succeeded');
      if (!pull.ok) return;
      const ref = responseSection(pull.message, 's1').body.find(
        (frame) => frame.type === 'SEGMENT_REF',
      );
      check(ref?.type === 'SEGMENT_REF', 'external segment reference issued');
      if (ref?.type !== 'SEGMENT_REF') return;

      // The TTL elapses (default 24 h): the cache entry is gone, and the
      // failure names the retryable code — re-pulling is the recovery.
      await ctx.server.advanceClock(25 * 60 * 60 * 1000);
      const expired = await ctx.server.downloadSegment(
        'exp-actor',
        ref.segmentId,
        scopesHeader,
      );
      check(!expired.ok, 'the expired segment no longer serves');
      if (!expired.ok) {
        checkEqual(expired.error.code, 'sync.segment_expired', 'expiry code');
        checkEqual(
          expired.error.retryable,
          true,
          'sync.segment_expired is the retryable not-found (§10.2)',
        );
      }

      const repull = await ctx.rawSync('exp-actor', pullFrames, {
        clientId: 'exp-client',
      });
      check(repull.ok, 're-pull mints fresh descriptors');
      if (!repull.ok) return;
      const fresh = responseSection(repull.message, 's1').body.find(
        (frame) => frame.type === 'SEGMENT_REF',
      );
      check(fresh?.type === 'SEGMENT_REF', 'fresh reference issued');
      if (fresh?.type !== 'SEGMENT_REF') return;
      const downloaded = await ctx.server.downloadSegment(
        'exp-actor',
        fresh.segmentId,
        scopesHeader,
      );
      check(downloaded.ok, 'the re-minted segment downloads');
    },
  },
];
