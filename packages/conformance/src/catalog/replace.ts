/**
 * Replacing a pending commit before the server applies it (SPEC.md §7.2.3),
 * the send-attempt marker (§7.1) and `FENCE_COMMIT` (§6.12).
 */
import { check, checkEqual } from '../checks';
import type { DriverCommitDelivery } from '../driver';
import { FIXTURE_SCHEMA, task } from '../fixture';
import { rawPushCommit, rawUpsert, responsePushResults } from '../raw';
import { type ClientHandle, type Scenario, ScenarioSkip } from '../scenario';
import { syncFails, syncIdle, syncOk } from './util';

const P1 = { project_id: ['p1'] } as const;
const U1 = { project_id: 'p1' } as const;

async function delivery(
  handle: ClientHandle,
  clientCommitId: string,
): Promise<DriverCommitDelivery | undefined> {
  if (!handle.api.snapshotRead)
    throw new ScenarioSkip('the client host has no snapshot read');
  return (
    await handle.api.snapshotRead({
      statements: [],
      commitIds: [clientCommitId],
    })
  ).deliveries[0];
}

async function failure(run: () => Promise<unknown>): Promise<{
  readonly code: string;
  readonly details: unknown;
}> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ScenarioSkip) throw error;
    const failed = error as { code?: string; details?: unknown };
    return { code: failed.code ?? '', details: failed.details };
  }
  return { code: '', details: undefined };
}

async function serverTitles(
  ctx: Parameters<Scenario['run']>[0],
): Promise<Record<string, unknown>> {
  return Object.fromEntries(
    (await ctx.server.readRows('tasks')).map((row) => [
      row.rowId,
      row.values['title'],
    ]),
  );
}

export const replaceScenarios: readonly Scenario[] = [
  {
    name: 'gate/pull-pushes-nothing-then-open-pushes-the-replacement',
    specRefs: ['§8.8', '§7.2.3'],
    async run(ctx) {
      const a = await ctx.newClient({
        actorId: 'a',
        clientId: 'pull-replace',
        allowed: P1,
        transportGate: 'pull',
      });
      await a.api.subscribe(U1);
      const sealed = await a.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('t1', 'p1', 'sealed') },
      ]);
      await syncIdle(a);
      checkEqual(await serverTitles(ctx), {}, 'a pull round pushes nothing');
      const sent = a.sentRequests.length;
      const next = await a.api.replacePendingCommit(
        sealed,
        [{ op: 'upsert', table: 'tasks', values: task('t1', 'p1', 'decided') }],
        'pull-replace-next',
      );
      checkEqual(next, 'pull-replace-next', 'the page-minted id returns');
      checkEqual(
        a.sentRequests.length,
        sent,
        'a never-attempted commit needs no fence',
      );
      await a.api.setTransportGate('open');
      await syncIdle(a);
      checkEqual(
        await serverTitles(ctx),
        { t1: 'decided' },
        'open pushes only the replacement',
      );
      checkEqual(
        (await ctx.server.readRows('tasks')).map((row) => row.version),
        [1],
        'the replacement of a local creation arrives as an insert',
      );
    },
  },
  {
    name: 'replace/never-sent-needs-no-fence',
    specRefs: ['§7.2.3', '§7.2.1'],
    async run(ctx) {
      const a = await ctx.newClient({
        actorId: 'a',
        clientId: 'never-sent',
        allowed: P1,
        transportGate: 'closed',
      });
      await a.api.subscribe(U1);
      const original = await a.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('t1', 'p1', 'first') },
      ]);
      const next = await a.api.replacePendingCommit(
        original,
        [{ op: 'upsert', table: 'tasks', values: task('t1', 'p1', 'second') }],
        'never-sent-next',
      );
      checkEqual(a.sentRequests.length, 0, 'no request leaves');
      checkEqual(
        await a.api.pendingCommitIds(),
        [next],
        'the replacement holds the original position',
      );
      const old = await delivery(a, original);
      checkEqual(
        old?.status === 'known'
          ? {
              status: old.outcome.status,
              resolution: old.outcome.resolution,
              replacement: old.outcome.replacementClientCommitId,
            }
          : old?.status,
        { status: 'replaced', resolution: 'superseded', replacement: next },
        'the original reports replaced with the new id',
      );
      checkEqual(
        (await delivery(a, next))?.status,
        'pending',
        'the replacement is pending',
      );
      checkEqual(
        (await a.api.commitOutcomes())
          .filter((outcome) => outcome.clientCommitId === original)
          .map((outcome) => [
            outcome.status,
            outcome.resolution,
            outcome.replacementClientCommitId,
          ]),
        [['replaced', 'superseded', next]],
        'the outcome list reports replaced',
      );
      checkEqual(
        (await a.api.rejections()).filter(
          (rejection) => rejection.clientCommitId === original,
        ),
        [],
        'a replaced commit is no rejection',
      );
      checkEqual(
        await a.api.conflicts(),
        [],
        'a replaced commit is no conflict',
      );
      checkEqual(
        await a.api.replacePendingCommit(
          original,
          [
            {
              op: 'upsert',
              table: 'tasks',
              values: task('t1', 'p1', 'second'),
            },
          ],
          'never-sent-next',
        ),
        next,
        'a retry with the same id is idempotent',
      );
    },
  },
  {
    name: 'fence/before-the-original-arrives',
    specRefs: ['§6.12', '§7.1', '§7.2.3'],
    async run(ctx) {
      const a = await ctx.newClient({
        actorId: 'a',
        clientId: 'fence-before',
        allowed: P1,
      });
      await a.api.subscribe(U1);
      await syncIdle(a);
      const original = await a.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('t1', 'p1', 'lost') },
      ]);
      a.faults.dropNextRequests = 1;
      await syncFails(
        a,
        'transport.lost',
        'the request is lost before the server',
      );
      await a.api.setTransportGate('pull');
      const sent = a.sentRequests.length;
      const next = await a.api.replacePendingCommit(
        original,
        [{ op: 'upsert', table: 'tasks', values: task('t1', 'p1', 'fenced') }],
        'fence-before-next',
      );
      check(
        a.sentRequests.length > sent,
        'an attempted commit is fenced first',
      );
      await a.api.setTransportGate('open');
      await syncIdle(a);
      checkEqual(
        await serverTitles(ctx),
        { t1: 'fenced' },
        'the server holds the replacement',
      );
      checkEqual(
        (await delivery(a, next))?.status,
        'known',
        'the replacement settles',
      );
      const replay = await ctx.rawSync(
        'a',
        [
          rawPushCommit(original, [
            rawUpsert(FIXTURE_SCHEMA, 'tasks', task('t1', 'p1', 'lost'), 1),
          ]),
        ],
        { clientId: 'fence-before' },
      );
      check(replay.ok, 'the raw push answers');
      const result = replay.ok
        ? responsePushResults(replay.message)[0]
        : undefined;
      checkEqual(
        result?.results[0]?.status === 'error'
          ? [result.status, result.results[0].code, result.results[0].retryable]
          : result?.status,
        ['rejected', 'sync.commit_fenced', false],
        'a push of the fenced id is refused',
      );
      checkEqual(
        await serverTitles(ctx),
        { t1: 'fenced' },
        'the fenced original applies nothing',
      );
    },
  },
  {
    name: 'fence/after-the-original-applied',
    specRefs: ['§6.12', '§7.2.3'],
    async run(ctx) {
      const a = await ctx.newClient({
        actorId: 'a',
        clientId: 'fence-after',
        allowed: P1,
      });
      await a.api.subscribe(U1);
      await syncIdle(a);
      const original = await a.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('t1', 'p1', 'applied') },
      ]);
      a.faults.dropNextResponses = 1;
      await syncFails(
        a,
        'transport.lost',
        'the reply is lost after the server applied',
      );
      checkEqual(
        await failure(() =>
          a.api.replacePendingCommit(
            original,
            [
              {
                op: 'upsert',
                table: 'tasks',
                values: task('t1', 'p1', 'too late'),
              },
            ],
            'fence-after-next',
          ),
        ),
        {
          code: 'client.commit_settled',
          details: { clientCommitId: original, status: 'applied' },
        },
        'the fence answers the stored receipt',
      );
      checkEqual(
        await a.api.pendingCommitIds(),
        [],
        'the receipt acknowledges the original',
      );
      checkEqual(
        (await a.api.readRows('tasks')).map((row) => row.values['title']),
        ['applied'],
        'local reads keep the original',
      );
      checkEqual(
        (await delivery(a, 'fence-after-next'))?.status,
        'unknown',
        'no replacement exists',
      );
    },
  },
  {
    name: 'fence/interrupted-replace-fences-again',
    specRefs: ['§6.12', '§7.2.3'],
    async run(ctx) {
      const a = await ctx.newClient({
        actorId: 'a',
        clientId: 'fence-crash',
        allowed: P1,
      });
      if (!a.api.executeStorageSql)
        throw new ScenarioSkip('the client host has no storage fault seam');
      await a.api.subscribe(U1);
      await syncIdle(a);
      const original = await a.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('t1', 'p1', 'lost') },
      ]);
      a.faults.dropNextRequests = 1;
      await syncFails(a, 'transport.lost', 'the request is lost');
      // The local replace transaction fails after the fence answered.
      await a.api.executeStorageSql(
        "CREATE TRIGGER block_journal BEFORE INSERT ON _syncular_commit_outcomes BEGIN SELECT RAISE(ABORT, 'blocked'); END",
      );
      const ops = [
        {
          op: 'upsert' as const,
          table: 'tasks',
          values: task('t1', 'p1', 'second try'),
        },
      ];
      check(
        (
          await failure(() =>
            a.api.replacePendingCommit(original, ops, 'fence-crash-next'),
          )
        ).code !== '',
        'the interrupted replace fails',
      );
      checkEqual(
        await a.api.pendingCommitIds(),
        [original],
        'the original stays pending and attempted',
      );
      await a.api.executeStorageSql('DROP TRIGGER block_journal');
      checkEqual(
        await a.api.replacePendingCommit(original, ops, 'fence-crash-next'),
        'fence-crash-next',
        'asking again fences again and replaces',
      );
      await syncIdle(a);
      checkEqual(
        await serverTitles(ctx),
        { t1: 'second try' },
        'the server holds the replacement',
      );
    },
  },
  {
    name: 'replace/then-push-keeps-the-outbox-order',
    specRefs: ['§7.2.3', '§7.1'],
    async run(ctx) {
      const a = await ctx.newClient({
        actorId: 'a',
        clientId: 'replace-order',
        allowed: P1,
        transportGate: 'closed',
      });
      await a.api.subscribe(U1);
      const first = await a.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('t1', 'p1', 'first') },
      ]);
      const later = await a.api.mutate([
        { op: 'patch', table: 'tasks', values: { id: 't1', title: 'later' } },
      ]);
      const next = await a.api.replacePendingCommit(
        first,
        [
          {
            op: 'upsert',
            table: 'tasks',
            values: task('t1', 'p1', 'replaced'),
          },
        ],
        'replace-order-next',
      );
      checkEqual(
        await a.api.pendingCommitIds(),
        [next, later],
        'the replacement keeps the original position',
      );
      await a.api.setTransportGate('open');
      const result = await syncOk(a);
      checkEqual(result.applied, [next, later], 'the queue pushes in order');
      checkEqual(
        await serverTitles(ctx),
        { t1: 'later' },
        'the later commit applies after the replacement',
      );
    },
  },
  {
    name: 'replace/dependent-later-intent-re-derives',
    specRefs: ['§7.2.3', '§7.2'],
    async run(ctx) {
      const a = await ctx.newClient({
        actorId: 'a',
        clientId: 'replace-derive',
        allowed: P1,
      });
      await a.api.subscribe(U1);
      await a.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('t1', 'p1', 'base') },
      ]);
      await syncIdle(a);
      await a.api.setTransportGate('closed');
      const titled = await a.api.mutate([
        { op: 'patch', table: 'tasks', values: { id: 't1', title: 'mine' } },
      ]);
      await a.api.mutate([
        { op: 'patch', table: 'tasks', values: { id: 't1', priority: 7 } },
      ]);
      await a.api.replacePendingCommit(
        titled,
        [
          {
            op: 'patch',
            table: 'tasks',
            values: { id: 't1', title: 'decided' },
          },
        ],
        'replace-derive-next',
      );
      checkEqual(
        (await a.api.readRows('tasks')).map((row) => [
          row.values['title'],
          row.values['priority'],
        ]),
        [['decided', 7]],
        'the overlay shows the replacement and the later column',
      );
      await a.api.setTransportGate('open');
      await syncIdle(a);
      checkEqual(
        (await ctx.server.readRows('tasks')).map((row) => [
          row.values['title'],
          row.values['priority'],
          row.version,
        ]),
        [['decided', 7, 3]],
        'the server chains the later commit on the replacement',
      );
    },
  },
  {
    name: 'fence/an-older-server-refuses-and-nothing-changes',
    specRefs: ['§6.12', '§9'],
    async run(ctx) {
      const a = await ctx.newClient({
        actorId: 'a',
        clientId: 'fence-old-server',
        allowed: P1,
      });
      await a.api.subscribe(U1);
      await syncIdle(a);
      const original = await a.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('t1', 'p1', 'lost') },
      ]);
      a.faults.dropNextRequests = 1;
      await syncFails(a, 'transport.lost', 'the request is lost');
      // A server that predates 0x09 skips it: the harness re-encodes the
      // request through the general codec, which drops the unknown frame.
      a.faults.skipRequestFrames = ['ADOPT_EPOCH'];
      const refused = await failure(() =>
        a.api.replacePendingCommit(
          original,
          [{ op: 'upsert', table: 'tasks', values: task('t1', 'p1', 'x') }],
          'fence-old-next',
        ),
      );
      a.faults.skipRequestFrames = [];
      checkEqual(
        refused.code,
        'sync.invalid_request',
        'the refusal surfaces with its code',
      );
      checkEqual(
        await a.api.pendingCommitIds(),
        [original],
        'the commit is unchanged',
      );
      checkEqual(
        (await delivery(a, 'fence-old-next'))?.status,
        'unknown',
        'no replacement exists',
      );
    },
  },
];
