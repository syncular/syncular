/**
 * Offline outbox, replay, and idempotency under transport faults
 * (SPEC.md §2.3, §6.3, §7; Appendix B.2/B.3). All faults inject at the
 * transport seam; the server is never told a fault happened.
 */
import { decodeMessage } from '@syncular/core';
import { check, checkEqual } from '../checks';
import { task } from '../fixture';
import { responsePushResults } from '../raw';
import type { Scenario } from '../scenario';
import { expectConverged, syncFails, syncIdle, syncOk } from './util';

const P1 = { project_id: ['p1'] } as const;

async function bootstrapped(
  ctx: Parameters<Scenario['run']>[0],
  actorId: string,
  clientId: string,
) {
  const handle = await ctx.newClient({ actorId, clientId, allowed: P1 });
  await handle.api.subscribe({ id: 'tasks', table: 'tasks', scopes: P1 });
  await syncIdle(handle);
  return handle;
}

export const offlineScenarios: readonly Scenario[] = [
  {
    name: 'offline/first-handshake-drains-without-subscriptions',
    specRefs: ['§7.1', '§2.1', '§8.4'],
    async run(ctx) {
      const client = await ctx.newClient({
        actorId: 'actor',
        clientId: 'first-handshake',
        allowed: P1,
      });
      const id = await client.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('first', 'p1') },
      ]);
      await syncIdle(client);
      checkEqual(
        await client.api.pendingCommitIds(),
        [],
        'startup drains the queued write',
      );
      checkEqual(
        (await ctx.server.readRows('tasks')).map((row) => row.rowId),
        ['first'],
        'server applies the write',
      );
      check(
        client.sentRequests.some((bytes) =>
          decodeMessage(bytes).frames.some(
            (frame) =>
              frame.type === 'PUSH_COMMIT' && frame.clientCommitId === id,
          ),
        ),
        'a post-handshake request pushes the commit',
      );
    },
  },
  ...[499, 500, 501].map(
    (operationCount): Scenario => ({
      name: `offline/outbox-budget-${operationCount}`,
      specRefs: ['§6.1', '§7.1', '§2.3'],
      async run(ctx) {
        const a = await bootstrapped(ctx, 'actor-a', 'client-a');
        const first = await a.api.mutate(
          Array.from({ length: operationCount }, (_, index) => ({
            op: 'upsert' as const,
            table: 'tasks',
            values: task(`filler-${index}`, 'p1'),
          })),
        );
        const second = await a.api.mutate([
          {
            op: 'upsert',
            table: 'tasks',
            values: task('edited', 'p1', 'older'),
          },
          { op: 'upsert', table: 'tasks', values: task('sibling', 'p1') },
        ]);
        const third = await a.api.mutate([
          {
            op: 'upsert',
            table: 'tasks',
            values: task('edited', 'p1', 'newest'),
          },
        ]);
        a.sentRequests.length = 0;
        if (operationCount > 500) {
          await syncFails(
            a,
            'sync.too_many_operations',
            'oversized first commit',
          );
          checkEqual(
            await a.api.pendingCommitIds(),
            [first, second, third],
            'whole outbox survives request rejection',
          );
          checkEqual(
            await ctx.server.getMaxCommitSeq(),
            0,
            'oversized request applied nothing',
          );
        } else {
          a.faults.dropNextResponses = 1;
          await syncFails(
            a,
            'transport.lost',
            'lost first batch acknowledgement',
          );
          checkEqual(
            await a.api.pendingCommitIds(),
            [first, second, third],
            'lost reply preserves FIFO queue',
          );
          const retried = await syncOk(a);
          checkEqual(
            retried.applied,
            [first],
            'retry drains only the first commit',
          );
          checkEqual(
            await ctx.server.getMaxCommitSeq(),
            1,
            'retry applies the first commit once',
          );
          const remaining = await syncOk(a);
          checkEqual(
            remaining.applied,
            [second, third],
            'suffix applies in creation order',
          );
          checkEqual(await a.api.pendingCommitIds(), [], 'suffix drains');
          await syncIdle(a);
          const edited = (await ctx.server.readRows('tasks')).find(
            (row) => row.rowId === 'edited',
          );
          checkEqual(
            edited?.values.title,
            'newest',
            'newest edit survives batching',
          );
          await expectConverged(ctx, 'tasks', [a], {
            variable: 'project_id',
            values: ['p1'],
          });
        }
        const batches = a.sentRequests
          .map((bytes) => {
            const request = decodeMessage(bytes);
            check(request.msgKind === 'request', 'captured a request');
            return request.frames.flatMap((frame) =>
              frame.type === 'PUSH_COMMIT' ? [frame.clientCommitId] : [],
            );
          })
          .filter((ids) => ids.length > 0);
        checkEqual(
          batches,
          operationCount > 500
            ? [[first]]
            : [[first], [first], [second, third]],
          'wire batches preserve the contiguous prefix',
        );
      },
    }),
  ),
  {
    name: 'offline/outbox-fifo-replay',
    specRefs: ['§7.1', '§7.2', 'B.2'],
    async run(ctx) {
      const a = await bootstrapped(ctx, 'actor-a', 'client-a');
      const b = await bootstrapped(ctx, 'actor-b', 'client-b');

      // Offline: every request is lost before reaching the server.
      a.faults.dropNextRequests = 3;
      const m1 = await a.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('t1', 'p1', 'first') },
      ]);
      await syncFails(a, 'transport.lost', 'offline push 1');
      const m2 = await a.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('t1', 'p1', 'second') },
      ]);
      await syncFails(a, 'transport.lost', 'offline push 2');
      const m3 = await a.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('t2', 'p1', 'third') },
      ]);
      await syncFails(a, 'transport.lost', 'offline push 3');

      checkEqual(
        await a.api.pendingCommitIds(),
        [m1, m2, m3],
        'outbox holds all three commits FIFO (§7.1)',
      );
      checkEqual(
        await ctx.server.getMaxCommitSeq(),
        0,
        'nothing reached the server while offline',
      );

      // Reconnect: one combined round drains the outbox in order and the
      // pull half returns the replayed rows (§7.2).
      const report = await syncOk(a);
      checkEqual(report.applied, [m1, m2, m3], 'FIFO replay order held');
      checkEqual(await a.api.pendingCommitIds(), [], 'outbox drained');
      await syncIdle(b);
      await expectConverged(ctx, 'tasks', [a, b], {
        variable: 'project_id',
        values: ['p1'],
      });
      const t1 = (await ctx.server.readRows('tasks')).find(
        (row) => row.rowId === 't1',
      );
      checkEqual(t1?.version, 2, 'both t1 commits applied in order');
    },
  },

  {
    name: 'offline/ack-loss-cached-replay',
    specRefs: ['§2.3', '§6.3', 'B.3'],
    async run(ctx) {
      const a = await bootstrapped(ctx, 'actor-a', 'client-a');
      const b = await bootstrapped(ctx, 'actor-b', 'client-b');

      const m1 = await a.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('t1', 'p1', 'once') },
      ]);
      a.faults.dropNextResponses = 1;
      await syncFails(a, 'transport.lost', 'ack loss');
      const seqAfterFirst = await ctx.server.getMaxCommitSeq();
      check(
        seqAfterFirst >= 1,
        'the server applied the commit despite the lost ack',
      );
      checkEqual(
        await a.api.pendingCommitIds(),
        [m1],
        'the client keeps the unacked commit queued',
      );

      // Identical replay: the server answers `cached`, applies nothing.
      const report = await syncOk(a);
      check(report.applied.includes(m1), 'cached replay drained the outbox');
      checkEqual(
        await ctx.server.getMaxCommitSeq(),
        seqAfterFirst,
        'no second commitSeq was allocated — exactly-once apply (§2.3)',
      );

      await syncIdle(b);
      const rows = await b.api.readRows('tasks');
      checkEqual(
        rows.map((row) => ({ rowId: row.rowId, version: row.version })),
        [{ rowId: 't1', version: 1 }],
        'a concurrent observer sees the commit exactly once',
      );
      await expectConverged(ctx, 'tasks', [a, b], {
        variable: 'project_id',
        values: ['p1'],
      });
    },
  },

  {
    name: 'offline/duplicate-request-delivery',
    specRefs: ['§2.3', '§6.3', '§6.4'],
    async run(ctx) {
      const a = await bootstrapped(ctx, 'actor-a', 'client-a');
      const m1 = await a.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('t1', 'p1', 'dup') },
      ]);
      // The transport delivers the same request bytes twice; the client
      // consumes the second response.
      a.faults.duplicateNextRequest = true;
      const report = await syncOk(a);
      check(report.applied.includes(m1), 'the duplicated push still drains');
      checkEqual(
        await ctx.server.getMaxCommitSeq(),
        1,
        'duplicate delivery allocated exactly one commitSeq',
      );
      const t1 = (await ctx.server.readRows('tasks')).find(
        (row) => row.rowId === 't1',
      );
      checkEqual(t1?.version, 1, 'the row applied exactly once');
      await expectConverged(ctx, 'tasks', [a], {
        variable: 'project_id',
        values: ['p1'],
      });
    },
  },

  {
    name: 'offline/stale-retransmit-is-harmless',
    specRefs: ['§2.3', '§6.3', '§6.4'],
    async run(ctx) {
      const a = await bootstrapped(ctx, 'actor-a', 'client-a');
      await a.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('t1', 'p1', 'v1') },
      ]);
      await syncOk(a);
      const staleRequest = a.sentRequests[a.sentRequests.length - 1];
      check(staleRequest !== undefined, 'captured the push request bytes');

      await a.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('t1', 'p1', 'v2') },
      ]);
      await syncIdle(a);
      const maxSeq = await ctx.server.getMaxCommitSeq();

      // Reordering where the protocol permits: an old request arrives
      // after newer ones (network-level retransmit). The idempotency key
      // pins it — the persisted result replays, the log does not move.
      const replay = await ctx.rawSyncBytes(a.actorId, staleRequest);
      check(replay.ok, 'the stale retransmit is not an error');
      if (replay.ok) {
        const push = responsePushResults(replay.message)[0];
        checkEqual(
          push?.status,
          'cached',
          'replayed push answers cached (§6.3)',
        );
      }
      checkEqual(
        await ctx.server.getMaxCommitSeq(),
        maxSeq,
        'the retransmit allocated no commitSeq',
      );
      const t1 = (await ctx.server.readRows('tasks')).find(
        (row) => row.rowId === 't1',
      );
      checkEqual(t1?.version, 2, 'newer state survived the stale replay');
      checkEqual(t1?.values.title, 'v2', 'v2 content was not rolled back');
    },
  },

  {
    name: 'offline/idempotency-cache-miss-keeps-commit-queued',
    specRefs: ['§6.3'],
    requires: ['idempotency-fault'],
    async run(ctx) {
      const a = await bootstrapped(ctx, 'actor-a', 'client-a');
      const m1 = await a.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('t1', 'p1', 'later') },
      ]);
      await ctx.server.failNextIdempotencyLookup?.();
      const report = await syncOk(a);
      checkEqual(
        report.retryable,
        [m1],
        'the cache miss is a serving failure, not the commit outcome (§6.3)',
      );
      checkEqual(
        await a.api.pendingCommitIds(),
        [m1],
        'the commit stays queued for an identical retry',
      );
      checkEqual(
        await ctx.server.getMaxCommitSeq(),
        0,
        'nothing was applied under the cache miss',
      );

      const retry = await syncOk(a);
      check(retry.applied.includes(m1), 'the identical retry applied');
      await expectConverged(ctx, 'tasks', [a], {
        variable: 'project_id',
        values: ['p1'],
      });
    },
  },
];
