/**
 * Auth-lease lifecycle (SPEC.md §7.3; Appendix B.15). The lease is a
 * server-issued, time-bounded grant recording the actor's resolved scopes
 * at issuance: the server authorizes a round against it during a
 * live-authorization outage, and the client surfaces its remaining
 * validity. These scenarios pin issuance/refresh, expiry, revocation, and
 * the zero-config (feature-off) discipline.
 */
import { check, checkEqual } from '../checks';
import { task } from '../fixture';
import { rawPullHeader, rawSubscription } from '../raw';
import type { Scenario } from '../scenario';
import { seedTasks, syncIdle, syncOk } from './util';

const TTL_MS = 900_000; // 15 min — v1's lease default.

export const leaseScenarios: readonly Scenario[] = [
  {
    name: 'leases/issued-and-refreshed-on-authorized-rounds',
    specRefs: ['§7.3.2', '§7.3.3', '§7.3.5'],
    requires: ['leases'],
    server: { leases: { ttlMs: TTL_MS } },
    async run(ctx) {
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: { project_id: ['p1'] },
      });
      await seedTasks(ctx, [task('t1', 'p1', 'one')]);
      await a.api.subscribe({
        id: 'tasks',
        table: 'tasks',
        scopes: { project_id: ['p1'] },
      });
      await syncIdle(a);

      // §7.3.2/§7.3.5: a LEASE frame was delivered and the client holds it.
      const startNow = await ctx.server.nowMs();
      const lease1 = await a.api.leaseState();
      check(
        lease1?.leaseId !== undefined,
        'the client holds an issued lease after an authorized round',
      );
      checkEqual(
        lease1?.expiresAtMs,
        startNow + TTL_MS,
        'expiresAtMs = issuedAt + ttlMs (§7.3.3)',
      );
      checkEqual(
        lease1?.errorCode,
        undefined,
        'a fresh lease carries no error (§7.3.5)',
      );

      // §7.3.3: refresh is sliding and reuses the SAME leaseId. Advance the
      // clock, run another authorized round, and the window extends.
      await ctx.server.advanceClock(60_000);
      await seedTasks(ctx, [task('t2', 'p1', 'two')]);
      await syncIdle(a);
      const lease2 = await a.api.leaseState();
      checkEqual(
        lease2?.leaseId,
        lease1?.leaseId,
        'a refresh slides the same lease handle, never mints a new one (§7.3.3)',
      );
      check(
        (lease2?.expiresAtMs ?? 0) > (lease1?.expiresAtMs ?? 0),
        'the sliding window extended on the second authorized round',
      );
    },
  },

  {
    name: 'leases/outage-served-then-expired-stops-and-surfaces',
    specRefs: ['§7.3.3', '§7.3.5', '§10.2'],
    requires: ['leases'],
    server: { leases: { ttlMs: TTL_MS } },
    async run(ctx) {
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: { project_id: ['p1'] },
      });
      await seedTasks(ctx, [task('t1', 'p1', 'one'), task('t2', 'p1', 'two')]);
      await a.api.subscribe({
        id: 'tasks',
        table: 'tasks',
        scopes: { project_id: ['p1'] },
      });
      await syncIdle(a);
      const held = await a.api.leaseState();
      check(held?.leaseId !== undefined, 'a lease was issued while online');

      // §7.3.3: the live resolver goes into an outage (not a throw). A
      // fresh write plus a round is authorized against the stored lease.
      await ctx.server.setResolverOutage?.(true);
      await a.api.mutate([
        {
          op: 'upsert',
          table: 'tasks',
          values: task('t3', 'p1', 'offline'),
        },
      ]);
      const served = await syncOk(a);
      checkEqual(
        served.applied.length,
        1,
        'the offline write applied under lease authorization (§7.3.3)',
      );
      checkEqual(
        (await ctx.server.readRows('tasks')).map((r) => r.rowId),
        ['t1', 't2', 't3'],
        'the leased write reached the server',
      );

      // §7.3.3: past the TTL the lease is no longer valid — the round
      // fails request-level and the client stops-and-surfaces (§7.3.5).
      await ctx.server.advanceClock(TTL_MS + 1);
      await a.api.mutate([
        {
          op: 'upsert',
          table: 'tasks',
          values: task('t4', 'p1', 'too-late'),
        },
      ]);
      const result = await a.api.sync();
      check(!result.ok, 'a round on an expired lease fails');
      if (!result.ok) {
        checkEqual(
          result.errorCode,
          'sync.auth_lease_required',
          'expired-lease outage surfaces sync.auth_lease_required (§7.3.3)',
        );
      }
      const stopped = await a.api.leaseState();
      checkEqual(
        stopped?.errorCode,
        'sync.auth_lease_required',
        'the client recorded the lease error in leaseState (§7.3.5)',
      );
      // §7.3.4: no local-data purge on a lease error — t4 stays optimistic.
      checkEqual(
        (await a.api.pendingCommitIds()).length,
        1,
        'the write stays queued (no purge, no silent drop) (§7.3.4)',
      );
      check(
        (await a.api.readRows('tasks')).some((r) => r.rowId === 't4'),
        'local data survives a lease error (§7.3.4)',
      );

      // Recovery: the live resolver returns and a normal round re-issues a
      // fresh lease; the queued write drains.
      await ctx.server.setResolverOutage?.(false);
      await syncIdle(a);
      const recovered = await a.api.leaseState();
      checkEqual(
        recovered?.errorCode,
        undefined,
        'a fresh authorized round clears the lease error (§7.3.5)',
      );
      checkEqual(
        (await a.api.pendingCommitIds()).length,
        0,
        'the queued write drained once authorization returned',
      );
    },
  },

  {
    name: 'leases/revocation-invalidates-continued-sync-not-local-data',
    specRefs: ['§7.3.4', '§10.2'],
    requires: ['leases'],
    server: { leases: { ttlMs: TTL_MS } },
    async run(ctx) {
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: { project_id: ['p1'] },
      });
      await seedTasks(ctx, [task('t1', 'p1', 'one')]);
      await a.api.subscribe({
        id: 'tasks',
        table: 'tasks',
        scopes: { project_id: ['p1'] },
      });
      await syncIdle(a);
      const held = await a.api.leaseState();
      const leaseId = held?.leaseId;
      check(leaseId !== undefined, 'a lease was issued');
      if (leaseId === undefined) return;
      const rowsBefore = (await a.api.readRows('tasks')).length;

      // §7.3.4: the host revokes the lease, then a live-resolver outage
      // makes the round fall to the (now revoked) lease.
      await ctx.server.revokeLease?.(leaseId);
      await ctx.server.setResolverOutage?.(true);
      await a.api.mutate([
        {
          op: 'upsert',
          table: 'tasks',
          values: task('t2', 'p1', 'blocked'),
        },
      ]);
      const result = await a.api.sync();
      check(!result.ok, 'a round on a revoked lease fails');
      if (!result.ok) {
        checkEqual(
          result.errorCode,
          'sync.auth_lease_revoked',
          'a revoked-lease round surfaces sync.auth_lease_revoked (§7.3.4)',
        );
      }
      checkEqual(
        (await a.api.leaseState())?.errorCode,
        'sync.auth_lease_revoked',
        'the client recorded the revocation state (§7.3.5)',
      );
      // §7.3.4: revocation is about continued sync, NOT local data — the
      // synced row survives (the optimistic write also stays, unpurged).
      check(
        (await a.api.readRows('tasks')).some((r) => r.rowId === 't1'),
        'the synced row survives revocation (no purge, distinct from §3.3, §7.3.4)',
      );
      check(
        (await a.api.readRows('tasks')).length >= rowsBefore,
        'revocation purges no local rows (§7.3.4)',
      );
      checkEqual(
        (await ctx.server.readRows('tasks')).map((r) => r.rowId),
        ['t1'],
        'the blocked write never reached the server',
      );

      // Recovery: the resolver returns; a normal round issues a FRESH lease
      // (the revoked handle never resurrects, §7.3.4) and the write drains.
      await ctx.server.setResolverOutage?.(false);
      await syncIdle(a);
      const fresh = await a.api.leaseState();
      checkEqual(
        fresh?.errorCode,
        undefined,
        'the lease error cleared on recovery',
      );
      check(
        fresh?.leaseId !== undefined && fresh.leaseId !== leaseId,
        'recovery minted a fresh lease id — the revoked handle stayed dead (§7.3.4)',
      );
      checkEqual(
        (await ctx.server.readRows('tasks')).map((r) => r.rowId),
        ['t1', 't2'],
        'the write drained once a live authorization returned',
      );
    },
  },

  {
    name: 'leases/feature-off-emits-no-lease-frame',
    specRefs: ['§7.3.2', '§7.3.3'],
    async run(ctx) {
      // No `server.leases` ⇒ the feature is off (zero-config discipline).
      await ctx.server.setAllowedScopes('actor-a', { project_id: ['p1'] });
      await seedTasks(ctx, [task('t1', 'p1', 'one')]);

      const pull = await ctx.rawSync(
        'actor-a',
        [
          rawPullHeader(),
          rawSubscription('tasks', 'tasks', { project_id: ['p1'] }, -1),
        ],
        { clientId: 'client-a' },
      );
      check(pull.ok, 'the pull succeeded');
      if (!pull.ok) return;
      const leaseFrames = pull.message.frames.filter(
        (frame) => frame.type === 'LEASE',
      );
      checkEqual(
        leaseFrames.length,
        0,
        'a feature-off server never emits a LEASE frame (§7.3.3 zero-config)',
      );

      // The client-side view stays empty too (a normal client sync).
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a-2',
        allowed: { project_id: ['p1'] },
      });
      await a.api.subscribe({
        id: 'tasks',
        table: 'tasks',
        scopes: { project_id: ['p1'] },
      });
      await syncIdle(a);
      checkEqual(
        await a.api.leaseState(),
        undefined,
        'leaseState stays empty when the server does not issue leases (§7.3.5)',
      );
    },
  },
];
