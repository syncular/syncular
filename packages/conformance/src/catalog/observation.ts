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
import type { ClientInstance, DriverSchema } from '../driver';
import { doc, FIXTURE_SCHEMA, task } from '../fixture';
import type { Scenario } from '../scenario';
import { seedRows, seedTasks, syncFails, syncIdle, syncOk } from './util';

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

function requireSnapshotRead(client: ClientInstance) {
  check(client.snapshotRead !== undefined, 'snapshotRead is available');
  if (client.snapshotRead === undefined) {
    throw new Error('client lacks the snapshot-read surface');
  }
  return client.snapshotRead.bind(client);
}

const FTS_SCHEMA = {
  ...FIXTURE_SCHEMA,
  tables: FIXTURE_SCHEMA.tables.map((table) =>
    table.name === 'tasks'
      ? {
          ...table,
          ftsIndexes: [
            { name: 'tasks_fts', columns: ['title'], tokenize: 'unicode61' },
          ],
        }
      : table,
  ),
};

export const observationScenarios: readonly Scenario[] = [
  {
    // SYQL §15: typegen reads `_syncular_source_id` through the mapping table
    // on the projection rowid. Both cores keep every projection row's mapping
    // id equal to its rowid and its source_id equal to its source id.
    name: 'observation/fts-source-id-mapping',
    specRefs: ['§7.5'],
    async run(ctx) {
      await seedTasks(ctx, [
        task('s1', 'p1', 'needle one'),
        task('s2', 'p1', 'needle two needle'),
        task('s3', 'p1', 'haystack'),
      ]);
      const handle = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: { project_id: ['p1'] },
        schema: FTS_SCHEMA,
      });
      const observation = requireObservation(handle.api);
      await handle.api.subscribe({
        id: 'tasks',
        table: 'tasks',
        scopes: { project_id: ['p1'] },
      });
      await syncIdle(handle);
      const authored =
        "SELECT tasks_fts._syncular_source_id AS id, t.title FROM tasks_fts JOIN tasks t ON t.id = tasks_fts._syncular_source_id WHERE tasks_fts MATCH 'needle' ORDER BY bm25(tasks_fts), tasks_fts._syncular_source_id";
      const lowered =
        "SELECT __syql_fts_1.__syql_fts_source_1 AS id, t.title FROM tasks_fts JOIN (SELECT id AS __syql_fts_rowid_1, source_id AS __syql_fts_source_1 FROM _syncular_fts_tasks_fts) AS __syql_fts_1 ON __syql_fts_1.__syql_fts_rowid_1 = tasks_fts.rowid JOIN tasks t ON t.id = __syql_fts_1.__syql_fts_source_1 WHERE tasks_fts MATCH 'needle' ORDER BY bm25(tasks_fts), __syql_fts_1.__syql_fts_source_1";
      const agree = async (what: string, ids: readonly string[]) => {
        const expected = await observation.querySnapshot(authored);
        checkEqual(
          expected.rows.map((row) => row.id),
          ids,
          `${what}: projection hits`,
        );
        checkEqual(
          (await observation.querySnapshot(lowered)).rows,
          expected.rows,
          `${what}: the mapping join returns the projection's rows in order`,
        );
        const counts = await observation.querySnapshot(
          'SELECT (SELECT count(*) FROM tasks_fts) AS projection, (SELECT count(*) FROM _syncular_fts_tasks_fts) AS mapping, (SELECT count(*) FROM tasks_fts f JOIN _syncular_fts_tasks_fts m ON m.id = f.rowid AND m.source_id = f._syncular_source_id) AS matched',
        );
        const [row] = counts.rows;
        checkEqual(
          [row?.mapping, row?.matched],
          [row?.projection, row?.projection],
          `${what}: one mapping row per projection row, keyed by its rowid`,
        );
      };
      await agree('bootstrap', ['s2', 's1']);
      // Column 0 of the projection is `_syncular_source_id`; reading it makes
      // FTS5 fetch the hit's content row.
      const sourceIdReads = async (sql: string) => {
        const program = (await observation.querySnapshot(`EXPLAIN ${sql}`))
          .rows;
        const cursors = new Set(
          program.filter((op) => op.opcode === 'VOpen').map((op) => op.p1),
        );
        return program.filter(
          (op) => op.opcode === 'VColumn' && cursors.has(op.p1) && op.p2 === 0,
        ).length;
      };
      check(
        (await sourceIdReads(authored)) > 0,
        'the authored form reads the projection source id per hit',
      );
      checkEqual(
        await sourceIdReads(lowered),
        0,
        'the mapping join reads no projection column',
      );
      await handle.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('l1', 'p1', 'needle') },
        { op: 'upsert', table: 'tasks', values: task('s3', 'p1', 'needle') },
      ]);
      await handle.api.mutate([{ op: 'delete', table: 'tasks', rowId: 's1' }]);
      await agree('optimistic writes', ['l1', 's3', 's2']);
      await syncIdle(handle);
      await agree('acknowledged writes', ['l1', 's3', 's2']);
      await handle.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('s2', 'p1', 'hay') },
      ]);
      await agree('retitled row', ['l1', 's3']);
    },
  },
  {
    name: 'observation/storage-full-import-recovery',
    specRefs: ['§7.5', '§7.6'],
    async run(ctx) {
      const handle = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: { project_id: ['p1'] },
      });
      check(
        handle.api.executeStorageSql !== undefined,
        'owned storage SQL is available',
      );
      if (handle.api.executeStorageSql === undefined)
        throw new Error('missing owned storage SQL');
      await syncIdle(handle);
      await seedRows(ctx, 'tasks', [
        task('full-row', 'p1', 'full '.repeat(32768)),
      ]);
      await handle.api.subscribe({
        id: 'tasks',
        table: 'tasks',
        scopes: { project_id: ['p1'] },
      });
      await handle.api.executeStorageSql('PRAGMA max_page_count = 1');
      const failed = await handle.api.sync();
      check(!failed.ok, 'page-limited import fails');
      if (failed.ok) throw new Error('import unexpectedly succeeded');
      checkEqual(
        failed.errorCode,
        'client.storage_full',
        'local storage identity survives',
      );
      checkEqual(
        failed.details?.sqliteCode,
        13,
        'the first SQLite code survives',
      );
      check(
        !failed.message.includes('rollback') &&
          !failed.message.includes('savepoint'),
        'cleanup does not replace the first failure',
      );
      check(
        failed.details?.rollbackFailure !== undefined,
        'cleanup failure remains secondary',
      );
      const progress = await handle.api.progressSnapshot?.();
      checkEqual(
        progress?.errorCode,
        'client.storage_full',
        'failed progress names local storage',
      );
      await handle.api.executeStorageSql('PRAGMA max_page_count = 1073741823');
      await syncIdle(handle);
      checkEqual(
        (await handle.api.readRows('tasks')).map((row) => row.rowId),
        ['full-row'],
        'the next import succeeds',
      );
    },
  },
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
    // SYQL §13.2: a self-join whose instances carry identical scope proofs
    // claims one coverage entry for the shared base, and readiness follows
    // that single window.
    name: 'observation/self-join-coalesced-coverage',
    specRefs: ['§4.8', '§7.5'],
    async run(ctx) {
      await seedTasks(ctx, [
        task('a1', 'p1', 'a1', false, 1),
        task('a2', 'p1', 'a2', false, 1),
        task('a3', 'p1', 'a3', false, 2),
        task('b1', 'p2', 'b1', false, 1),
      ]);
      const handle = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: { project_id: ['p1', 'p2'] },
      });
      const observation = requireObservation(handle.api);
      const sql =
        'SELECT a.id AS task_id, b.id AS peer_id FROM tasks AS a ' +
        'JOIN tasks AS b ON b.priority = a.priority AND b.id <> a.id ' +
        'WHERE a.project_id = ?1 AND b.project_id = ?1 ORDER BY a.id, b.id';
      const coverage = [{ base: BASE, units: ['p1'] }];

      await handle.api.setWindow?.(BASE, ['p1']);
      const pending = await observation.querySnapshot(sql, ['p1'], coverage);
      check(
        !pending.coverage.complete,
        'self-join is pending before bootstrap',
      );
      checkEqual(pending.rows, [], 'pending self-join has no local rows');

      await syncIdle(handle);
      const ready = await observation.querySnapshot(sql, ['p1'], coverage);
      check(ready.coverage.complete, 'one window completes the self-join');
      checkEqual(
        ready.rows,
        [
          { task_id: 'a1', peer_id: 'a2' },
          { task_id: 'a2', peer_id: 'a1' },
        ],
        'self-join pairs stay inside the covered unit',
      );
    },
  },
  {
    name: 'observation/owned-query-failure-diagnostics',
    specRefs: ['§7.5', '§7.6'],
    async run(ctx) {
      const handle = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: { project_id: ['p1'] },
      });
      const observation = requireObservation(handle.api);
      check(
        handle.api.diagnosticsSnapshot !== undefined,
        'query diagnostics are available',
      );
      if (handle.api.diagnosticsSnapshot === undefined) return;

      let failed = false;
      try {
        await observation.querySnapshot(
          'SELECT private_value FROM missing_private_table',
          [],
          [],
          { id: 'queries:missing', tables: ['tasks', 'tasks'] },
        );
      } catch {
        failed = true;
      }
      check(failed, 'invalid owned query fails');
      const diagnostics = await handle.api.diagnosticsSnapshot();
      checkEqual(
        diagnostics.queryFailures,
        [
          {
            id: 'queries:missing',
            tables: ['tasks'],
            code: 'client.query_failed',
            ...(diagnostics.queryFailures[0]?.sqliteCode !== undefined
              ? { sqliteCode: diagnostics.queryFailures[0].sqliteCode }
              : {}),
            atMs: diagnostics.queryFailures[0]?.atMs,
          },
        ],
        'failed owned read records only bounded query identity evidence',
      );
      check(
        !JSON.stringify(diagnostics).includes('private_value') &&
          !JSON.stringify(diagnostics).includes('missing_private_table'),
        'query diagnostics omit SQL',
      );

      await observation.querySnapshot('SELECT id FROM tasks', [], [], {
        id: 'queries:missing',
        tables: ['tasks'],
      });
      checkEqual(
        (await handle.api.diagnosticsSnapshot()).queryFailures,
        [],
        'successful owned read clears its failure',
      );
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
  {
    // §7.5: one atomic read reports the persisted catch-up state of every
    // requested subscription from the same transaction and revision as the
    // rows. The owner cache is never consulted.
    name: 'observation/snapshot-read-catchup-states',
    specRefs: ['§4.6', '§4.7', '§7.5'],
    requires: ['concurrent-storage-faults'],
    async run(ctx) {
      await seedTasks(ctx, [task('t1', 'p1', 'one')]);
      const handle = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: { project_id: ['p1', 'p2'] },
      });
      const read = requireSnapshotRead(handle.api);
      const shapeOf = (
        catchup: Awaited<ReturnType<typeof read>>['subscriptions'][number],
      ) =>
        catchup.state === 'unknown'
          ? { state: 'unknown' }
          : {
              state: 'known',
              status: catchup.status,
              bootstrapComplete: catchup.bootstrapComplete,
              knownPendingPages: catchup.knownPendingPages,
              ...(catchup.reasonCode !== undefined
                ? { reasonCode: catchup.reasonCode }
                : {}),
            };

      // unknown: the client does not hold the id.
      const initial = await read({
        statements: [
          { sql: 'SELECT 1 AS n' },
          { sql: 'SELECT 9223372036854775807 AS n' },
        ],
        subscriptions: ['tasks', 'never-registered'],
      });
      checkEqual(
        initial.queries,
        [[{ n: 1 }], [{ n: Number(9223372036854775807n) }]],
        'the statement rows resolve in the same read',
      );
      checkEqual(
        initial.subscriptions,
        [
          { state: 'unknown', id: 'tasks' },
          { state: 'unknown', id: 'never-registered' },
        ],
        'an unheld id reads unknown with no fabricated table or cursor',
      );

      JSON.stringify(initial); // The conformance driver boundary is JSON-only.

      // pending: registered before its first bootstrap lands.
      await handle.api.subscribe({
        id: 'tasks',
        table: 'tasks',
        scopes: { project_id: ['p1'] },
      });
      const pending = await read({ statements: [], subscriptions: ['tasks'] });
      checkEqual(
        shapeOf(pending.subscriptions[0]!),
        {
          state: 'known',
          status: 'active',
          bootstrapComplete: false,
          knownPendingPages: true,
        },
        'a fresh registration is pending, never complete',
      );

      // complete: after bootstrap the cursor is set and no token remains.
      await syncIdle(handle);
      const complete = await read({
        statements: [
          { sql: 'SELECT id FROM tasks ORDER BY id' },
          { sql: 'SELECT count(*) AS n FROM tasks' },
        ],
        subscriptions: ['tasks'],
      });
      checkEqual(
        complete.queries,
        [[{ id: 't1' }], [{ n: 1 }]],
        'two statements resolve under one revision',
      );
      checkEqual(
        shapeOf(complete.subscriptions[0]!),
        {
          state: 'known',
          status: 'active',
          bootstrapComplete: true,
          knownPendingPages: false,
        },
        'bootstrap completes the subscription',
      );
      checkEqual(
        complete.revision,
        await handle.api.localRevision!(),
        'the read reports the durable revision',
      );

      // reset: a pruned cursor discards progress and stays pending.
      await seedTasks(ctx, [task('t2', 'p1', 'pruned')]);
      await ctx.server.pruneDuringNextCommitRead!();
      const resetReport = await syncOk(handle);
      check(
        resetReport.resets.includes('tasks'),
        'the round resets the subscription',
      );
      const reset = await read({ statements: [], subscriptions: ['tasks'] });
      checkEqual(
        shapeOf(reset.subscriptions[0]!),
        {
          state: 'known',
          status: 'active',
          bootstrapComplete: false,
          knownPendingPages: true,
          reasonCode: 'sync.cursor_expired',
        },
        'a reset stays active and pending while it re-bootstraps',
      );

      // revoked: an active subscription whose grant was withdrawn.
      await ctx.server.setAllowedScopes('actor-a', { project_id: ['p2'] });
      await syncOk(handle);
      const revoked = await read({ statements: [], subscriptions: ['tasks'] });
      checkEqual(
        shapeOf(revoked.subscriptions[0]!),
        {
          state: 'known',
          status: 'revoked',
          bootstrapComplete: false,
          knownPendingPages: false,
          reasonCode: 'sync.scope_revoked',
        },
        'a revoked subscription is known, never complete and never pending',
      );

      // failed: a subscription that fails closed on a fatal local mapping.
      const brokenSchema: DriverSchema = {
        version: FIXTURE_SCHEMA.version,
        tables: FIXTURE_SCHEMA.tables.map((table) =>
          table.name === 'docs'
            ? { ...table, scopes: [{ pattern: 'org:{org_id}' }] }
            : table,
        ),
      };
      const broken = await ctx.newClient({
        actorId: 'actor-b',
        clientId: 'client-b',
        schema: brokenSchema,
        allowed: { projectId: ['p1'], org_id: ['o1'] },
      });
      await seedRows(ctx, 'docs', [doc('d1', 'o1', 'p1')]);
      await broken.api.subscribe({
        id: 'docs',
        table: 'docs',
        scopes: { projectId: ['p1'] },
      });
      const brokenReport = await syncOk(broken);
      check(
        brokenReport.failed.includes('docs'),
        'the broken subscription fails closed',
      );
      const failed = await requireSnapshotRead(broken.api)({
        statements: [],
        subscriptions: ['docs'],
      });
      checkEqual(
        shapeOf(failed.subscriptions[0]!),
        {
          state: 'known',
          status: 'failed',
          bootstrapComplete: false,
          knownPendingPages: false,
          reasonCode: 'sync.scope_revoked',
        },
        'a failed subscription is never complete and never pending',
      );
    },
  },
  {
    // §7.5: delivery status by client commit id, with outbox precedence and
    // the full persisted outcome (never the owner-derived retained rows).
    name: 'observation/snapshot-read-delivery-status',
    specRefs: ['§6.3', '§7.1', '§7.5'],
    requires: ['validators'],
    async run(ctx) {
      await seedTasks(ctx, [task('occupied', 'p1', 'server')]);
      const handle = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: { project_id: ['p1'] },
        limits: { outcomeRetentionMaxEntries: 1 },
      });
      const read = requireSnapshotRead(handle.api);
      await handle.api.subscribe({
        id: 'tasks',
        table: 'tasks',
        scopes: { project_id: ['p1'] },
      });
      await syncIdle(handle);

      // pending (outbox precedence) and unknown (never held).
      const appliedId = await handle.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('a1', 'p1', 'a') },
      ]);
      const pending = await read({
        statements: [],
        commitIds: [appliedId, 'never-known'],
      });
      checkEqual(
        pending.deliveries,
        [
          { status: 'pending', clientCommitId: appliedId },
          { status: 'unknown', clientCommitId: 'never-known' },
        ],
        'an undrained id is pending and an unheld id is an explicit unknown',
      );

      await syncIdle(handle);
      const applied = await read({ statements: [], commitIds: [appliedId] });
      const appliedDelivery = applied.deliveries[0];
      checkEqual(appliedDelivery?.status, 'known', 'a drained commit is known');
      if (appliedDelivery?.status !== 'known')
        throw new Error('expected a known delivery');
      checkEqual(
        appliedDelivery.outcome.status,
        'applied',
        'the persisted outcome preserves the applied status',
      );
      checkEqual(
        appliedDelivery.outcome.results.length,
        1,
        'every result is preserved',
      );
      check(
        !('retainedRows' in appliedDelivery.outcome),
        'the snapshot view omits owner-derived retained rows',
      );

      // conflict: a stale base version retains its conflict evidence.
      const conflictId = await handle.api.mutate([
        {
          op: 'upsert',
          table: 'tasks',
          values: task('occupied', 'p1', 'loser'),
          baseVersion: 0,
        },
      ]);
      const conflictReport = await syncOk(handle);
      checkEqual(
        conflictReport.rejected,
        [conflictId],
        'the stale write is rejected as a durable conflict',
      );
      const conflict = await read({ statements: [], commitIds: [conflictId] });
      const conflictDelivery = conflict.deliveries[0];
      checkEqual(conflictDelivery?.status, 'known', 'the conflict is known');
      if (conflictDelivery?.status !== 'known')
        throw new Error('expected a known conflict');
      checkEqual(
        conflictDelivery.outcome.status,
        'conflict',
        'the outcome status is conflict',
      );
      const conflictResult = conflictDelivery.outcome.results[0];
      checkEqual(
        conflictResult?.status,
        'conflict',
        'the conflict result is preserved',
      );
      if (conflictResult?.status !== 'conflict')
        throw new Error('expected a conflict result');
      check(
        conflictResult.conflict.code.length > 0,
        'the conflict code is preserved',
      );
      check(
        conflictDelivery.outcome.operations !== undefined,
        'the failed-commit envelope is persisted with the conflict outcome',
      );

      // rejected: a server validator rejection carries its code and retryability.
      await ctx.server.installValidators!([
        {
          table: 'tasks',
          rule: {
            kind: 'maxLength',
            column: 'title',
            max: 3,
            code: 'validation.too_long',
          },
        },
      ]);
      const rejectedId = await handle.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('r1', 'p1', 'toolong') },
      ]);
      const rejectedReport = await syncOk(handle);
      check(
        rejectedReport.rejected.includes(rejectedId),
        'the validator rejects the commit',
      );
      const rejected = await read({
        statements: [],
        commitIds: [rejectedId],
      });
      const rejectedDelivery = rejected.deliveries[0];
      checkEqual(rejectedDelivery?.status, 'known', 'the rejection is known');
      if (rejectedDelivery?.status !== 'known')
        throw new Error('expected a known rejection');
      checkEqual(
        rejectedDelivery.outcome.status,
        'rejected',
        'the outcome status is rejected',
      );
      const rejectedResult = rejectedDelivery.outcome.results[0];
      if (rejectedResult?.status !== 'error')
        throw new Error('expected a rejection result');
      checkEqual(
        rejectedResult.rejection.code,
        'validation.too_long',
        'the persisted rejection code is preserved',
      );
      check(
        rejectedResult.rejection.retryable === false,
        'a validator rejection is not retryable',
      );

      // pruned: retention removed the older applied outcome.
      const pruned = await read({ statements: [], commitIds: [appliedId] });
      checkEqual(
        pruned.deliveries,
        [{ status: 'unknown', clientCommitId: appliedId }],
        'retention prunes the older applied outcome to unknown',
      );
    },
  },
  {
    // §7.5/§7.6: the canonical revision marker is a fallible read on every
    // public surface. Both cores classify the same corruption identically,
    // record the owned failure, and recover once the marker is valid again.
    name: 'observation/snapshot-read-corrupt-revision-classification',
    specRefs: ['§7.5', '§7.6'],
    requires: ['storage-fault'],
    async run(ctx) {
      const handle = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: { project_id: ['p1'] },
      });
      check(
        handle.api.executeStorageSql !== undefined,
        'harness storage SQL is available',
      );
      check(
        handle.api.localRevision !== undefined,
        'localRevision is available',
      );
      if (
        handle.api.executeStorageSql === undefined ||
        handle.api.localRevision === undefined
      ) {
        throw new Error('client lacks the corruption probe surface');
      }
      const read = requireSnapshotRead(handle.api);
      const localRevision = handle.api.localRevision.bind(handle.api);
      const diagnostics = handle.api.diagnosticsSnapshot?.bind(handle.api);
      await handle.api.subscribe({
        id: 'tasks',
        table: 'tasks',
        scopes: { project_id: ['p1'] },
      });
      await syncIdle(handle);
      const revision = await localRevision();
      const owner = { id: 'queries:revision', tables: ['tasks'] };

      for (const value of ["'+1'", "X'31'", "X'FF'"]) {
        await handle.api.executeStorageSql(
          `UPDATE _syncular_meta SET value=${value} WHERE key='localRevision'`,
        );
        let revisionCode = '';
        try {
          await localRevision();
        } catch (error) {
          revisionCode = (error as { code?: string }).code ?? '';
        }
        checkEqual(
          revisionCode,
          'sync.local_corrupt',
          'the public revision read classifies corruption',
        );
        let readCode = '';
        try {
          await read({ statements: [{ sql: 'SELECT 1 AS n' }], owner });
        } catch (error) {
          readCode = (error as { code?: string }).code ?? '';
        }
        checkEqual(
          readCode,
          'sync.local_corrupt',
          'the snapshot read classifies corruption',
        );
      }
      await handle.api.executeStorageSql(
        `UPDATE _syncular_meta SET value='${revision}' WHERE key='localRevision'`,
      );
      check(diagnostics !== undefined, 'query diagnostics are available');
      if (diagnostics !== undefined) {
        const failed = (await diagnostics()).queryFailures;
        checkEqual(failed[0]?.id, owner.id, 'the owned failure is recorded');
        checkEqual(
          failed[0]?.code,
          'sync.local_corrupt',
          'the owned failure keeps its typed code',
        );
      }
      const restored = await read({
        statements: [{ sql: 'SELECT 1 AS n' }],
        owner,
      });
      checkEqual(
        restored.queries,
        [[{ n: 1 }]],
        'the restored marker reads successfully',
      );
      checkEqual(
        await localRevision(),
        revision,
        'the public revision read recovers',
      );
      if (diagnostics !== undefined) {
        check(
          !(await diagnostics()).queryFailures.some(
            (failure) => failure.id === owner.id,
          ),
          'a successful owned read clears the failure',
        );
      }
    },
  },
  {
    name: 'observation/snapshot-read-corrupt-subscription-classification',
    specRefs: ['§7.5', '§7.6'],
    requires: ['storage-fault'],
    async run(ctx) {
      const handle = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: { project_id: ['p1'] },
      });
      check(
        handle.api.executeStorageSql !== undefined,
        'storage fault injection exists',
      );
      const read = requireSnapshotRead(handle.api);
      await handle.api.executeStorageSql('DROP TABLE _syncular_subscriptions');
      await handle.api.executeStorageSql(
        'CREATE TABLE _syncular_subscriptions(id,tbl,state_json,status,cursor,bootstrap_state,effective_scopes,reason_code)',
      );
      await handle.api.executeStorageSql(
        "INSERT INTO _syncular_subscriptions VALUES('s','tasks','{}','active',0,NULL,NULL,NULL)",
      );
      for (const assignment of [
        "tbl=X'7461736b73'",
        "state_json=X'7b7d',status=X'616374697665'",
        "state_json=CAST(X'FF' AS TEXT),status=CAST(X'FF' AS TEXT)",
      ]) {
        await handle.api.executeStorageSql(
          `UPDATE _syncular_subscriptions SET ${assignment}`,
        );
        let code: string | undefined;
        try {
          await read({ statements: [], subscriptions: ['s'] });
        } catch (error) {
          code = (error as { code?: string }).code;
        }
        checkEqual(
          code,
          'sync.local_corrupt',
          `invalid SQLite subscription type: ${assignment}`,
        );
        await handle.api.executeStorageSql(
          `UPDATE _syncular_subscriptions SET tbl='tasks',status='active',state_json='{"status":"active","cursor":0}'`,
        );
        checkEqual(
          (await read({ statements: [], subscriptions: ['s'] }))
            .subscriptions[0]?.state,
          'known',
          'valid SQL column types recover',
        );
      }
      for (const scopes of [
        'invalid',
        [],
        { project_id: 'p1' },
        { project_id: [7] },
      ]) {
        const raw = JSON.stringify(scopes).replaceAll("'", "''");
        const state = JSON.stringify({
          status: 'active',
          cursor: 0,
          effectiveScopes: scopes,
        }).replaceAll("'", "''");
        await handle.api.executeStorageSql(
          `UPDATE _syncular_subscriptions SET effective_scopes='${raw}',state_json='${state}'`,
        );
        let code: string | undefined;
        try {
          await read({ statements: [], subscriptions: ['s'] });
        } catch (error) {
          code = (error as { code?: string }).code;
        }
        checkEqual(
          code,
          'sync.local_corrupt',
          `invalid effective scopes: ${raw}`,
        );
      }
      await handle.api.executeStorageSql(
        `UPDATE _syncular_subscriptions SET effective_scopes=NULL,cursor=9007199254740992,state_json='{"status":"active","cursor":9007199254740992}'`,
      );
      let code: string | undefined;
      try {
        await read({ statements: [], subscriptions: ['s'] });
      } catch (error) {
        code = (error as { code?: string }).code;
      }
      checkEqual(
        code,
        'sync.local_corrupt',
        'unsafe cursor fails equally on both cores',
      );
      for (const scopes of [null, {}, { project_id: ['p1'] }]) {
        const raw = JSON.stringify(scopes).replaceAll("'", "''");
        const state = JSON.stringify({
          status: 'active',
          cursor: 0,
          effectiveScopes: scopes,
        }).replaceAll("'", "''");
        await handle.api.executeStorageSql(
          `UPDATE _syncular_subscriptions SET cursor=0,effective_scopes='${raw}',state_json='${state}'`,
        );
        const snapshot = await read({ statements: [], subscriptions: ['s'] });
        const subscription = snapshot.subscriptions[0];
        check(
          subscription?.state === 'known',
          'valid catch-up metadata recovers',
        );
        checkEqual(
          subscription.effectiveScopes,
          scopes ?? undefined,
          'scope map preserves valid values and omits null',
        );
      }
    },
  },
  {
    name: 'observation/snapshot-read-corrupt-outcome-classification',
    specRefs: ['§7.5', '§7.6'],
    requires: ['storage-fault'],
    async run(ctx) {
      const handle = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: { project_id: ['p1'] },
      });
      check(
        handle.api.executeStorageSql !== undefined,
        'storage fault injection is available',
      );
      const read = requireSnapshotRead(handle.api);
      // A damaged journal has no reliable affinity or constraints. Both column
      // spellings let the same fixture exercise each core's persisted reader.
      await handle.api.executeStorageSql(
        'DROP TABLE _syncular_commit_outcomes',
      );
      await handle.api.executeStorageSql(
        `CREATE TABLE _syncular_commit_outcomes(seq,client_commit_id,status,recorded_at_ms,results,results_json,operations,operations_json,resolution,resolved_at_ms,replacement_client_commit_id)`,
      );
      await handle.api.executeStorageSql(
        `INSERT INTO _syncular_commit_outcomes VALUES(1,'c','applied',1,'[]','[]',NULL,NULL,'active',NULL,NULL)`,
      );
      const conflict = {
        clientCommitId: 'c',
        opIndex: 0,
        table: 'tasks',
        rowId: 'r',
        code: 'sync.conflict',
        message: 'conflict',
        serverVersion: 1,
        serverRow: {},
      };
      const rejection = {
        clientCommitId: 'c',
        opIndex: 0,
        code: 'validation.denied',
        message: 'denied',
        retryable: false,
      };
      const invalidOperations = [
        {},
        { op: 'bogus', table: 'tasks', rowId: 'r' },
        { op: 'upsert', table: 'tasks', rowId: 'r' },
        { op: 'delete', table: 'tasks', rowId: 'r', values: {} },
        { op: 'delete', table: 'tasks', rowId: 'r', values: null },
        {
          op: 'upsert',
          table: 'tasks',
          rowId: 'r',
          values: { b: { $bytes: '+a' } },
        },
      ];
      const invalidResults = [
        ...invalidOperations.flatMap((operation) => [
          [{ status: 'error', rejection: { ...rejection, operation } }],
          [{ status: 'conflict', conflict: { ...conflict, operation } }],
        ]),
        ...[0.5, 2147483648, -2147483649].map((opIndex) => [
          { status: 'applied', opIndex },
        ]),
        ...[0.5, 9007199254740992].map((serverVersion) => [
          { status: 'conflict', conflict: { ...conflict, serverVersion } },
        ]),
        ...['title', [7], null].map((conflictColumns) => [
          { status: 'conflict', conflict: { ...conflict, conflictColumns } },
        ]),
        ...[
          [],
          {},
          { secret: 'hidden' },
          { reason: 'Not Valid' },
          { fieldPaths: [] },
          { references: { safe: 'x'.repeat(257) } },
        ].map((details) => [
          { status: 'error', rejection: { ...rejection, details } },
        ]),
        [{ status: 'error', rejection: { ...rejection, opIndex: 0.5 } }],
      ];
      const owner = { id: 'queries:outcome', tables: ['tasks'] };
      for (const result of invalidResults) {
        const json = JSON.stringify(result).replaceAll("'", "''");
        await handle.api.executeStorageSql(
          `UPDATE _syncular_commit_outcomes SET status='${result.some((entry) => entry.status === 'conflict') ? 'conflict' : result.some((entry) => entry.status === 'error') ? 'rejected' : 'applied'}',results='${json}',results_json='${json}'`,
        );
        let code: string | undefined;
        try {
          await read({ statements: [], commitIds: ['c'], owner });
        } catch (error) {
          code = (error as { code?: string }).code;
        }
        checkEqual(
          code,
          'sync.local_corrupt',
          `malformed result fails closed: ${json}`,
        );
      }
      await handle.api.executeStorageSql(
        "UPDATE _syncular_commit_outcomes SET status='applied',results='[]',results_json='[]'",
      );
      for (const operation of invalidOperations) {
        const json = JSON.stringify([operation]).replaceAll("'", "''");
        await handle.api.executeStorageSql(
          `UPDATE _syncular_commit_outcomes SET operations='${json}',operations_json='${json}'`,
        );
        let code: string | undefined;
        try {
          await read({ statements: [], commitIds: ['c'], owner });
        } catch (error) {
          code = (error as { code?: string }).code;
        }
        checkEqual(
          code,
          'sync.local_corrupt',
          `invalid retained operation: ${json}`,
        );
      }
      await handle.api.executeStorageSql(
        'UPDATE _syncular_commit_outcomes SET operations=NULL,operations_json=NULL',
      );
      for (const [status, results] of [
        ['applied', [{ status: 'error', rejection }]],
        ['cached', [{ status: 'conflict', conflict }]],
        ['conflict', [{ status: 'error', rejection }]],
        ['rejected', [{ status: 'conflict', conflict }]],
      ]) {
        const json = JSON.stringify(results).replaceAll("'", "''");
        await handle.api.executeStorageSql(
          `UPDATE _syncular_commit_outcomes SET status='${status}',results='${json}',results_json='${json}'`,
        );
        let code: string | undefined;
        try {
          await read({ statements: [], commitIds: ['c'], owner });
        } catch (error) {
          code = (error as { code?: string }).code;
        }
        checkEqual(
          code,
          'sync.local_corrupt',
          `contradictory outcome status: ${status}`,
        );
      }
      for (const status of ['rejected', 'conflict']) {
        await handle.api.executeStorageSql(
          `UPDATE _syncular_commit_outcomes SET status='${status}',results='[]',results_json='[]'`,
        );
        const redacted = await read({
          statements: [],
          commitIds: ['c'],
          owner,
        });
        checkEqual(
          redacted.deliveries[0]?.status,
          'known',
          'purged outcome remains readable',
        );
      }
      await handle.api.executeStorageSql(
        "UPDATE _syncular_commit_outcomes SET status='applied',results='[]',results_json='[]'",
      );
      for (const [column, invalid, restored] of [
        ['seq', "'bad'", '1'],
        ['seq', '9007199254740992', '1'],
        ['recorded_at_ms', "'bad'", '1'],
        ['recorded_at_ms', '0.5', '1'],
        ['resolved_at_ms', "'bad'", 'NULL'],
        ['replacement_client_commit_id', '7', 'NULL'],
      ]) {
        await handle.api.executeStorageSql(
          `UPDATE _syncular_commit_outcomes SET ${column}=${invalid}`,
        );
        let code: string | undefined;
        try {
          await read({ statements: [], commitIds: ['c'], owner });
        } catch (error) {
          code = (error as { code?: string }).code;
        }
        checkEqual(
          code,
          'sync.local_corrupt',
          `malformed SQL metadata fails closed: ${column}`,
        );
        await handle.api.executeStorageSql(
          `UPDATE _syncular_commit_outcomes SET ${column}=${restored}`,
        );
      }
      for (const result of [
        { status: 'conflict', conflict },
        {
          status: 'error',
          rejection: { ...rejection, details: { reason: 'policy_denied' } },
        },
        { status: 'error', rejection: { ...rejection, details: null } },
      ]) {
        const json = JSON.stringify([result]).replaceAll("'", "''");
        await handle.api.executeStorageSql(
          `UPDATE _syncular_commit_outcomes SET status='${result.status === 'conflict' ? 'conflict' : 'rejected'}',results='${json}',results_json='${json}'`,
        );
        const snapshot = await read({
          statements: [],
          commitIds: ['c'],
          owner,
        });
        const delivery = snapshot.deliveries[0];
        check(
          delivery?.status === 'known',
          'valid persisted metadata recovers',
        );
        const stored = delivery.outcome.results[0];
        if (stored?.status === 'conflict')
          checkEqual(
            stored.conflict.conflictColumns,
            [],
            'legacy conflict columns default to an empty array',
          );
        if (stored?.status === 'error')
          checkEqual(
            stored.rejection.details,
            result.rejection?.details ?? undefined,
            'optional validated details survive',
          );
      }
      check(
        handle.api.diagnosticsSnapshot !== undefined,
        'query diagnostics are available',
      );
      check(
        !(await handle.api.diagnosticsSnapshot()).queryFailures.some(
          (failure) => failure.id === owner.id,
        ),
        'a successful read clears the owned corruption failure',
      );
    },
  },
];
