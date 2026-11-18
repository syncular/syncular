/**
 * §3.1 NULL scopes outside the owner set and §3.4 alternative write sets,
 * driven through bytes on every relational storage: an owner set admits
 * inserts, any set admits writes to a stored row, and a variable without a
 * value neither admits a write nor matches a unit.
 */
import { describe, expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import {
  decodeMessage,
  decodeRowsSegment,
  encodeSparseRow,
  type RequestFrame,
  type ResponseMessage,
  type RowColumn,
  type ScopeMap,
  type SegmentInlineFrame,
} from '@syncular/core';
import {
  compileSchema,
  D1ServerStorage,
  handleSyncRequest,
  MemorySegmentStore,
  PostgresServerStorage,
  type ServerSchema,
  type ServerStorage,
  SqliteServerStorage,
  type TableSchema,
} from '@syncular/server';
import { pgliteExecutor } from '@syncular/server/pglite';
import { D1DatabaseDouble } from './d1-double';
import {
  del,
  liveChanges,
  pushCommit,
  pushResults,
  requestBytes,
  section,
  TEST_LOG_EPOCH,
  TestReplica,
  upsert,
} from './helpers';

const COLUMNS: readonly RowColumn[] = [
  { name: 'id', type: 'string', nullable: false },
  { name: 'facility_id', type: 'string', nullable: true },
  { name: 'window_id', type: 'string', nullable: true },
  { name: 'body', type: 'string', nullable: false },
];

const SCHEMA: ServerSchema = {
  version: 1,
  tables: [
    {
      name: 'docs',
      columns: COLUMNS,
      primaryKey: 'id',
      scopes: ['facility:{facility_id}', 'window:{window_id}'],
      writeScopeVariables: [['facility_id'], ['window_id']],
    },
  ],
};

const OWNER = { facility_id: ['f1'] };
const CENTRE = { window_id: ['w1'] };

function doc(
  id: string,
  facility: string | null,
  window: string | null,
  body = 'body',
): Uint8Array {
  return encodeSparseRow(COLUMNS, 0, [id, facility, window, body]);
}

async function open(backend: 'sqlite' | 'postgres' | 'd1'): Promise<{
  readonly storage: ServerStorage;
  readonly close: () => Promise<void>;
}> {
  if (backend === 'postgres') {
    const db = await PGlite.create();
    return {
      storage: new PostgresServerStorage(pgliteExecutor(db)),
      close: () => db.close(),
    };
  }
  if (backend === 'sqlite') {
    return { storage: new SqliteServerStorage(), close: async () => {} };
  }
  const storage = new D1ServerStorage(new D1DatabaseDouble(), {
    pushApplySerialized: true,
  });
  while (!(await storage.migrateSchema(compileSchema(SCHEMA))).complete) {
    // Resume the resumable D1 migration until it lands.
  }
  return { storage, close: async () => {} };
}

describe('write sets and NULL scopes (§3.1, §3.4)', () => {
  for (const backend of ['sqlite', 'postgres', 'd1'] as const) {
    test(`${backend}: the owner set inserts, any set updates, a NULL scope admits and matches nothing`, async () => {
      const { storage, close } = await open(backend);
      let allowed: ScopeMap = OWNER;
      const segments = new MemorySegmentStore();
      await storage.ensureSchema(compileSchema(SCHEMA));
      await storage.touchPartition('part-1', 1, TEST_LOG_EPOCH);
      const send = async (
        clientId: string,
        frames: RequestFrame[],
      ): Promise<ResponseMessage> => {
        const message = decodeMessage(
          await handleSyncRequest(requestBytes(frames, clientId), {
            partition: 'part-1',
            actorId: clientId,
            schema: SCHEMA,
            storage,
            segments,
            resolveScopes: () => allowed,
            clock: () => 1,
          }),
        );
        if (message.msgKind !== 'response') throw new Error('not a response');
        return message;
      };
      const push = async (
        clientId: string,
        ops: Parameters<typeof pushCommit>[1],
      ) =>
        pushResults(
          await send(clientId, [pushCommit(crypto.randomUUID(), ops)]),
        )[0];
      const outcome = async (
        clientId: string,
        ops: Parameters<typeof pushCommit>[1],
      ) => {
        const result = await push(clientId, ops);
        return result?.status === 'applied'
          ? 'applied'
          : (result?.results.find((r) => r.status !== 'applied') ?? result);
      };
      const forbidden = { status: 'error', code: 'sync.forbidden' };
      const bootstrapped = (message: ResponseMessage, unit: ScopeMap) =>
        section(
          message,
          Object.fromEntries(
            Object.entries(unit).map(([key, [value]]) => [key, value!]),
          ),
        )
          .body.filter(
            (f): f is SegmentInlineFrame => f.type === 'SEGMENT_INLINE',
          )
          .flatMap((f) => decodeRowsSegment(f.payload).blocks.flat())
          .map((row) => row.values[0]);
      try {
        expect(
          await outcome('owner', [
            upsert('docs', 'd1', doc('d1', 'f1', 'w1')),
            upsert('docs', 'd2', doc('d2', 'f1', null)),
          ]),
        ).toBe('applied');
        // An owner-set variable needs a value; no variable takes ''.
        for (const row of [
          doc('d3', null, 'w1'),
          doc('d3', 'f1', ''),
          doc('d3', '', null),
        ]) {
          expect(
            await outcome('owner', [upsert('docs', 'd3', row)]),
          ).toMatchObject(forbidden);
        }
        expect((await storage.getRow('part-1', 'docs', 'd2'))?.scopes).toEqual({
          facility_id: 'f1',
        });

        allowed = CENTRE;
        const centre = new TestReplica('centre').register({ window_id: 'w1' });
        let message = await send('centre', centre.frames());
        centre.apply(message);
        expect(bootstrapped(message, { window_id: ['w1'] })).toEqual(['d1']);
        expect(
          await outcome('centre', [
            upsert('docs', 'd1', doc('d1', 'f1', 'w1', 'centre'), 1),
          ]),
        ).toBe('applied');
        for (const ops of [
          // Insert needs the owner set, whatever facility it names.
          [upsert('docs', 'd5', doc('d5', 'f1', 'w1'))],
          [upsert('docs', 'd6', doc('d6', 'f2', 'w1'), 0)],
          // A row without a window admits no window holder.
          [upsert('docs', 'd2', doc('d2', 'f1', null, 'x'), 1)],
          [upsert('docs', 'd2', doc('d2', 'f1', null, 'x'), 0)],
          [del('docs', 'd2')],
        ]) {
          expect(await outcome('centre', ops)).toMatchObject(forbidden);
        }
        // Scope columns stay immutable for a second-set writer.
        expect(
          await outcome('centre', [
            upsert('docs', 'd1', doc('d1', 'f2', 'w1'), 2),
          ]),
        ).toMatchObject({ status: 'error', code: 'sync.invalid_request' });
        // A wildcard window grant still admits nothing without a value.
        allowed = { window_id: ['*'] };
        expect(
          await outcome('centre', [
            upsert('docs', 'd2', doc('d2', 'f1', null, 'x'), 1),
          ]),
        ).toMatchObject(forbidden);

        allowed = OWNER;
        expect(
          await outcome('owner', [
            upsert('docs', 'd2', doc('d2', 'f1', null, 'owner'), 1),
          ]),
        ).toBe('applied');
        const owner = new TestReplica('owner').register({ facility_id: 'f1' });
        message = await send('owner', owner.frames());
        expect(bootstrapped(message, OWNER)).toEqual(['d1', 'd2']);

        allowed = CENTRE;
        message = await send('centre', centre.frames());
        centre.apply(message);
        expect(liveChanges(message)).toEqual(['docs/d1/upsert']);

        // Revocation: the pending write and the unit both end.
        allowed = { window_id: ['w2'] };
        expect(
          await outcome('centre', [
            upsert('docs', 'd1', doc('d1', 'f1', 'w1', 'late'), 2),
          ]),
        ).toMatchObject(forbidden);
        message = await send('centre', centre.frames());
        expect(section(message, { window_id: 'w1' }).start.status).toBe(
          'revoked',
        );
      } finally {
        await close();
      }
    });
  }

  test('write sets compile from one list or distinct nonempty lists of declared variables', () => {
    const { writeScopeVariables: _, ...table } = SCHEMA.tables[0]!;
    const sets = (writeScopeVariables?: TableSchema['writeScopeVariables']) =>
      compileSchema({
        version: 1,
        tables: [
          writeScopeVariables === undefined
            ? table
            : { ...table, writeScopeVariables },
        ],
      }).tables.get('docs')?.writeScopeSets;
    expect(sets()).toEqual([['facility_id', 'window_id']]);
    expect(sets(['window_id'])).toEqual([['window_id']]);
    expect(sets([['facility_id'], ['window_id', 'facility_id']])).toEqual([
      ['facility_id'],
      ['window_id', 'facility_id'],
    ]);
    const invalids: NonNullable<TableSchema['writeScopeVariables']>[] = [
      [],
      [[]],
      [['facility_id'], []],
      [['facility_id', 'facility_id']],
      [
        ['facility_id', 'window_id'],
        ['window_id', 'facility_id'],
      ],
      [['missing']],
    ];
    for (const invalid of invalids) {
      expect(() => sets(invalid)).toThrow('writeScopeVariables');
    }
  });
});
