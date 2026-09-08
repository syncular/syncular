/** Cross-core revisioned-observation vectors. These assert the local reactive
 * contract itself (revision, atomic snapshot, exact domains, and sync intent),
 * not just eventual server convergence. The same scenarios run on the TS and
 * Rust client cores through their real command surfaces. */
import { check, checkEqual } from '../checks';
import {
  decodeMessage,
  encodeMessage,
  encodeRowsSegment,
  decodeRowsSegment,
  type ResponseFrame,
} from '@syncular/core';
import type { ClientInstance } from '../driver';
import { FIXTURE_SCHEMA, task } from '../fixture';
import type { Scenario } from '../scenario';
import { seedTasks, syncFails, syncIdle, syncOk } from './util';

const BASE = { table: 'tasks', variable: 'project_id' } as const;

function requireObservation(client: ClientInstance) {
  check(client.localRevision !== undefined, 'localRevision is available');
  check(client.querySnapshot !== undefined, 'querySnapshot is available');
  check(
    client.drainChangeBatches !== undefined,
    'exact change batches are available',
  );
  check(client.drainSyncIntents !== undefined, 'sync intents are available');
  if (
    client.localRevision === undefined ||
    client.querySnapshot === undefined ||
    client.drainChangeBatches === undefined ||
    client.drainSyncIntents === undefined
  ) {
    throw new Error('client lacks the revisioned observation surface');
  }
  return {
    localRevision: client.localRevision.bind(client),
    querySnapshot: client.querySnapshot.bind(client),
    drainChangeBatches: client.drainChangeBatches.bind(client),
    drainSyncIntents: client.drainSyncIntents.bind(client),
  };
}

export const observationScenarios: readonly Scenario[] = [
  {
    name: 'observation/bootstrap-blocks-commit-independent-revisions',
    specRefs: ['§1.4', '§5.2', '§7.5'],
    async run(ctx) {
      await seedTasks(ctx, [task('first', 'p1'), task('second', 'p1')]);
      const handle = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: { project_id: ['p1'] },
        limits: { accept: 1 },
      });
      await syncIdle(handle);
      await handle.api.subscribe({
        id: 'tasks',
        table: 'tasks',
        scopes: { project_id: ['p1'] },
      });
      const observation = requireObservation(handle.api);
      await observation.drainChangeBatches();
      const original = ctx.server.handleSyncRequest.bind(ctx.server);
      let split = false;
      ctx.server.handleSyncRequest = async (actorId, request) => {
        const response = await original(actorId, request);
        if (!response.ok || actorId !== handle.actorId) return response;
        const message = decodeMessage(response.bytes);
        if (message.msgKind !== 'response')
          throw new Error('Server returned a request');
        return {
          ...response,
          bytes: encodeMessage({
            ...message,
            frames: message.frames.map((frame) => {
              if (frame.type !== 'SEGMENT_INLINE') return frame;
              const segment = decodeRowsSegment(frame.payload);
              const rows = segment.blocks.flat();
              checkEqual(
                rows.length,
                2,
                'bootstrap segment contains both rows',
              );
              split = true;
              return {
                ...frame,
                payload: encodeRowsSegment({
                  ...segment,
                  blocks: rows.map((row) => [row]),
                }),
              };
            }),
          }),
        };
      };
      try {
        await syncIdle(handle);
      } finally {
        ctx.server.handleSyncRequest = original;
      }
      check(split, 'transport delivered two blocks within one inline segment');
      const batches = (await observation.drainChangeBatches()).filter((batch) =>
        batch.tables.some((table) => table.table === 'tasks'),
      );
      checkEqual(
        batches.length,
        2,
        'each rows block publishes its own transaction revision',
      );
      checkEqual(
        (
          BigInt(batches[1]?.revision ?? '0') -
          BigInt(batches[0]?.revision ?? '0')
        ).toString(),
        '1',
        'block revisions advance separately',
      );
      checkEqual(
        (await observation.querySnapshot('SELECT id FROM tasks ORDER BY id'))
          .rows,
        [{ id: 'first' }, { id: 'second' }],
        'both blocks are visible',
      );
    },
  },
  {
    name: 'observation/realtime-frames-commit-independent-revisions',
    specRefs: ['§1.4', '§7.5', '§8.2'],
    async run(ctx) {
      const handle = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: { project_id: ['p1'] },
      });
      await handle.api.subscribe({
        id: 'tasks',
        table: 'tasks',
        scopes: { project_id: ['p1'] },
      });
      await syncIdle(handle);
      const original = ctx.server.connectRealtime.bind(ctx.server);
      let first: ReturnType<typeof decodeMessage> | undefined;
      let merged = false;
      ctx.server.connectRealtime = async (actorId, clientId, sink) =>
        original(actorId, clientId, {
          ...sink,
          onBinary(bytes) {
            if (bytes[0] !== 0 || merged) {
              sink.onBinary(bytes);
              return;
            }
            const message = decodeMessage(bytes.subarray(1));
            if (message.msgKind !== 'response')
              throw new Error('Delta must be a response');
            if (!first) {
              first = message;
              return;
            }
            if (first.msgKind !== 'response')
              throw new Error('First delta must be a response');
            const earlier = first.frames.filter(
              (frame) => frame.type === 'COMMIT',
            );
            checkEqual(earlier.length, 1, 'first delta contains one commit');
            checkEqual(
              message.frames.filter((frame) => frame.type === 'COMMIT').length,
              1,
              'second delta contains one commit',
            );
            merged = true;
            const payload = encodeMessage({
              ...message,
              frames: message.frames.flatMap<ResponseFrame>((frame) =>
                frame.type === 'COMMIT' ? [...earlier, frame] : [frame],
              ),
            });
            const tagged = new Uint8Array(payload.length + 1);
            tagged.set(payload, 1);
            sink.onBinary(tagged);
          },
        });
      try {
        await handle.api.connectRealtime();
        await syncIdle(handle);
        const observation = requireObservation(handle.api);
        await observation.drainChangeBatches();
        await seedTasks(ctx, [task('remote-1', 'p1', 'first')]);
        await seedTasks(ctx, [task('remote-2', 'p1', 'second')]);
        await handle.realtime.waitForAck(2);
        check(merged, 'transport delivered both COMMIT frames in one delta');
        const batches = (await observation.drainChangeBatches()).filter(
          (batch) => batch.tables.some((table) => table.table === 'tasks'),
        );
        checkEqual(
          batches.length,
          2,
          'each realtime COMMIT publishes its own revision',
        );
        checkEqual(
          (
            BigInt(batches[1]?.revision ?? '0') -
            BigInt(batches[0]?.revision ?? '0')
          ).toString(),
          '1',
          'realtime revisions advance separately',
        );
        checkEqual(
          (
            await observation.querySnapshot(
              'SELECT id, title FROM tasks ORDER BY id',
            )
          ).rows,
          [
            { id: 'remote-1', title: 'first' },
            { id: 'remote-2', title: 'second' },
          ],
          'both realtime frames are visible before acknowledgement',
        );
        checkEqual(
          (await handle.api.subscriptionState('tasks'))?.cursor,
          2,
          'delta trailer persists the final cursor',
        );
      } finally {
        ctx.server.connectRealtime = original;
      }
    },
  },
  {
    name: 'observation/failed-later-frame-preserves-durable-prefix',
    specRefs: ['§1.4', '§4.5', '§7.5'],
    async run(ctx) {
      const handle = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: { project_id: ['p1'] },
      });
      await handle.api.subscribe({
        id: 'tasks',
        table: 'tasks',
        scopes: { project_id: ['p1'] },
      });
      await syncIdle(handle);
      let observation = requireObservation(handle.api);
      await observation.drainChangeBatches();
      const before = await handle.api.subscriptionState('tasks');
      await seedTasks(ctx, [task('remote-1', 'p1', 'first')]);
      await seedTasks(ctx, [task('remote-2', 'p1', 'second')]);
      const original = ctx.server.handleSyncRequest.bind(ctx.server);
      ctx.server.handleSyncRequest = async (actorId, request) => {
        const response = await original(actorId, request);
        if (!response.ok || actorId !== handle.actorId) return response;
        const message = decodeMessage(response.bytes);
        if (message.msgKind !== 'response')
          throw new Error('Server returned a request');
        let commits = 0;
        return {
          ...response,
          bytes: encodeMessage({
            ...message,
            frames: message.frames.map((frame) => {
              if (frame.type !== 'COMMIT' || ++commits !== 2) return frame;
              const change = frame.changes[0];
              if (!change)
                throw new Error('Second frame has no change to corrupt');
              return {
                ...frame,
                changes: [
                  ...frame.changes,
                  { ...change, rowId: 'malformed', row: new Uint8Array() },
                ],
              };
            }),
          }),
        };
      };
      try {
        await syncFails(
          handle,
          'sync.invalid_request',
          'second frame cannot decode its later row',
        );
      } finally {
        ctx.server.handleSyncRequest = original;
      }
      const batches = (await observation.drainChangeBatches()).filter((batch) =>
        batch.tables.some((table) => table.table === 'tasks'),
      );
      checkEqual(
        batches.length,
        1,
        'only the first frame publishes a revision',
      );
      const prefix = await observation.querySnapshot(
        'SELECT id, title FROM tasks ORDER BY id',
      );
      checkEqual(
        prefix.rows,
        [{ id: 'remote-1', title: 'first' }],
        'later frame rolls back all its rows',
      );
      checkEqual(
        (await handle.api.subscriptionState('tasks'))?.cursor,
        before?.cursor,
        'missing successful trailer preserves the old cursor',
      );
      await ctx.recreateClient(handle, FIXTURE_SCHEMA);
      observation = requireObservation(handle.api);
      checkEqual(
        (
          await observation.querySnapshot(
            'SELECT id, title FROM tasks ORDER BY id',
          )
        ).rows,
        prefix.rows,
        'committed prefix survives recreation',
      );
      checkEqual(
        (await handle.api.subscriptionState('tasks'))?.cursor,
        before?.cursor,
        'old cursor survives recreation',
      );
      await syncIdle(handle);
      checkEqual(
        (
          await observation.querySnapshot(
            'SELECT id, title FROM tasks ORDER BY id',
          )
        ).rows,
        [
          { id: 'remote-1', title: 'first' },
          { id: 'remote-2', title: 'second' },
        ],
        'repull repairs the unadvanced window',
      );
      checkEqual(
        (await handle.api.subscriptionState('tasks'))?.cursor,
        2,
        'successful trailer advances the cursor',
      );
    },
  },
  {
    name: 'observation/remote-frames-commit-independent-revisions',
    specRefs: ['§1.4', '§4.5', '§7.5'],
    async run(ctx) {
      const handle = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: { project_id: ['p1'] },
      });
      let observation = requireObservation(handle.api);
      await handle.api.setWindow?.(BASE, ['p1']);
      await syncIdle(handle);
      await observation.drainChangeBatches();
      await seedTasks(ctx, [task('remote-1', 'p1', 'first')]);
      await seedTasks(ctx, [task('remote-2', 'p1', 'second')]);
      const report = await syncOk(handle);
      checkEqual(
        report.commitsApplied,
        2,
        'two independent remote frames arrive in one round',
      );
      const batches = (await observation.drainChangeBatches()).filter((batch) =>
        batch.tables.some(
          (table) =>
            table.table === 'tasks' && table.scopeKeys?.includes('project:p1'),
        ),
      );
      checkEqual(
        batches.length,
        2,
        'each COMMIT frame publishes its own row revision',
      );
      checkEqual(
        (
          BigInt(batches[1]?.revision ?? '0') -
          BigInt(batches[0]?.revision ?? '0')
        ).toString(),
        '1',
        'adjacent frame revisions advance independently',
      );
      const snapshot = await observation.querySnapshot(
        'SELECT id, title FROM tasks ORDER BY id',
      );
      checkEqual(
        snapshot.rows,
        [
          { id: 'remote-1', title: 'first' },
          { id: 'remote-2', title: 'second' },
        ],
        'both frames are visible',
      );
      await ctx.recreateClient(handle, FIXTURE_SCHEMA);
      observation = requireObservation(handle.api);
      const reopened = await observation.querySnapshot(
        'SELECT id, title FROM tasks ORDER BY id',
      );
      checkEqual(reopened.rows, snapshot.rows, 'frame rows survive recreation');
      checkEqual(
        reopened.revision,
        snapshot.revision,
        'frame revisions survive recreation',
      );
    },
  },
  {
    name: 'observation/mixed-ack-retry-and-durable-conflict',
    specRefs: ['§2.3', '§7.2.1', '§7.5'],
    async run(ctx) {
      await seedTasks(ctx, [task('occupied', 'p1', 'server')]);
      const handle = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: { project_id: ['p1'] },
      });
      await handle.api.subscribe({
        id: 'tasks',
        table: 'tasks',
        scopes: { project_id: ['p1'] },
      });
      await syncIdle(handle);
      let observation = requireObservation(handle.api);
      const first = await handle.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('first', 'p1') },
      ]);
      const firstSibling = await handle.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('first-sibling', 'p1') },
      ]);
      const rejected = await handle.api.mutate([
        {
          op: 'upsert',
          table: 'tasks',
          values: task('occupied', 'p1', 'loser'),
          baseVersion: 0,
        },
      ]);
      const later = await handle.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('later', 'p1') },
      ]);
      const laterSibling = await handle.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('later-sibling', 'p1') },
      ]);
      await observation.drainChangeBatches();
      handle.faults.dropNextResponses = 1;
      await syncFails(handle, 'transport.lost', 'lose mixed acknowledgements');
      checkEqual(
        await handle.api.pendingCommitIds(),
        [first, firstSibling, rejected, later, laterSibling],
        'lost response retains FIFO IDs',
      );
      checkEqual(
        await handle.api.conflicts(),
        [],
        'unreceived conflict has no local publication',
      );
      check(
        !(await observation.drainChangeBatches()).some(
          (batch) => batch.outcomesChanged,
        ),
        'lost response publishes no outcomes',
      );
      await ctx.recreateClient(handle, FIXTURE_SCHEMA);
      observation = requireObservation(handle.api);
      await observation.drainChangeBatches();
      checkEqual(
        await handle.api.pendingCommitIds(),
        [first, firstSibling, rejected, later, laterSibling],
        'restart preserves original retries',
      );
      const report = await syncOk(handle);
      checkEqual(
        report.applied,
        [first, firstSibling, later, laterSibling],
        'cached independent commits drain in order',
      );
      checkEqual(
        report.rejected,
        [rejected],
        'conflict retains its original identity',
      );
      const outcomes = (await observation.drainChangeBatches()).filter(
        (batch) => batch.outcomesChanged,
      );
      checkEqual(
        outcomes.map((batch) => batch.status?.outbox),
        [3, 2, 0],
        'successful runs and rejection each publish one atomic status',
      );
      checkEqual(
        (
          BigInt(outcomes[1]?.revision ?? '0') -
          BigInt(outcomes[0]?.revision ?? '0')
        ).toString(),
        '1',
        'rejection advances once after the first run',
      );
      checkEqual(
        (
          BigInt(outcomes[2]?.revision ?? '0') -
          BigInt(outcomes[1]?.revision ?? '0')
        ).toString(),
        '1',
        'last run advances once after rejection',
      );
      checkEqual(
        outcomes.at(-1)?.status?.outbox,
        0,
        'final outcome batch carries the drained status',
      );
      check(
        outcomes.some((batch) => batch.conflictsChanged),
        'conflict shares an outcome transaction',
      );
      const conflicts = await handle.api.conflicts();
      checkEqual(conflicts.length, 1, 'one conflict is published');
      checkEqual(
        conflicts[0]?.clientCommitId,
        rejected,
        'conflict identifies the rejected commit',
      );
      await ctx.recreateClient(handle, FIXTURE_SCHEMA);
      checkEqual(
        await handle.api.pendingCommitIds(),
        [],
        'drain survives restart',
      );
      checkEqual(
        await handle.api.conflicts(),
        conflicts,
        'conflict collection matches durable journal after restart',
      );
      observation = requireObservation(handle.api);
      await observation.drainChangeBatches();
      await syncIdle(handle);
      check(
        !(await observation.drainChangeBatches()).some(
          (batch) => batch.outcomesChanged,
        ),
        'subsequent sync publishes no duplicate outcomes',
      );
    },
  },
  {
    name: 'observation/optimistic-scope-move-and-atomic-snapshot',
    specRefs: ['§7.5'],
    async run(ctx) {
      const handle = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: { project_id: ['p1', 'p2'] },
      });
      const observation = requireObservation(handle.api);
      await observation.drainChangeBatches();
      await observation.drainSyncIntents();

      await handle.api.mutate([
        {
          op: 'upsert',
          table: 'tasks',
          values: task('t1', 'p1', 'first'),
        },
      ]);
      checkEqual(await observation.localRevision(), '1', 'first revision');
      checkEqual(
        await observation.drainSyncIntents(),
        [{ kind: 'interactive' }],
        'local write produces one interactive intent',
      );
      const first = await observation.drainChangeBatches();
      checkEqual(first.length, 1, 'one transaction emits one batch');
      checkEqual(first[0]?.revision, '1', 'batch revision matches metadata');
      checkEqual(
        first[0]?.tables,
        [{ table: 'tasks', scopeKeys: ['project:p1'] }],
        'upsert carries its exact scope key',
      );
      checkEqual(first[0]?.status?.outbox, 1, 'status is in the same batch');

      const snapshot = await observation.querySnapshot(
        'SELECT id, project_id, title FROM tasks WHERE id = ?',
        ['t1'],
      );
      checkEqual(snapshot.revision, '1', 'snapshot revision is atomic');
      checkEqual(snapshot.rows.length, 1, 'snapshot sees optimistic row');
      checkEqual(snapshot.rows[0]?.title, 'first', 'snapshot row is current');

      await handle.api.mutate([
        {
          op: 'upsert',
          table: 'tasks',
          values: task('t1', 'p2', 'moved'),
        },
      ]);
      const moved = (await observation.drainChangeBatches())[0];
      checkEqual(moved?.revision, '2', 'scope move advances once');
      checkEqual(
        moved?.tables[0]?.scopeKeys,
        ['project:p1', 'project:p2'],
        'scope move routes both before and after keys',
      );

      await handle.api.mutate([{ op: 'delete', table: 'tasks', rowId: 't1' }]);
      const deleted = (await observation.drainChangeBatches())[0];
      checkEqual(deleted?.revision, '3', 'delete advances once');
      checkEqual(
        deleted?.tables,
        [{ table: 'tasks', scopeKeys: ['project:p2'] }],
        'delete routes the last visible scope',
      );
      const absent = await observation.querySnapshot(
        'SELECT id FROM tasks WHERE id = ?',
        ['t1'],
      );
      checkEqual(absent.revision, '3', 'delete snapshot is same revision');
      checkEqual(absent.rows, [], 'optimistic delete is visible atomically');
    },
  },
  {
    name: 'observation/zero-row-window-completion',
    specRefs: ['§4.8', '§7.5'],
    async run(ctx) {
      const handle = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: { project_id: ['empty'] },
      });
      const observation = requireObservation(handle.api);
      await observation.drainChangeBatches();
      await observation.drainSyncIntents();

      await handle.api.setWindow?.(BASE, ['empty']);
      checkEqual(
        await observation.drainSyncIntents(),
        [{ kind: 'interactive' }],
        'window widening requests immediate sync',
      );
      const registered = await observation.drainChangeBatches();
      checkEqual(registered.length, 1, 'registration is one local batch');
      checkEqual(registered[0]?.tables, [], 'registration changes no rows');
      check(
        registered[0]?.windows[0]?.units.includes('empty') ?? false,
        'registration names the exact unit',
      );
      const pending = await observation.querySnapshot(
        'SELECT id FROM tasks WHERE project_id = ?',
        ['empty'],
        [{ base: BASE, units: ['empty'] }],
      );
      check(!pending.coverage.complete, 'pre-bootstrap emptiness is pending');
      checkEqual(pending.rows, [], 'pending unit honestly has zero local rows');

      await syncIdle(handle);
      const completion = await observation.drainChangeBatches();
      check(
        completion.some(
          (batch) =>
            batch.tables.length === 0 &&
            batch.windows.some((window) => window.units.includes('empty')),
        ),
        'zero-row completion emits an exact window-only batch',
      );
      const ready = await observation.querySnapshot(
        'SELECT id FROM tasks WHERE project_id = ?',
        ['empty'],
        [{ base: BASE, units: ['empty'] }],
      );
      check(ready.coverage.complete, 'zero-row bootstrap becomes complete');
      checkEqual(ready.rows, [], 'complete empty remains zero rows');
    },
  },
  {
    name: 'observation/persistent-open-catch-up-intent',
    specRefs: ['§7.5', '§8.4'],
    async run(ctx) {
      const handle = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: { project_id: ['p1'] },
      });
      let observation = requireObservation(handle.api);
      await handle.api.setWindow?.(BASE, ['p1']);
      await syncIdle(handle);
      await observation.drainChangeBatches();
      await observation.drainSyncIntents();

      await ctx.recreateClient(handle, FIXTURE_SCHEMA);
      observation = requireObservation(handle.api);
      check(
        await handle.api.syncNeeded(),
        'persistent open marks catch-up work as needed',
      );
      checkEqual(
        await observation.drainSyncIntents(),
        [{ kind: 'interactive' }],
        'persistent open emits exactly one interactive catch-up intent',
      );

      await syncIdle(handle);
      check(
        !(await handle.api.syncNeeded()),
        'catch-up round clears the startup work signal',
      );
    },
  },
  {
    name: 'observation/remote-commit-exact-change',
    specRefs: ['§4.5', '§7.5'],
    async run(ctx) {
      const handle = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: { project_id: ['p1'] },
      });
      const observation = requireObservation(handle.api);
      await handle.api.setWindow?.(BASE, ['p1']);
      await syncIdle(handle);
      await observation.drainChangeBatches();
      await observation.drainSyncIntents();
      const before = BigInt(await observation.localRevision());

      await seedTasks(ctx, [task('remote', 'p1', 'from-server')]);
      await syncIdle(handle);
      const batches = await observation.drainChangeBatches();
      const rowBatch = batches.find((batch) =>
        batch.tables.some(
          (table) =>
            table.table === 'tasks' && table.scopeKeys?.includes('project:p1'),
        ),
      );
      check(
        rowBatch !== undefined,
        'remote apply emits exact tasks/project:p1',
      );
      check(
        BigInt(rowBatch?.revision ?? '0') > before,
        'remote apply advances the persisted local revision',
      );
      const snapshot = await observation.querySnapshot(
        'SELECT id, title FROM tasks WHERE id = ?',
        ['remote'],
      );
      checkEqual(
        snapshot.rows[0]?.title,
        'from-server',
        'remote row is visible',
      );
      check(
        BigInt(snapshot.revision) >= BigInt(rowBatch?.revision ?? '0'),
        'snapshot is not older than its change batch',
      );
    },
  },
  {
    name: 'observation/window-shrink-and-rollback',
    specRefs: ['§4.8', '§7.5'],
    async run(ctx) {
      const handle = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: { project_id: ['p1', 'p2'] },
      });
      const observation = requireObservation(handle.api);
      await seedTasks(ctx, [task('one', 'p1'), task('two', 'p2')]);
      await handle.api.setWindow?.(BASE, ['p1', 'p2']);
      await syncIdle(handle);
      await observation.drainChangeBatches();
      await observation.drainSyncIntents();

      await handle.api.setWindow?.(BASE, ['p2']);
      const shrink = await observation.drainChangeBatches();
      checkEqual(shrink.length, 1, 'shrink is one observer transaction');
      checkEqual(
        shrink[0]?.tables,
        [{ table: 'tasks', scopeKeys: ['project:p1'] }],
        'shrink reports only the evicted unit rows',
      );
      check(
        shrink[0]?.windows.some((window) => window.units.includes('p1')) ??
          false,
        'shrink reports the departed coverage unit',
      );
      checkEqual(
        await observation.drainSyncIntents(),
        [{ kind: 'interactive' }],
        'shrink immediately re-registers the realtime subscription set',
      );

      const revision = await observation.localRevision();
      let rejected = false;
      try {
        await handle.api.mutate([
          {
            op: 'upsert',
            table: 'tasks',
            values: { id: 'invalid-missing-required-fields' },
          },
        ]);
      } catch {
        rejected = true;
      }
      check(rejected, 'invalid transaction is rejected');
      checkEqual(
        await observation.localRevision(),
        revision,
        'rollback does not advance revision',
      );
      checkEqual(
        await observation.drainChangeBatches(),
        [],
        'rollback emits no observer batch',
      );
      checkEqual(
        await observation.drainSyncIntents(),
        [],
        'rollback emits no sync intent',
      );
    },
  },
];
