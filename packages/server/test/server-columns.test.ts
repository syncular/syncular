/**
 * §6.12 server-owned columns: a per-table hook completes an accepted upsert
 * inside the push transaction, the server discards pushed values of those
 * columns, and the stored scopes take the hook's values in the same commit.
 */
import { describe, expect, test } from 'bun:test';
import {
  decodeMessage,
  decodeRow,
  encodeSparseRow,
  type RequestFrame,
  type RowColumn,
  type SparseRowValue,
} from '@syncular/core';
import {
  compileSchema,
  handleSyncRequest,
  schemaWindowOf,
  type ServerColumnsHook,
  type ServerSchema,
  type TableSchema,
  type ValidateRow,
  ValidationRejection,
} from '@syncular/server';
import {
  liveChanges,
  makeContext,
  pushCommit,
  pushResults,
  requestBytes,
  TestReplica,
  upsert,
} from './helpers';

const EVENT_COLUMNS: readonly RowColumn[] = [
  { name: 'id', type: 'string', nullable: false },
  { name: 'facility_id', type: 'string', nullable: false },
  { name: 'body', type: 'string', nullable: false },
  { name: 'actor_label', type: 'string', nullable: true, serverOwned: true },
  { name: 'facility_label', type: 'string', nullable: true, serverOwned: true },
  {
    name: 'activity_window_id',
    type: 'string',
    nullable: true,
    serverOwned: true,
  },
];
const FACILITY_COLUMNS: readonly RowColumn[] = [
  { name: 'id', type: 'string', nullable: false },
  { name: 'facility_id', type: 'string', nullable: false },
  { name: 'label', type: 'string', nullable: false },
];
const EVENTS: TableSchema = {
  name: 'domain_events',
  columns: EVENT_COLUMNS,
  primaryKey: 'id',
  scopes: ['facility:{facility_id}', 'activity:{activity_window_id}'],
  writeScopeVariables: ['facility_id'],
};
const FACILITIES: TableSchema = {
  name: 'facilities',
  columns: FACILITY_COLUMNS,
  primaryKey: 'id',
  scopes: ['facility:{facility_id}'],
};
const SCHEMA: ServerSchema = { version: 2, tables: [FACILITIES, EVENTS] };
/** The older app: `actor_label` was a client-written column, the other two
 * server-owned columns did not exist. */
const OLDER: ServerSchema = {
  version: 1,
  tables: [
    FACILITIES,
    {
      ...EVENTS,
      columns: [
        ...EVENT_COLUMNS.slice(0, 3),
        { name: 'actor_label', type: 'string', nullable: true },
      ],
      scopes: ['facility:{facility_id}'],
    },
  ],
};

/** Labels from the actor and the candidate facility row; the activity window
 * from the body, on insert only (§3.4 rule 5 keeps it on update). */
const labels: ServerColumnsHook = async (
  { row, stored },
  { actorId, read },
) => {
  const facility = await read.getRow('facilities', String(row.facility_id));
  return {
    actor_label: `Actor ${actorId}`,
    facility_label: facility?.row.label ?? null,
    ...(stored === undefined ? { activity_window_id: `w-${row.body}` } : {}),
  };
};

function fixture(hook: ServerColumnsHook = labels) {
  const validated: ValidateRow[] = [];
  const t = makeContext({
    schema: SCHEMA,
    schemaWindow: [compileSchema(SCHEMA), compileSchema(OLDER)],
    serverColumns: { domain_events: hook },
    validators: {
      domain_events: (op) => {
        if (op.row !== undefined) validated.push(op.row);
      },
    },
  });
  t.scopes.value = { facility_id: ['f1'], activity_window_id: ['*'] };
  const send = async (frames: RequestFrame[], schemaVersion = 2) => {
    const message = decodeMessage(
      await handleSyncRequest(
        requestBytes(frames, 'client-1', schemaVersion),
        t.ctx,
      ),
    );
    if (message.msgKind !== 'response') throw new Error('expected response');
    return message;
  };
  const push = async (
    id: string,
    payload: readonly SparseRowValue[],
    options?: { schemaVersion?: number; baseVersion?: number },
  ) =>
    pushResults(
      await send(
        [
          pushCommit(crypto.randomUUID(), [
            upsert(
              'domain_events',
              id,
              encodeSparseRow(
                options?.schemaVersion === 1
                  ? OLDER.tables[1]!.columns
                  : EVENT_COLUMNS,
                0,
                payload,
              ),
              options?.baseVersion,
            ),
          ]),
        ],
        options?.schemaVersion,
      ),
    )[0];
  const stored = async (id: string) => {
    const row = await t.storage.getRow('part-1', 'domain_events', id);
    return row === undefined
      ? undefined
      : {
          values: decodeRow(EVENT_COLUMNS, row.payload),
          scopes: row.scopes,
          serverVersion: row.serverVersion,
        };
  };
  return { t, send, push, stored, validated };
}

describe('server-owned columns (§6.12)', () => {
  test('an insert without the columns stores the hook values and reaches the server-set unit in the same commit', async () => {
    const { send, stored, validated } = fixture();
    const activity = new TestReplica().register({
      activity_window_id: 'w-day1',
    });
    activity.apply(await send(activity.frames()));
    const message = await send([
      pushCommit('c1', [
        upsert(
          'facilities',
          'f1',
          encodeSparseRow(FACILITY_COLUMNS, 0, ['f1', 'f1', 'Ward 3']),
        ),
        // A current client presents NULL for every server-owned column.
        upsert(
          'domain_events',
          'e1',
          encodeSparseRow(EVENT_COLUMNS, 0, [
            'e1',
            'f1',
            'day1',
            null,
            null,
            null,
          ]),
        ),
      ]),
    ]);
    expect(pushResults(message)[0]?.status).toBe('applied');
    expect(await stored('e1')).toEqual({
      values: ['e1', 'f1', 'day1', 'Actor actor-1', 'Ward 3', 'w-day1'],
      scopes: { facility_id: 'f1', activity_window_id: 'w-day1' },
      serverVersion: 1,
    });
    // The §6.7 validator sees the completed row.
    expect(validated.at(-1)).toMatchObject({ actor_label: 'Actor actor-1' });
    const pulled = await send(activity.frames());
    activity.apply(pulled);
    expect(liveChanges(pulled)).toEqual(['domain_events/e1/upsert']);
  });

  test('an older client that writes the column, or omits the new ones, is accepted with the server values', async () => {
    const { push, stored } = fixture();
    expect(
      (await push('e1', ['e1', 'f1', 'day1', 'forged'], { schemaVersion: 1 }))
        ?.status,
    ).toBe('applied');
    expect((await stored('e1'))?.values).toEqual([
      'e1',
      'f1',
      'day1',
      'Actor actor-1',
      null,
      'w-day1',
    ]);
    // A sparse patch: the hook recomputes the labels, the scope column stays.
    expect(
      (
        await push('e1', ['e1', undefined, 'day2', 'forged again'], {
          schemaVersion: 1,
          baseVersion: 1,
        })
      )?.status,
    ).toBe('applied');
    // A pushed scope value of a server-owned column is discarded, never
    // judged by the §3.4 rule 5 immutability check.
    expect(
      (
        await push('e1', ['e1', undefined, undefined, 'x', 'y', 'w-other'], {
          baseVersion: 2,
        })
      )?.status,
    ).toBe('applied');
    expect(await stored('e1')).toMatchObject({
      values: ['e1', 'f1', 'day2', 'Actor actor-1', null, 'w-day1'],
      scopes: { facility_id: 'f1', activity_window_id: 'w-day1' },
      serverVersion: 3,
    });
  });

  test('a hook fault rejects the commit; a ValidationRejection keeps its host code', async () => {
    const faults: [ServerColumnsHook, string][] = [
      [() => ({ body: 'rewritten' }), 'sync.constraint_violation'],
      [() => ({ actor_label: 7 }), 'sync.constraint_violation'],
      [() => ({ activity_window_id: '' }), 'sync.constraint_violation'],
      [
        () => {
          throw new Error('lookup failed');
        },
        'sync.constraint_violation',
      ],
      [
        () => {
          throw new ValidationRejection('app.unknown_actor');
        },
        'app.unknown_actor',
      ],
    ];
    for (const [hook, code] of faults) {
      const { push, stored } = fixture(hook);
      const result = await push('e1', ['e1', 'f1', 'day1', null, null, null]);
      expect(result?.results[0]).toMatchObject({ status: 'error', code });
      expect(await stored('e1')).toBeUndefined();
    }
    // An update that moves the server-owned scope column is a server fault.
    const { push, stored } = fixture(({ row }) => ({
      activity_window_id: `w-${row.body}`,
    }));
    await push('e1', ['e1', 'f1', 'day1', null, null, null]);
    expect(
      (
        await push(
          'e1',
          ['e1', undefined, 'day2', undefined, undefined, undefined],
          {
            baseVersion: 1,
          },
        )
      )?.results[0],
    ).toMatchObject({
      status: 'error',
      code: 'sync.constraint_violation',
      message: 'server column hook failed',
    });
    expect((await stored('e1'))?.values[5]).toBe('w-day1');
  });

  test('schema compile refuses a server-owned column the hook could not own', () => {
    const owned =
      (column: Partial<RowColumn>, table: Partial<TableSchema> = {}) =>
      () =>
        compileSchema({
          version: 1,
          tables: [
            {
              ...EVENTS,
              columns: EVENT_COLUMNS.map((existing) =>
                existing.name === (column.name ?? 'actor_label')
                  ? { ...existing, ...column, serverOwned: true }
                  : existing,
              ),
              ...table,
            },
          ],
        });
    expect(owned({ nullable: true })).not.toThrow();
    for (const refused of [
      owned({ nullable: false }),
      owned({ name: 'id' }),
      owned({ name: 'facility_id', nullable: true }),
      owned({ type: 'crdt', crdtType: 'yjs-doc' }),
      owned({ type: 'bytes', encrypted: true, declaredType: 'string' }),
      owned(
        { name: 'activity_window_id' },
        { writeScopeVariables: ['facility_id', 'activity_window_id'] },
      ),
    ]) {
      expect(refused).toThrow('server-owned column');
    }
    // A pattern appended over a client-written column still floors older apps.
    const clientWritten: ServerSchema = {
      ...SCHEMA,
      tables: [
        FACILITIES,
        {
          ...EVENTS,
          columns: EVENT_COLUMNS.map(({ serverOwned: _, ...column }) => column),
        },
      ],
    };
    expect(() =>
      schemaWindowOf(clientWritten, [
        compileSchema(clientWritten),
        compileSchema(OLDER),
      ]),
    ).toThrow('sync.schema_window.incompatible_schema');
  });
});
