/**
 * Offline outbox, replay, and idempotency under transport and storage faults
 * (SPEC.md §2.3, §6.3, §7; Appendix B.2/B.3). Faults target the transport
 * seam or client storage; the server is never told a fault happened.
 */
import { decodeMessage } from '@syncular/core';
import { check, checkEqual } from '../checks';
import { FIXTURE_SCHEMA, task } from '../fixture';
import { responsePushResults } from '../raw';
import type { ClientLimitsOptions, DriverSchema } from '../driver';
import type { Scenario } from '../scenario';
import {
  expectConverged,
  seedTasks,
  syncFails,
  syncIdle,
  syncOk,
} from './util';

const P1 = { project_id: ['p1'] } as const;
const UNIQUE_SCHEMA: DriverSchema = {
  version: 1,
  tables: [
    {
      name: 'tasks',
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'project_id', type: 'string', nullable: false },
        { name: 'title', type: 'string', nullable: false },
        { name: 'done', type: 'boolean', nullable: false },
      ],
      primaryKey: 'id',
      scopes: [{ pattern: 'project:{project_id}' }],
      indexes: [
        {
          name: 'idx_tasks_project_title',
          columns: ['project_id', 'title'],
          unique: true,
        },
      ],
    },
  ],
};

async function bootstrapped(
  ctx: Parameters<Scenario['run']>[0],
  actorId: string,
  clientId: string,
  limits?: ClientLimitsOptions,
) {
  const handle = await ctx.newClient({
    actorId,
    clientId,
    allowed: P1,
    ...(limits !== undefined ? { limits } : {}),
  });
  await handle.api.subscribe({ id: 'tasks', table: 'tasks', scopes: P1 });
  await syncIdle(handle);
  return handle;
}

export const offlineScenarios: readonly Scenario[] = [
  {
    name: 'offline/unsafe-row-integers-refuse-before-queuing',
    specRefs: ['§2.4', '§7.1'],
    async run(ctx) {
      const a = await ctx.newClient({
        actorId: 'a',
        clientId: 'safe-integers',
        allowed: P1,
      });
      const id = await a.api.mutate([
        {
          op: 'upsert',
          table: 'tasks',
          values: task('kept', 'p1', 'safe', false, Number.MAX_SAFE_INTEGER),
        },
      ]);
      const before = await a.api.readRows('tasks');
      check(a.api.patch !== undefined, 'sparse authoring is available');
      for (const priority of [
        Number.MAX_SAFE_INTEGER + 1,
        Number.MIN_SAFE_INTEGER - 1,
      ]) {
        for (const patch of [false, true]) {
          let refused = false;
          try {
            if (patch) await a.api.patch('tasks', 'kept', { priority });
            else
              await a.api.mutate([
                {
                  op: 'upsert',
                  table: 'tasks',
                  values: task('unsafe', 'p1', 'unsafe', false, priority),
                },
              ]);
          } catch {
            refused = true;
          }
          check(refused, 'unsafe row integers fail before authoring');
          checkEqual(
            await a.api.pendingCommitIds(),
            [id],
            'only the safe commit is queued',
          );
          checkEqual(
            await a.api.readRows('tasks'),
            before,
            'failed authoring preserves the safe row',
          );
        }
      }
    },
  },
  {
    name: 'offline/replay-failure-preserves-earlier-ack-boundary',
    specRefs: ['§7.1', '§7.2.1', '§7.5'],
    async run(ctx) {
      await seedTasks(ctx, [task('occupied', 'p1', 'server')]);
      const a = await bootstrapped(ctx, 'a', 'replay');
      check(
        a.api.executeStorageSql !== undefined,
        'storage faults are available',
      );
      check(
        a.api.drainChangeBatches !== undefined,
        'change batches are available',
      );
      const first = await a.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('first', 'p1') },
      ]);
      const rejected = await a.api.mutate([
        {
          op: 'upsert',
          table: 'tasks',
          values: task('occupied', 'p1', 'local'),
          baseVersion: 0,
        },
      ]);
      const later = await a.api.mutate([
        {
          op: 'upsert',
          table: 'tasks',
          values: task('occupied', 'p1', 'later'),
        },
      ]);
      const rows = await a.api.readRows('tasks');
      const subscription = await a.api.subscriptionState('tasks');
      await a.api.drainChangeBatches();
      // The first ACK leaves two pending commits. Only the rejection's replay
      // reaches this fault, after its provisional outbox removal.
      await a.api.executeStorageSql(
        "CREATE TRIGGER fail_replay BEFORE INSERT ON tasks WHEN new.id='occupied' AND (SELECT count(*) FROM _syncular_outbox)=1 BEGIN SELECT RAISE(ABORT,'replay failed'); END",
      );
      await syncFails(
        a,
        'client.outcome_persistence_failed',
        'rejection replay',
      );
      checkEqual(
        await a.api.pendingCommitIds(),
        [rejected, later],
        'earlier ACK remains durable',
      );
      checkEqual(
        await a.api.readRows('tasks'),
        rows,
        'failing rejection restores visible state',
      );
      checkEqual(
        await a.api.subscriptionState('tasks'),
        subscription,
        'later pull never advances',
      );
      checkEqual(
        (await a.api.commitOutcomes()).map((outcome) => outcome.clientCommitId),
        [first],
        'only the completed ACK persists',
      );
      checkEqual(
        await a.api.conflicts(),
        [],
        'failing rejection publishes no conflict',
      );
      const batches = (await a.api.drainChangeBatches()).filter(
        (batch) => batch.outcomesChanged,
      );
      checkEqual(
        batches.map((batch) => batch.status?.outbox),
        [2],
        'only the earlier ACK publishes',
      );
      await a.api.executeStorageSql('DROP TRIGGER fail_replay');
      await ctx.recreateClient(a, FIXTURE_SCHEMA);
      checkEqual(
        await a.api.pendingCommitIds(),
        [rejected, later],
        'restart preserves the failed boundary',
      );
      const report = await syncOk(a);
      checkEqual(
        report.rejected,
        [rejected],
        'retry persists the original rejection',
      );
      checkEqual(
        await a.api.pendingCommitIds(),
        [],
        'retry drains remaining intent',
      );
      await syncIdle(a);
      await expectConverged(ctx, 'tasks', [a], {
        variable: 'project_id',
        values: ['p1'],
      });
    },
  },
  {
    name: 'offline/replay-trigger-refuses-reopen-without-partial-overlay',
    specRefs: ['§7.1', '§7.5'],
    async run(ctx) {
      const a = await ctx.newClient({
        actorId: 'a',
        clientId: 'replay',
        allowed: P1,
      });
      check(
        a.api.executeStorageSql !== undefined,
        'reference clients expose deterministic storage faults',
      );
      check(
        a.api.localRevision !== undefined,
        'reference clients expose local revisions',
      );
      const ids = [];
      for (const id of ['early', 'bad'])
        ids.push(
          await a.api.mutate([
            { op: 'upsert', table: 'tasks', values: task(id, 'p1') },
          ]),
        );
      const rows = await a.api.readRows('tasks');
      const revision = await a.api.localRevision();
      await a.api.executeStorageSql(
        "CREATE TRIGGER fail_replay BEFORE INSERT ON tasks WHEN new.id='bad' BEGIN SELECT RAISE(ABORT,'replay failed'); END",
      );
      let refused = false;
      try {
        await ctx.recreateClient(a, FIXTURE_SCHEMA);
      } catch {
        refused = true;
      }
      check(refused, '§7.1 replay errors refuse reopen');
      await a.api.executeStorageSql('DROP TRIGGER fail_replay');
      await ctx.recreateClient(a, FIXTURE_SCHEMA);
      checkEqual(
        await a.api.readRows('tasks'),
        rows,
        '§7.1 failed replay leaves no partial visible table',
      );
      checkEqual(
        await a.api.pendingCommitIds(),
        ids,
        '§7.1 refusal retains durable intent',
      );
      checkEqual(
        await a.api.localRevision(),
        revision,
        '§7.5 failed replay publishes no revision',
      );
      await syncIdle(a);
      checkEqual(
        await a.api.pendingCommitIds(),
        [],
        'retry delivers retained intent',
      );
    },
  },
  {
    name: 'offline/restore-failure-preserves-later-intent',
    specRefs: ['§7.1', '§7.2', '§7.5'],
    async run(ctx) {
      await seedTasks(ctx, [task('occupied', 'p1', 'server')]);
      const a = await bootstrapped(ctx, 'a', 'replay');
      check(
        a.api.executeStorageSql !== undefined,
        'storage faults are available',
      );
      check(
        a.api.drainChangeBatches !== undefined,
        'change batches are available',
      );
      const rejected = await a.api.mutate([
        {
          op: 'upsert',
          table: 'tasks',
          values: task('occupied', 'p1', 'local'),
          baseVersion: 0,
        },
      ]);
      const later = await a.api.mutate([
        {
          op: 'upsert',
          table: 'tasks',
          values: task('occupied', 'p1', 'later'),
        },
      ]);
      const rows = await a.api.readRows('tasks');
      const subscription = await a.api.subscriptionState('tasks');
      await a.api.drainChangeBatches();
      // The rejection's necessary replay of the later commit is the only
      // write that reaches this fault, after its provisional outbox removal.
      await a.api.executeStorageSql(
        "CREATE TRIGGER fail_replay BEFORE INSERT ON tasks WHEN new.id='occupied' AND (SELECT count(*) FROM _syncular_outbox)=1 BEGIN SELECT RAISE(ABORT,'replay failed'); END",
      );
      await syncFails(
        a,
        'client.outcome_persistence_failed',
        'rejection replay',
      );
      checkEqual(
        await a.api.pendingCommitIds(),
        [rejected, later],
        'failed reconciliation retains every pending commit',
      );
      checkEqual(
        await a.api.readRows('tasks'),
        rows,
        'failed reconciliation restores visible state',
      );
      checkEqual(
        await a.api.subscriptionState('tasks'),
        subscription,
        'failed reconciliation advances no pull cursor',
      );
      checkEqual(
        await a.api.commitOutcomes(),
        [],
        'failed reconciliation persists no outcome',
      );
      const changes = await a.api.drainChangeBatches();
      check(
        changes.every(
          (batch) => batch.tables.length === 0 && !batch.outcomesChanged,
        ),
        'failed reconciliation publishes no successful apply batch',
      );
      await a.api.executeStorageSql('DROP TRIGGER fail_replay');
      const report = await syncOk(a);
      checkEqual(
        report.rejected,
        [rejected],
        'retry persists the original rejection',
      );
      checkEqual(
        await a.api.pendingCommitIds(),
        [],
        'retry drains remaining intent',
      );
      await syncIdle(a);
      await expectConverged(ctx, 'tasks', [a], {
        variable: 'project_id',
        values: ['p1'],
      });
    },
  },
  {
    name: 'offline/explicit-transport-gate-local-writes-and-resume',
    specRefs: ['§8.8', '§7.1'],
    async run(ctx) {
      const a = await ctx.newClient({
        actorId: 'a',
        clientId: 'gate',
        allowed: P1,
        transportEnabled: false,
      });
      await a.api.subscribe({ id: 'tasks', table: 'tasks', scopes: P1 });
      const first = await a.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('t1', 'p1', 'first') },
      ]);
      const second = await a.api.mutate([
        { op: 'patch', table: 'tasks', values: { id: 't1', title: 'second' } },
      ]);
      await syncFails(a, 'sync.offline', 'closed gate');
      let code = '';
      try {
        await a.api.connectRealtime();
      } catch (error) {
        code = (error as { code?: string }).code ?? '';
      }
      checkEqual(code, 'sync.offline', 'realtime is gated');
      checkEqual(a.sentRequests.length, 0, 'no sync transport invoked');
      checkEqual(
        await a.api.pendingCommitIds(),
        [first, second],
        'two commits queue FIFO',
      );
      checkEqual(
        (await a.api.readRows('tasks'))[0]?.values.title,
        'second',
        'local reads see latest intent',
      );
      check(
        !(await a.api.drainSyncIntents!()).some((i) => i.kind !== 'none'),
        'closed gate emits no scheduler wake',
      );
      await a.api.setTransportEnabled(true);
      checkEqual(
        await a.api.drainSyncIntents!(),
        [{ kind: 'interactive' }],
        'resume has one wake',
      );
      await a.api.setTransportEnabled(true);
      checkEqual(await a.api.drainSyncIntents!(), [], 'resume is idempotent');
      const result = await syncOk(a);
      checkEqual(result.applied, [first, second], 'resume sends FIFO');
      await syncIdle(a);
      await expectConverged(ctx, 'tasks', [a], {
        variable: 'project_id',
        values: ['p1'],
      });
    },
  },
  {
    name: 'offline/transport-close-preserves-captured-reply-and-revocation',
    specRefs: ['§8.8', '§7.3.4'],
    async run(ctx) {
      for (const realtime of [false, true]) {
        for (const revoke of [false, true]) {
          const a = await bootstrapped(
            ctx,
            `actor-${revoke}-${realtime}`,
            `client-${revoke}-${realtime}`,
          );
          if (realtime) {
            await a.api.connectRealtime();
            await syncIdle(a);
          }
          check(
            a.api.prepareRound !== undefined &&
              a.api.completeRound !== undefined,
            'driver has deterministic round barrier',
          );
          const commit = await a.api.mutate([
            {
              op: 'upsert',
              table: 'tasks',
              values: task(`t-${revoke}`, 'p1', 'accepted'),
            },
          ]);
          if (revoke) await ctx.server.setAllowedScopes(a.actorId, {});
          await a.api.prepareRound!();
          await a.api.setTransportEnabled(false);
          const result = await a.api.completeRound!();
          check(
            result.ok,
            `captured reply still applies (realtime=${realtime}, revoke=${revoke}): ${JSON.stringify(result)}`,
          );
          if (revoke) {
            checkEqual(
              await a.api.readRows('tasks'),
              [],
              'in-flight revocation purges local data',
            );
          } else {
            checkEqual(
              await a.api.pendingCommitIds(),
              [],
              'in-flight ack drains accepted commit',
            );
            check(
              (await a.api.commitOutcomes()).some(
                (o) => o.clientCommitId === commit,
              ),
              'outcome remains available',
            );
          }
          const count = a.sentRequests.length;
          await syncFails(a, 'sync.offline', 'no follow-up round');
          checkEqual(
            a.sentRequests.length,
            count,
            'paused follow-up never invokes transport',
          );
          await a.api.setTransportEnabled(true);
          await syncIdle(a);
        }
      }
    },
  },
  {
    name: 'offline/local-unique-violation-is-atomic',
    specRefs: ['§7.1'],
    server: { schema: UNIQUE_SCHEMA },
    async run(ctx) {
      const client = await ctx.newClient({
        actorId: 'actor',
        clientId: 'local-unique',
        schema: UNIQUE_SCHEMA,
        allowed: P1,
      });
      let code: unknown;
      try {
        await client.api.mutate([
          {
            op: 'upsert',
            table: 'tasks',
            values: { id: 't1', project_id: 'p1', title: 'same', done: false },
          },
          {
            op: 'upsert',
            table: 'tasks',
            values: { id: 't2', project_id: 'p1', title: 'same', done: false },
          },
        ]);
      } catch (error) {
        if (error instanceof Error && 'code' in error) code = error.code;
      }
      checkEqual(
        code,
        'sync.constraint_violation',
        'local unique violation has a stable error code',
      );
      checkEqual(
        await client.api.pendingCommitIds(),
        [],
        'failed commit leaves no outbox entry',
      );
      checkEqual(
        await client.api.readRows('tasks'),
        [],
        'failed commit leaves no optimistic rows',
      );
    },
  },
  {
    // §7.1/§7.5: a storage failure during authoring surfaces a structured,
    // non-retryable failure with its numeric SQLite evidence, leaves no
    // orphaned outbox entry or revision, and succeeds on retry once cleared.
    name: 'offline/authoring-storage-failure-is-typed-and-atomic',
    specRefs: ['§7.1', '§7.5', '§6.1'],
    async run(ctx) {
      const client = await ctx.newClient({
        actorId: 'actor',
        clientId: 'storage-typed',
        allowed: P1,
      });
      check(
        client.api.executeStorageSql !== undefined,
        'owned storage SQL is available',
      );
      check(
        client.api.localRevision !== undefined,
        'reference clients expose local revisions',
      );
      const revision = await client.api.localRevision();
      await client.api.executeStorageSql('PRAGMA max_page_count = 1');

      let code: unknown;
      let retryable: unknown;
      let details: unknown;
      try {
        await client.api.mutate([
          {
            op: 'upsert',
            table: 'tasks',
            values: task('typed', 'p1', 'full '.repeat(32768)),
          },
        ]);
      } catch (error) {
        if (error instanceof Error && 'code' in error) code = error.code;
        if (typeof error === 'object' && error !== null) {
          if ('retryable' in error) retryable = error.retryable;
          if ('details' in error) details = error.details;
        }
      }
      checkEqual(
        code,
        'client.storage_full',
        'the mutation reports the storage code',
      );
      checkEqual(retryable, false, 'the storage failure is not retryable');
      const sqliteCode =
        typeof details === 'object' &&
        details !== null &&
        'sqliteCode' in details
          ? details.sqliteCode
          : undefined;
      checkEqual(sqliteCode, 13, 'the numeric SQLite code survives');
      checkEqual(
        await client.api.pendingCommitIds(),
        [],
        'the failed authoring call leaves no outbox entry',
      );
      checkEqual(
        await client.api.localRevision(),
        revision,
        'the failed authoring call publishes no revision',
      );
      checkEqual(
        (await client.api.readRows('tasks')).length,
        0,
        'the failed authoring call leaves no visible row',
      );

      await client.api.executeStorageSql('PRAGMA max_page_count = 1073741823');
      const id = await client.api.mutate([
        {
          op: 'upsert',
          table: 'tasks',
          values: task('typed', 'p1', 'recovered'),
        },
      ]);
      check(
        typeof id === 'string' && id.length > 0,
        'retry enqueues the commit',
      );
      await syncIdle(client);
      checkEqual(
        await client.api.pendingCommitIds(),
        [],
        'the retry drains after the fault clears',
      );
    },
  },
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
  {
    name: 'offline/local-mutation-during-captured-round',
    specRefs: ['§7.1', '§8.4'],
    async run(ctx) {
      const a = await bootstrapped(ctx, 'actor-a', 'inflight');
      check(
        a.api.prepareRound !== undefined && a.api.completeRound !== undefined,
        'driver exposes captured-round barrier',
      );
      const first = await a.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('one', 'p1', 'first') },
      ]);
      await a.api.prepareRound!();
      const second = await a.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('one', 'p1', 'newer') },
        { op: 'upsert', table: 'tasks', values: task('two', 'p1', 'second') },
      ]);
      checkEqual(
        (await a.api.readRows('tasks')).map((row) => row.rowId),
        ['one', 'two'],
        'both local writes remain readable while reply is pending',
      );
      const report = await a.api.completeRound!();
      check(report.ok, 'captured round applies');
      if (report.ok)
        checkEqual(
          report.report.applied,
          [first],
          'captured request acknowledges only its original commit',
        );
      checkEqual(
        await a.api.pendingCommitIds(),
        [second],
        'mid-round local commit remains queued',
      );
      checkEqual(
        (await a.api.readRows('tasks')).find((row) => row.rowId === 'one')
          ?.values.title,
        'newer',
        'apply replays the newer local write over the acknowledged base',
      );
      await syncIdle(a);
      checkEqual(
        await a.api.pendingCommitIds(),
        [],
        'next round drains the new commit',
      );
      await expectConverged(ctx, 'tasks', [a]);
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
          const capacity = await a.api.sync();
          check(!capacity.ok, 'oversized first commit is a capacity error');
          if (!capacity.ok) {
            checkEqual(
              capacity.errorCode,
              'client.push_request_too_large',
              'typed capacity code',
            );
            checkEqual(capacity.details?.kind, 'operations', 'operation kind');
          }
          checkEqual(
            await a.api.pendingCommitIds(),
            [first, second, third],
            'whole outbox survives the capacity error',
          );
          checkEqual(
            await ctx.server.getMaxCommitSeq(),
            0,
            'capacity error sent no request',
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
          operationCount > 500 ? [] : [[first], [first], [second, third]],
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

  {
    // §7.7: the aggregate spans every round. Round 1 defers the second commit,
    // so the run is not idle after two rounds even though `bootstrapping` is
    // empty; the delivered commits keep it going.
    name: 'offline/sync-budget-aggregates-across-rounds',
    specRefs: ['§7.7', '§6.1'],
    async run(ctx) {
      const a = await bootstrapped(ctx, 'actor-a', 'client-a');
      const commits = await Promise.all([
        a.api.mutate(
          Array.from({ length: 300 }, (_, index) => ({
            op: 'upsert' as const,
            table: 'tasks',
            values: task(`first-${index}`, 'p1'),
          })),
        ),
        a.api.mutate(
          Array.from({ length: 300 }, (_, index) => ({
            op: 'upsert' as const,
            table: 'tasks',
            values: task(`second-${index}`, 'p1'),
          })),
        ),
      ]);
      const capped = await a.api.syncUntilIdle(2);
      check(capped.ok, 'a capped run is a partial success, not an error');
      if (capped.ok) {
        checkEqual(capped.budgetExhausted, true, 'the cap reports exhaustion');
        checkEqual(
          capped.report.pushed,
          2,
          'the aggregate sums the commits pushed across both rounds',
        );
        checkEqual(
          capped.report.applied,
          commits,
          'the aggregate retains every acknowledged commit in order',
        );
        checkEqual(
          capped.report.bootstrapping,
          [],
          'the aggregate has no pending bootstrap but is still not idle',
        );
        checkEqual(
          capped.report.deferredCommits ?? 0,
          0,
          'deferredCommits is latest-state, not a summed total',
        );
      }
      checkEqual(
        await a.api.pendingCommitIds(),
        [],
        'both rounds drained the outbox',
      );
    },
  },
  {
    name: 'offline/push-request-byte-cap-defers-a-later-commit',
    specRefs: ['§7.1'],
    async run(ctx) {
      const a = await bootstrapped(ctx, 'actor-a', 'client-a', {
        maxPushRequestBytes: 10_000,
      });
      const small = await a.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('small', 'p1') },
      ]);
      const huge = await a.api.mutate([
        {
          op: 'upsert',
          table: 'tasks',
          values: task('huge', 'p1', 'x'.repeat(50_000)),
        },
      ]);
      const first = await syncOk(a);
      checkEqual(first.applied, [small], 'the fitting prefix is sent');
      checkEqual(first.deferredCommits ?? 0, 1, 'the oversized commit defers');
      checkEqual(
        await a.api.pendingCommitIds(),
        [huge],
        'the oversized commit stays queued',
      );

      const failed = await a.api.sync();
      check(!failed.ok, 'an oversized head fails');
      if (!failed.ok) {
        checkEqual(
          failed.errorCode,
          'client.push_request_too_large',
          'typed capacity code',
        );
        checkEqual(failed.details?.kind, 'bytes', 'byte kind');
        checkEqual(failed.details?.clientCommitId, huge, 'blocked commit id');
        check(
          typeof failed.details?.size === 'number' &&
            failed.details.size > 10_000,
          'the full projected request size is reported',
        );
      }
      checkEqual(await a.api.pendingCommitIds(), [huge], 'intent stays queued');
      checkEqual(
        (await a.api.readRows('tasks')).length,
        2,
        'optimistic rows remain',
      );
    },
  },
  {
    name: 'offline/push-operation-cap-is-hard-at-the-head',
    specRefs: ['§6.1', '§7.1'],
    async run(ctx) {
      const a = await bootstrapped(ctx, 'actor-a', 'client-a', {
        maxPushOperationsPerRequest: 1,
      });
      const id = await a.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('a', 'p1') },
        { op: 'upsert', table: 'tasks', values: task('b', 'p1') },
      ]);
      const failed = await a.api.sync();
      check(!failed.ok, 'an oversized operation head fails');
      if (!failed.ok) {
        checkEqual(
          failed.errorCode,
          'client.push_request_too_large',
          'typed capacity code',
        );
        checkEqual(failed.details?.kind, 'operations', 'operation kind');
        checkEqual(failed.details?.size, 2, 'operation count');
        checkEqual(failed.details?.clientCommitId, id, 'blocked commit id');
      }
      checkEqual(await a.api.pendingCommitIds(), [id], 'intent stays queued');
      checkEqual(
        (await a.api.readRows('tasks')).length,
        2,
        'optimistic rows remain',
      );
    },
  },
  {
    name: 'offline/push-commit-count-cap-defers-whole-commits',
    specRefs: ['§7.1'],
    async run(ctx) {
      const a = await bootstrapped(ctx, 'actor-a', 'client-a', {
        maxPushCommitsPerRequest: 1,
      });
      const first = await a.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('one', 'p1') },
      ]);
      const second = await a.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('two', 'p1') },
      ]);
      const report = await syncOk(a);
      checkEqual(report.applied, [first], 'only the first commit is sent');
      checkEqual(report.deferredCommits ?? 0, 1, 'the later commit defers');
      checkEqual(
        await a.api.pendingCommitIds(),
        [second],
        'the later commit stays queued',
      );
    },
  },
  {
    name: 'offline/push-server-operation-cap-still-rejects',
    specRefs: ['§6.1', '§7.1'],
    async run(ctx) {
      const a = await bootstrapped(ctx, 'actor-a', 'client-a', {
        maxPushOperationsPerRequest: 600,
      });
      const first = await a.api.mutate(
        Array.from({ length: 501 }, (_, index) => ({
          op: 'upsert' as const,
          table: 'tasks',
          values: task(`filler-${index}`, 'p1'),
        })),
      );
      await syncFails(a, 'sync.too_many_operations', 'server operation cap');
      checkEqual(
        await a.api.pendingCommitIds(),
        [first],
        'the whole outbox survives the server rejection',
      );
      checkEqual(
        await ctx.server.getMaxCommitSeq(),
        0,
        'the server applied nothing',
      );
    },
  },
];
