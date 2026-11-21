import { Database } from 'bun:sqlite';
import { canonicalScopeJson, decodeMessage, unitId } from '@syncular/core';
import { check, checkEqual } from '../checks';
import type {
  ClientInstance,
  DriverColumn,
  DriverSchema,
  DriverTable,
} from '../driver';
import { rawPull, responseSection } from '../raw';
import type { Scenario } from '../scenario';
import { captureResponses, seedRows, syncIdle } from './util';

const PROJECTION = 'local_names';
const SOURCE = 'sealed_records';
const U1 = { project_id: 'p1' };
const ALLOWED = { project_id: ['p1'] };

function text(name: string): DriverColumn {
  return { name, type: 'string', nullable: false };
}

function table(name: string, ...columns: DriverColumn[]): DriverTable {
  return {
    name,
    generation: name,
    columns: [text('id'), text('project_id'), ...columns],
    primaryKey: 'id',
    scopes: [{ pattern: 'project:{project_id}' }],
  };
}

const SCHEMA: DriverSchema = {
  version: 1,
  tables: [
    {
      ...table(SOURCE, text('record_key_id'), text('workspace_id'), {
        name: 'sealed',
        type: 'bytes',
        nullable: false,
      }),
      indexes: [
        { name: 'records_by_key', columns: ['record_key_id'], unique: false },
        {
          name: 'records_by_workspace',
          columns: ['workspace_id'],
          unique: false,
        },
      ],
      localProjections: [
        {
          name: PROJECTION,
          generation: '1',
          columns: [
            { name: 'patient_name', declaredType: 'string' },
            { name: 'sort_order', declaredType: 'integer' },
          ],
          fts: { tokenize: 'unicode61', columns: ['patient_name'] },
          dependencies: [
            { table: 'op_pointers', column: 'id', sourceColumn: 'id' },
            {
              table: 'record_wraps',
              column: 'record_key_id',
              sourceColumn: 'record_key_id',
            },
            {
              table: 'participation',
              column: 'workspace_id',
              sourceColumn: 'workspace_id',
            },
          ],
        },
      ],
    },
    table('op_pointers', text('pointer')),
    table('record_wraps', text('record_key_id')),
    table('participation', text('workspace_id')),
  ],
};

function sourceRow(index: number) {
  return {
    ...U1,
    id: `op-${String(index).padStart(3, '0')}`,
    record_key_id: index === 32 ? 'key-present' : 'key-missing',
    workspace_id: 'workspace-1',
    sealed: { $bytes: 'f23a9b' },
  };
}

async function names(api: ClientInstance, search?: string) {
  const snapshot = await api.querySnapshot!(
    `SELECT _syncular_source_id AS source_id, patient_name FROM ${PROJECTION}${search ? ` WHERE ${PROJECTION} MATCH ?` : ''} ORDER BY source_id`,
    search ? [search] : [],
  );
  return snapshot.rows;
}

async function expectCode(
  call: Promise<unknown>,
  code: string,
  details?: unknown,
) {
  try {
    await call;
  } catch (error) {
    checkEqual(
      (error as { code?: string }).code,
      code,
      'stable projection error code',
    );
    if (details !== undefined)
      checkEqual(
        (error as { details?: unknown }).details,
        details,
        'projection error details',
      );
    return;
  }
  throw new Error(`expected ${code}`);
}

export const localProjectionScenarios: readonly Scenario[] = [
  {
    name: 'local-projections/withholding-dependencies-races-and-restart',
    specRefs: ['Client-local projections', '§7.5'],
    server: { schema: SCHEMA },
    async run(ctx) {
      const a = await ctx.newClient({
        actorId: 'projection-reader',
        clientId: 'projection-reader',
        allowed: ALLOWED,
        schema: SCHEMA,
      });
      const b = await ctx.newClient({
        actorId: 'projection-writer',
        clientId: 'projection-writer',
        allowed: ALLOWED,
        schema: SCHEMA,
      });
      await a.api.subscribe(U1);
      await b.api.subscribe(U1);
      const responses = captureResponses(ctx, a);
      await seedRows(
        ctx,
        SOURCE,
        Array.from({ length: 33 }, (_, index) => sourceRow(index)),
      );
      await seedRows(ctx, 'record_wraps', [
        { ...U1, id: 'present', record_key_id: 'key-present' },
      ]);
      await seedRows(ctx, 'participation', [
        { ...U1, id: 'member', workspace_id: 'workspace-1' },
      ]);
      await syncIdle(a);
      await syncIdle(b);
      const fromA = await a.api.projectionPending(PROJECTION, 1);
      const fromB = await b.api.projectionPending(PROJECTION, 1);
      checkEqual(
        fromA.entries,
        fromB.entries,
        'the replicas can allocate the same tokens',
      );
      checkEqual(
        await b.api.writeProjection(PROJECTION, fromA.epoch, [
          { ...fromA.entries[0]!, values: { patient_name: 'wrong replica' } },
        ]),
        { written: [], stale: ['op-000'] },
        'the epoch fences a batch from another database',
      );
      await a.api.drainProjectionPending();
      await seedRows(ctx, SOURCE, [
        { ...sourceRow(0), sealed: { $bytes: 'a355e1' } },
      ]);
      await syncIdle(a);
      checkEqual(
        await a.api.drainProjectionPending(),
        [{ type: 'projectionPending', name: PROJECTION }],
        'remote apply emits one pending event',
      );
      const pending = () => a.api.projectionPending(PROJECTION, 400);
      const first = await a.api.projectionPending(PROJECTION, 32);
      checkEqual(first.entries.length, 32, 'the batch stops at 32');
      const withheld = await a.api.writeProjection(
        PROJECTION,
        first.epoch,
        first.entries.map((entry) => ({ ...entry, values: null })),
      );
      checkEqual(
        withheld.written,
        first.entries.map((entry) => entry.sourceId),
        'the app records all 32 withheld rows',
      );
      const second = await pending();
      checkEqual(
        second.entries.map((entry) => entry.sourceId),
        ['op-032'],
        'withheld rows do not consume subsequent batches',
      );
      const readable = {
        ...second.entries[0]!,
        values: { patient_name: 'sentinel patient', sort_order: 33 },
      };
      const revision = await a.api.localRevision!();
      await a.api.writeProjection(PROJECTION, second.epoch, [readable]);
      checkEqual(
        await a.api.drainProjectionPending(),
        [],
        'filling the pending set does not schedule work',
      );
      check(
        (await a.api.localRevision!()) !== revision,
        'a projection write advances the observation revision',
      );
      checkEqual(
        await names(a.api, 'sentinel'),
        [{ source_id: 'op-032', patient_name: 'sentinel patient' }],
        'the 33rd row is searchable',
      );
      await ctx.recreateClient(a, SCHEMA);
      checkEqual(
        (await pending()).entries,
        [],
        'withheld entries stay withheld after restart',
      );
      checkEqual((await names(a.api)).length, 1, 'open keeps the filled row');

      await seedRows(ctx, 'record_wraps', [
        { ...U1, id: 'late', record_key_id: 'key-missing' },
      ]);
      await syncIdle(a);
      const unblocked = await pending();
      checkEqual(
        unblocked.entries.map((entry) => entry.sourceId),
        first.entries.map((entry) => entry.sourceId),
        'the late wrap requeues the withheld entries',
      );
      const returnValue = {
        ...unblocked.entries[0]!,
        values: { patient_name: 'old pointer' },
      };
      await a.api.writeProjection(PROJECTION, unblocked.epoch, [returnValue]);
      await seedRows(ctx, 'op_pointers', [
        { ...U1, id: 'op-000', pointer: 'new-seal' },
      ]);
      await syncIdle(a);
      const pointer = await pending();
      checkEqual(
        await names(a.api, 'pointer'),
        [],
        'pointer write clears the old name and its FTS hit',
      );
      checkEqual(
        await a.api.writeProjection(PROJECTION, unblocked.epoch, [returnValue]),
        { written: [], stale: ['op-000'] },
        'the old pointer token writes nothing',
      );
      await ctx.recreateClient(a, SCHEMA);
      checkEqual(
        await pending(),
        pointer,
        'restart resumes the persisted pending tokens',
      );
      checkEqual(
        await names(a.api, 'pointer'),
        [],
        'restart keeps the old pointer absent',
      );

      await seedRows(ctx, 'record_wraps', [
        { ...U1, id: 'late', record_key_id: 'key-present' },
      ]);
      await syncIdle(a);
      const movedWrap = await pending();
      checkEqual(
        movedWrap.entries.length,
        33,
        'both wrap values invalidate their matching rows',
      );
      check(
        movedWrap.entries.every(
          (entry, index) => entry.token !== pointer.entries[index]?.token,
        ),
        'the old wrap value refreshes pending tokens',
      );
      await a.api.writeProjection(PROJECTION, movedWrap.epoch, [
        { ...movedWrap.entries[32]!, values: readable.values },
      ]);
      const inFlight = await pending();
      await b.api.mutate([
        { op: 'delete', table: 'participation', rowId: 'member' },
      ]);
      await syncIdle(b);
      await syncIdle(a);
      checkEqual(
        await names(a.api, 'sentinel'),
        [],
        'participation withdrawal clears the old FTS hit',
      );
      await a.api.invalidateProjection(PROJECTION, ['op-031']);
      const invalidated = await pending();
      checkEqual(
        invalidated.epoch,
        inFlight.epoch + 1,
        'explicit invalidation advances the epoch',
      );
      await ctx.recreateClient(a, SCHEMA);
      checkEqual(await names(a.api), [], 'the withdrawal survives restart');
      const stillPending = invalidated.entries.find(
        (entry) => entry.sourceId === 'op-032',
      )!;
      checkEqual(
        await a.api.writeProjection(PROJECTION, inFlight.epoch, [
          { ...stillPending, values: readable.values },
        ]),
        { written: [], stale: ['op-032'] },
        'an old epoch cannot write a still-current token',
      );

      const currentToken = invalidated.entries[0]!;
      await expectCode(
        a.api.writeProjection(PROJECTION, invalidated.epoch, [
          { ...currentToken, values: { patient_name: 'atomic validation' } },
          { ...invalidated.entries[1]!, values: { sort_order: 'wrong' } },
        ]),
        'client.projection_invalid',
        { name: PROJECTION, column: 'sort_order' },
      );
      checkEqual(
        await pending(),
        invalidated,
        'invalid values roll back pending and written rows',
      );
      checkEqual(
        await names(a.api),
        [],
        'invalid values leave the FTS table empty',
      );

      await b.api.patch(SOURCE, 'op-032', { sealed: { $bytes: 'aa4cb6' } });
      await syncIdle(b);
      await syncIdle(a);
      const localVersion = (await a.api.readRows(SOURCE)).find(
        (row) => row.rowId === 'op-032',
      )!.version;
      await b.api.patch(SOURCE, 'op-032', { sealed: { $bytes: 'bbbccc' } });
      await syncIdle(b);
      const rollback = await a.api.patch(
        SOURCE,
        'op-032',
        { sealed: { $bytes: 'daabbc' } },
        localVersion,
      );
      const firstLocal = await pending();
      const localEntry = firstLocal.entries.find(
        (entry) => entry.sourceId === 'op-032',
      )!;
      checkEqual(
        await a.api.writeProjection(PROJECTION, invalidated.epoch, [
          { ...stillPending, values: readable.values },
        ]),
        { written: [], stale: ['op-032'] },
        'an optimistic edit refreshes the old token',
      );
      await a.api.writeProjection(PROJECTION, firstLocal.epoch, [
        { ...localEntry, values: { patient_name: 'optimistic name' } },
      ]);
      checkEqual(
        (await names(a.api, 'optimistic')).length,
        1,
        'the optimistic name is visible before rollback',
      );
      await syncIdle(a);
      checkEqual(
        (await a.api.commitOutcomes()).find(
          (entry) => entry.clientCommitId === rollback,
        )?.status,
        'conflict',
        'the conflicting optimistic edit rolled back',
      );
      checkEqual(
        await names(a.api, 'optimistic'),
        [],
        'rollback clears the optimistic FTS hit',
      );
      check(
        (await pending()).entries.find((entry) => entry.sourceId === 'op-032')!
          .token > localEntry.token,
        'rollback requeues the held server row',
      );

      const serverRows = await ctx.server.readRows(SOURCE);
      const serverRow = serverRows.find((row) => row.rowId === 'op-032')!;
      checkEqual(
        serverRow.values,
        { ...sourceRow(32), sealed: { $bytes: 'bbbccc' } },
        'server stores only sealed source fields',
      );
      for (const request of a.sentRequests) {
        const decoded = decodeMessage(request);
        if (decoded.msgKind !== 'request') continue;
        for (const frame of decoded.frames) {
          if (frame.type === 'PUSH_COMMIT')
            check(
              frame.operations.every((op) => op.table === SOURCE),
              'push contains only source operations',
            );
        }
      }
      for (const response of responses()) {
        check(
          !JSON.stringify(response).includes(PROJECTION),
          'COMMIT and bootstrap frames omit the projection',
        );
      }
      await expectCode(
        a.api.projectionPending('missing', 1),
        'client.projection_unknown',
        { name: 'missing' },
      );
    },
  },
  {
    name: 'local-projections/generation-eviction-rebootstrap-and-purge',
    specRefs: ['Client-local projections', '§4.8', '§5.11', '§7.4.3'],
    server: { schema: SCHEMA },
    async run(ctx) {
      const a = await ctx.newClient({
        actorId: 'projection-lifecycle',
        clientId: 'projection-lifecycle',
        allowed: ALLOWED,
        schema: SCHEMA,
      });
      const base = { variable: 'project_id' };
      await a.api.setWindow!(base, ['p1']);
      await seedRows(ctx, SOURCE, [sourceRow(0), sourceRow(1)]);
      await syncIdle(a);
      const fill = async () => {
        const batch = await a.api.projectionPending(PROJECTION, 10);
        await a.api.writeProjection(
          PROJECTION,
          batch.epoch,
          batch.entries.map((entry, index) => ({
            ...entry,
            values: index === 0 ? { patient_name: 'local record' } : null,
          })),
        );
        return batch;
      };
      const original = await fill();
      const newGeneration: DriverSchema = {
        ...SCHEMA,
        tables: SCHEMA.tables.map((table) => ({
          ...table,
          ...(table.localProjections
            ? {
                localProjections: table.localProjections.map((spec) => ({
                  ...spec,
                  generation: '2',
                })),
              }
            : {}),
        })),
      };
      await ctx.recreateClient(a, newGeneration);
      checkEqual(
        (await a.api.readRows(SOURCE)).length,
        2,
        'projection generation change preserves source rows',
      );
      checkEqual(
        await names(a.api, 'record'),
        [],
        'generation change clears FTS',
      );
      const changed = await fill();
      checkEqual(
        changed.epoch,
        original.epoch + 1,
        'generation advances epoch',
      );
      checkEqual(
        changed.entries.length,
        2,
        'generation resets both filled and withheld rows',
      );
      check(
        changed.entries[0]!.token > original.entries[1]!.token,
        'generation assigns fresh tokens',
      );
      await a.api.setWindow!(base, []);
      await syncIdle(a);
      checkEqual(await names(a.api), [], 'eviction removes projection rows');
      checkEqual(
        (await a.api.projectionPending(PROJECTION, 10)).entries,
        [],
        'eviction removes pending and withheld state',
      );

      await a.api.setWindow!(base, ['p1']);
      await syncIdle(a);
      checkEqual(
        (await fill()).entries.length,
        2,
        'evicted rows can bootstrap again',
      );
      await a.api.rebootstrapLocalData('rebuild-projections');
      checkEqual(
        await names(a.api, 'record'),
        [],
        'rebootstrap deletes projection FTS entries atomically',
      );
      checkEqual(
        (await a.api.projectionPending(PROJECTION, 10)).entries,
        [],
        'rebootstrap removes pending and withheld state',
      );
      await syncIdle(a);
      checkEqual(
        (await fill()).entries.length,
        2,
        'rebootstrap reschedules the imported source rows',
      );

      const optimistic = await a.api.mutate([
        { op: 'upsert', table: SOURCE, values: sourceRow(2) },
      ]);
      const prePurge = await a.api.projectionPending(PROJECTION, 10);
      await a.api.beginSecurityPreflight();
      await expectCode(
        a.api.projectionPending(PROJECTION, 10),
        'client.security_preflight_required',
      );
      await expectCode(
        a.api.writeProjection(PROJECTION, 0, []),
        'client.security_preflight_required',
      );
      await expectCode(
        a.api.invalidateProjection(PROJECTION),
        'client.security_preflight_required',
      );
      await expectCode(
        a.api.purgeLocalData('unknown-projection', [{ projection: 'missing' }]),
        'client.projection_unknown',
        { name: 'missing' },
      );
      const projectionPurge = [{ projection: PROJECTION }];
      checkEqual(
        await a.api.purgeLocalData('sign-out-projection', projectionPurge),
        { alreadyApplied: false, purgedRows: 1, droppedCommits: 0 },
        'preflight permits a projection-only erase',
      );
      await a.api.activateSecurity();
      await ctx.recreateClient(a, newGeneration);
      await a.api.beginSecurityPreflight();
      checkEqual(
        await a.api.purgeLocalData('sign-out-projection', projectionPurge),
        { alreadyApplied: true, purgedRows: 0, droppedCommits: 0 },
        'restart resumes the durable purge receipt',
      );
      await a.api.activateSecurity();
      checkEqual(
        await names(a.api, 'record'),
        [],
        'projection erasure clears content and FTS',
      );
      checkEqual(
        await a.api.pendingCommitIds(),
        [optimistic],
        'projection erasure keeps the outbox',
      );
      checkEqual(
        (await a.api.readRows(SOURCE)).length,
        3,
        'projection erasure keeps source rows',
      );
      const afterPurge = await a.api.projectionPending(PROJECTION, 10);
      checkEqual(
        afterPurge.entries.length,
        3,
        'erasure queues every source row including withheld rows',
      );
      checkEqual(
        await a.api.writeProjection(PROJECTION, prePurge.epoch, [
          { ...afterPurge.entries[0]!, values: { patient_name: 'old name' } },
        ]),
        { written: [], stale: ['op-000'] },
        'erasure fences the pre-purge epoch',
      );
      await a.api.purgeLocalData('sign-out', [
        { table: SOURCE, selectors: { project_id: ['p1'] } },
        { projection: PROJECTION },
      ]);
      checkEqual(
        await names(a.api, 'record'),
        [],
        'sign-out purge removes FTS copies',
      );
      checkEqual(
        (await a.api.projectionPending(PROJECTION, 10)).entries,
        [],
        'sign-out purge removes pending entries',
      );
      await ctx.recreateClient(a, newGeneration);
      checkEqual(
        await names(a.api),
        [],
        'purged projection stays empty on restart',
      );
    },
  },
  {
    name: 'local-projections/scope-revocation-clears-pending-and-fts',
    specRefs: ['Client-local projections', '§3.3'],
    requires: ['scope-authorization'],
    server: { schema: SCHEMA },
    async run(ctx) {
      const a = await ctx.newClient({
        actorId: 'projection-revoked',
        clientId: 'projection-revoked',
        allowed: ALLOWED,
        schema: SCHEMA,
      });
      await a.api.subscribe(U1);
      await seedRows(ctx, SOURCE, [sourceRow(0), sourceRow(1)]);
      await syncIdle(a);
      const batch = await a.api.projectionPending(PROJECTION, 10);
      await a.api.writeProjection(PROJECTION, batch.epoch, [
        { ...batch.entries[0]!, values: { patient_name: 'private record' } },
      ]);
      await ctx.server.setAllowedScopes(a.actorId, { project_id: [] });
      const revoked = await syncIdle(a);
      checkEqual(
        revoked.revoked,
        [unitId(U1)],
        'the server revokes the source unit',
      );
      checkEqual(
        await names(a.api, 'private'),
        [],
        'revocation clears FTS hits',
      );
      checkEqual(
        (await a.api.projectionPending(PROJECTION, 10)).entries,
        [],
        'revocation clears pending rows',
      );
    },
  },
  {
    name: 'local-projections/bootstrap-exports-only-sealed-source',
    specRefs: ['Client-local projections', '§5.2', '§5.3'],
    requires: ['sqlite-image'],
    server: { schema: SCHEMA },
    async run(ctx) {
      const a = await ctx.newClient({
        actorId: 'projection-export',
        clientId: 'projection-export',
        allowed: ALLOWED,
        schema: SCHEMA,
      });
      await a.api.subscribe(U1);
      await seedRows(ctx, SOURCE, [sourceRow(0), sourceRow(1)]);
      await syncIdle(a);
      const batch = await a.api.projectionPending(PROJECTION, 10);
      await a.api.writeProjection(PROJECTION, batch.epoch, [
        {
          ...batch.entries[0]!,
          values: { patient_name: 'PrivatePlaintextSentinel' },
        },
      ]);
      for (const accept of [0b0011, 0b0111]) {
        const pull = await ctx.rawSync(
          a.actorId,
          rawPull([{ scopes: U1, cursor: -1 }], {
            accept,
            limitSnapshotRows: 1,
          }),
          { clientId: `projection-export-${accept}` },
        );
        check(pull.ok, 'bootstrap export succeeds');
        const segments = responseSection(pull.message, U1).body;
        check(segments.length > 0, 'bootstrap exports the source');
        let images = 0;
        for (const frame of segments) {
          if (frame.type === 'SEGMENT_INLINE') {
            check(
              !new TextDecoder()
                .decode(frame.payload)
                .includes('PrivatePlaintextSentinel'),
              'inline segment omits plaintext',
            );
          } else if (frame.type === 'SEGMENT_REF') {
            check(frame.table !== PROJECTION, 'the projection has no segment');
            const download = await ctx.server.downloadSegment(
              a.actorId,
              frame.segmentId,
              canonicalScopeJson(ALLOWED),
            );
            check(download.ok, 'the exported segment downloads');
            check(
              !new TextDecoder()
                .decode(download.bytes)
                .includes('PrivatePlaintextSentinel'),
              'exported segment omits plaintext',
            );
            if (frame.mediaType === 'sqlite' && frame.table === SOURCE) {
              images++;
              const image = Database.deserialize(download.bytes);
              try {
                checkEqual(
                  image
                    .query(
                      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
                    )
                    .all(),
                  [{ name: '_syncular_segment' }, { name: SOURCE }],
                  'the image contains only the source and segment metadata',
                );
                checkEqual(
                  image
                    .query(`SELECT lower(hex(sealed)) AS sealed FROM ${SOURCE}`)
                    .all(),
                  [
                    { sealed: sourceRow(0).sealed.$bytes },
                    { sealed: sourceRow(1).sealed.$bytes },
                  ],
                  'source data stays sealed in the image',
                );
              } finally {
                image.close();
              }
            }
          }
        }
        checkEqual(
          images,
          accept === 0b0111 ? 1 : 0,
          'the scenario checks both bootstrap formats',
        );
      }
    },
  },
  {
    name: 'local-projections/dependency-fan-out',
    specRefs: ['Client-local projections'],
    server: { schema: SCHEMA },
    async run(ctx) {
      const a = await ctx.newClient({
        actorId: 'projection-fanout',
        clientId: 'projection-fanout',
        allowed: ALLOWED,
        schema: SCHEMA,
      });
      await a.api.subscribe(U1);
      for (let start = 0; start < 300; start += 100) {
        await seedRows(
          ctx,
          SOURCE,
          Array.from({ length: 100 }, (_, index) => sourceRow(start + index)),
        );
      }
      await syncIdle(a);
      const batch = await a.api.projectionPending(PROJECTION, 300);
      checkEqual(
        batch.entries.length,
        300,
        'the fan-out test has 300 source rows',
      );
      await a.api.writeProjection(
        PROJECTION,
        batch.epoch,
        batch.entries.map((entry) => ({
          ...entry,
          values: { patient_name: 'fanout' },
        })),
      );
      const start = performance.now();
      await a.api.mutate([
        {
          op: 'upsert',
          table: 'participation',
          values: { ...U1, id: 'member', workspace_id: 'workspace-1' },
        },
      ]);
      const elapsed = performance.now() - start;
      if (process.env.SYNCULAR_PROJECTION_TIMING === '1')
        console.info(
          `300-row projection fan-out authoring transaction: ${elapsed.toFixed(2)} ms`,
        );
      checkEqual(
        await names(a.api, 'fanout'),
        [],
        'one dependency write clears all 300 FTS hits',
      );
      checkEqual(
        (await a.api.projectionPending(PROJECTION, 400)).entries.length,
        300,
        'one dependency write requeues all 300 rows',
      );
    },
  },
];
