/**
 * The per-outbox acknowledged watermark (SPEC.md §6.3.2) and the §9
 * settlement of results stored without an outbox sequence (Appendix B.27).
 */
import { decodeMessage, type PushOperation } from '@syncular/core';
import { check, checkEqual } from '../checks';
import { task } from '../fixture';
import { rawPushCommit, rawUpsert, responsePushResults } from '../raw';
import type { ClientHandle, Scenario, ScenarioContext } from '../scenario';
import { pushOutcome, syncIdle, syncOk } from './util';

const P1 = { project_id: ['p1'] } as const;
const U1 = { project_id: 'p1' } as const;
const EXPIRED = {
  status: 'rejected',
  results: ['0:sync.commit_expired:final'],
};

/** The §6.3.2 rows the server stores for `clientId`, as sorted ids. */
async function stored(ctx: ScenarioContext, clientId: string) {
  const state = await ctx.server.idempotencyState?.();
  if (state === undefined)
    throw new Error('idempotency-state without its method');
  return {
    results: state.results
      .filter((result) => result.clientId === clientId)
      .map((result) =>
        result.clientSeq === undefined
          ? result.clientCommitId
          : `${result.clientCommitId}@${result.clientSeq}`,
      ),
    watermarks: state.watermarks
      .filter((watermark) => watermark.clientId === clientId)
      .map((watermark) => watermark.throughSeq),
  };
}

/** The request bytes `handle` sent that carry `clientCommitId`. */
function requestCarrying(handle: ClientHandle, clientCommitId: string) {
  const bytes = handle.sentRequests.find((request) =>
    decodeMessage(request).frames.some(
      (frame) =>
        frame.type === 'PUSH_COMMIT' && frame.clientCommitId === clientCommitId,
    ),
  );
  if (bytes === undefined) throw new Error('no request carried the commit');
  return bytes;
}

async function bootstrapped(ctx: ScenarioContext, clientId = 'client-a') {
  const handle = await ctx.newClient({
    actorId: 'actor-a',
    clientId,
    allowed: P1,
  });
  await handle.api.subscribe(U1);
  await syncIdle(handle);
  return handle;
}

/** A raw one-operation commit writing task `id`. */
function write(ctx: ScenarioContext, id: string): PushOperation {
  return rawUpsert(ctx.serverSchema, 'tasks', task(id, 'p1', id));
}

/** Push raw commits for `clientId`; returns their reduced results. */
async function push(
  ctx: ScenarioContext,
  clientId: string,
  commits: readonly (readonly [string, number])[],
  outboxId?: string,
) {
  await ctx.server.setAllowedScopes('actor-raw', P1);
  const result = await ctx.rawSync(
    'actor-raw',
    commits.map(([id, seq]) => rawPushCommit(id, [write(ctx, id)], seq)),
    { clientId, ...(outboxId !== undefined ? { outboxId } : {}) },
  );
  check(result.ok, 'the push is not a request error');
  return result.ok ? responsePushResults(result.message).map(pushOutcome) : [];
}

const cached = (outcome: unknown) =>
  typeof outcome === 'object' &&
  outcome !== null &&
  'status' in outcome &&
  outcome.status === 'cached';

export const watermarkScenarios: readonly Scenario[] = [
  {
    name: 'watermark/lost-acknowledgement-replays-until-a-later-first-commit',
    specRefs: ['§6.3.2', '§7.2', 'B.27'],
    requires: ['idempotency-state'],
    async run(ctx) {
      const a = await bootstrapped(ctx);
      const first = await a.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('t1', 'p1', 'one') },
      ]);
      a.faults.dropNextResponses = 1;
      const lost = await a.api.sync();
      check(!lost.ok, 'the acknowledgement was lost');
      const retry = await syncOk(a);
      checkEqual(
        retry.applied,
        [first],
        'the retry with A still first drains A',
      );
      const replay = await ctx.rawSyncBytes(
        a.actorId,
        requestCarrying(a, first),
      );
      check(
        replay.ok &&
          cached(pushOutcome(responsePushResults(replay.message)[0])),
        'A replays its cached result while it is the first commit',
      );
      checkEqual(
        (await stored(ctx, a.clientId)).results.length,
        1,
        "A's result survives the retry",
      );

      await a.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('t2', 'p1', 'two') },
      ]);
      await syncOk(a);
      const state = await stored(ctx, a.clientId);
      checkEqual(state.watermarks, [2], 'the second request raised W to 2');
      checkEqual(state.results.length, 1, "B's result replaced A's");
      const late = await ctx.rawSyncBytes(a.actorId, requestCarrying(a, first));
      check(late.ok, 'the late copy is not a request error');
      if (late.ok)
        checkEqual(
          pushOutcome(responsePushResults(late.message)[0]),
          EXPIRED,
          'below the watermark, A is refused',
        );
    },
  },

  {
    name: 'watermark/late-duplicate-request-is-refused',
    specRefs: ['§6.3', '§6.3.2', 'B.27'],
    async run(ctx) {
      const a = await bootstrapped(ctx);
      const first = await a.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('t1', 'p1', 'a') },
      ]);
      await a.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('t2', 'p1', 'b') },
      ]);
      await syncOk(a);
      const request = requestCarrying(a, first);
      await a.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('t1', 'p1', 'c') },
      ]);
      await syncOk(a);
      const maxSeq = await ctx.server.getMaxCommitSeq();
      const rows = await ctx.server.readRows('tasks');

      const replay = await ctx.rawSyncBytes(a.actorId, request);
      check(replay.ok, 'the late duplicate is not a request error');
      if (replay.ok)
        checkEqual(
          responsePushResults(replay.message).map(pushOutcome),
          [EXPIRED, EXPIRED],
          'A and B return sync.commit_expired (§6.3)',
        );
      checkEqual(
        await ctx.server.getMaxCommitSeq(),
        maxSeq,
        'no commit was appended',
      );
      checkEqual(await ctx.server.readRows('tasks'), rows, 'no row changed');
    },
  },

  {
    name: 'watermark/new-outbox-under-an-old-client-id-applies',
    specRefs: ['§6.3.2', '§7.1', 'B.27'],
    async run(ctx) {
      const original = await bootstrapped(ctx, 'device');
      for (const title of ['one', 'two'])
        await original.api.mutate([
          {
            op: 'upsert',
            table: 'tasks',
            values: task(`t-${title}`, 'p1', title),
          },
        ]);
      await syncOk(original);
      // A restarted in-memory replica: same clientId, a new outbox.
      const restarted = await bootstrapped(ctx, 'device');
      const fresh = await restarted.api.mutate([
        {
          op: 'upsert',
          table: 'tasks',
          values: task('t-fresh', 'p1', 'fresh'),
        },
      ]);
      const report = await syncOk(restarted);
      checkEqual(
        report.applied,
        [fresh],
        'sequence 1 of the new outbox applies',
      );
      check(
        (await ctx.server.readRows('tasks')).some(
          (row) => row.rowId === 't-fresh',
        ),
        'the server holds the new commit',
      );
    },
  },

  {
    name: 'watermark/pre-upgrade-results-settle-by-sequence',
    specRefs: ['§6.3.2', '§9', 'B.27'],
    requires: ['idempotency-state'],
    async run(ctx) {
      // Results stored without a sequence; Z already left the outbox.
      await push(ctx, 'legacy', [
        ['A', 0],
        ['B', 0],
        ['Z', 0],
      ]);
      checkEqual(
        (await stored(ctx, 'legacy')).results,
        ['A', 'B', 'Z'],
        'results without an outbox carry no sequence',
      );
      const replays = await push(
        ctx,
        'legacy',
        [
          ['A', 1],
          ['B', 2],
        ],
        'outbox-1',
      );
      check(replays.every(cached), 'A and B replay their stored results');
      checkEqual(
        await stored(ctx, 'legacy'),
        { results: ['A@1', 'B@2', 'Z'], watermarks: [1] },
        'the first request carrying them assigns their sequences',
      );
      await push(ctx, 'legacy', [['C', 3]], 'outbox-1');
      checkEqual(
        await stored(ctx, 'legacy'),
        { results: ['C@3'], watermarks: [3] },
        'a request whose last commit holds no pre-upgrade result deletes Z; W deletes A and B',
      );
    },
  },

  {
    name: 'watermark/results-bounded-to-the-last-request',
    specRefs: ['§6.3.2', 'B.27'],
    requires: ['idempotency-state'],
    async run(ctx) {
      const a = await bootstrapped(ctx);
      let last = '';
      for (let n = 1; n <= 5; n += 1) {
        last = await a.api.mutate([
          { op: 'upsert', table: 'tasks', values: task(`t${n}`, 'p1') },
        ]);
        await syncOk(a);
      }
      const state = await stored(ctx, a.clientId);
      checkEqual(
        [state.results.length, state.watermarks],
        [1, [5]],
        'five pushes leave the last request result and one watermark row',
      );
      const replay = await ctx.rawSyncBytes(
        a.actorId,
        requestCarrying(a, last),
      );
      check(
        replay.ok &&
          cached(pushOutcome(responsePushResults(replay.message)[0])),
        'the retained result is the last commit',
      );
    },
  },

  {
    name: 'watermark/sender-without-outbox-keeps-its-results',
    specRefs: ['§6.3.2', '§6.10'],
    requires: ['idempotency-state'],
    async run(ctx) {
      for (const id of ['A', 'B', 'C']) await push(ctx, 'producer', [[id, 0]]);
      // Another sender's outbox raises only its own watermark.
      await push(ctx, 'replica', [['R', 7]], 'outbox-r');
      checkEqual(
        await stored(ctx, 'producer'),
        { results: ['A', 'B', 'C'], watermarks: [] },
        'no rule deletes the results of a sender without an outbox',
      );
      check(
        (await push(ctx, 'producer', [['A', 0]])).every(cached),
        'the first result still replays',
      );
    },
  },

  {
    name: 'watermark/budget-cut-defers-the-pre-upgrade-settlement',
    specRefs: ['§6.3.2', '§7.1', '§9'],
    requires: ['idempotency-state'],
    async run(ctx) {
      await push(ctx, 'legacy', [
        ['A', 0],
        ['B', 0],
        ['C', 0],
      ]);
      // The first version 4 request carries only A: a push budget cut it.
      check(
        (await push(ctx, 'legacy', [['A', 1]], 'outbox-1')).every(cached),
        'A replays',
      );
      checkEqual(
        await stored(ctx, 'legacy'),
        { results: ['A@1', 'B', 'C'], watermarks: [1] },
        'its last commit matched a pre-upgrade result: B and C stay (§9)',
      );
      const maxSeq = await ctx.server.getMaxCommitSeq();
      check(
        (
          await push(
            ctx,
            'legacy',
            [
              ['B', 2],
              ['C', 3],
            ],
            'outbox-1',
          )
        ).every(cached),
        'B and C replay instead of applying twice',
      );
      checkEqual(
        await ctx.server.getMaxCommitSeq(),
        maxSeq,
        'nothing applied twice',
      );
      checkEqual(
        await stored(ctx, 'legacy'),
        { results: ['B@2', 'C@3'], watermarks: [2] },
        'the second request settles B and C',
      );
    },
  },

  {
    name: 'watermark/reused-commit-id-after-its-result-expired',
    specRefs: ['§2.3', '§6.3.2'],
    requires: ['idempotency-state'],
    async run(ctx) {
      const [applied] = await push(ctx, 'reuser', [['A', 1]], 'outbox-1');
      // A request whose first sequence passes A's deletes A's result in
      // step 2; A, reused at a higher sequence, then has no retained result.
      const outcomes = await push(
        ctx,
        'reuser',
        [
          ['C', 3],
          ['A', 4],
        ],
        'outbox-1',
      );
      check(
        !cached(outcomes[1]) && outcomes[1] !== undefined,
        'a deleted result is never replayed (§6.3.2 step 3)',
      );
      checkEqual(
        await stored(ctx, 'reuser'),
        { results: ['A@4', 'C@3'], watermarks: [3] },
        'A is processed at its new sequence and stored with it',
      );
      check(
        JSON.stringify(outcomes[1]) !== JSON.stringify(applied),
        'the answer is not the deleted result',
      );
    },
  },
];
