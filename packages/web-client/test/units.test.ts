/**
 * Wire version 4 client behaviour against a scripted transport (SPEC §4):
 * the unit store, the registration list and digest, PROGRESS, the replica
 * cursor and join rule J, the live-section unit filter, resets, revocation,
 * windows as sets of units, the outbox sequence and the §9 upgrade of a
 * version 3 replica.
 */
import { describe, expect, test } from 'bun:test';
import {
  type CommitChange,
  decodeMessage,
  encodeMessage,
  encodeRow,
  encodeRowsSegment,
  type FencedRecord,
  PROTOCOL_WIRE_VERSION,
  type RequestFrame,
  type ResponseFrame,
  type RowColumn,
  type RowValue,
  registrationDigest,
  type UnitScopes,
  unitId,
} from '@syncular/core';
import { type ClientSchema, SyncClient } from '../src';
import { BunClientDatabase } from '../src/bun-database';
import type { SqlRow, SqlValue } from '../src/database';
import { deleteUnit } from '../src/state';
import type { RealtimeHandlers } from '../src/transport';
import { savePendingEviction, WINDOWS_TABLE } from '../src/window';

const TASKS: readonly RowColumn[] = [
  { name: 'id', type: 'string', nullable: false },
  { name: 'project_id', type: 'string', nullable: false },
  { name: 'title', type: 'string', nullable: false },
];
const NOTES: readonly RowColumn[] = [
  { name: 'id', type: 'string', nullable: false },
  { name: 'project_id', type: 'string', nullable: false },
  { name: 'org_id', type: 'string', nullable: false },
  { name: 'body', type: 'string', nullable: false },
];
const SCHEMA: ClientSchema = {
  version: 1,
  tables: [
    {
      name: 'tasks',
      columns: TASKS,
      primaryKey: 'id',
      scopes: ['project:{project_id}'],
    },
    {
      name: 'notes',
      columns: NOTES,
      primaryKey: 'id',
      scopes: ['project:{project_id}', 'org:{org_id}'],
    },
  ],
};
const COLUMNS: Record<string, readonly RowColumn[]> = {
  tasks: TASKS,
  notes: NOTES,
};
const P1 = { project_id: 'p1' };
const P2 = { project_id: 'p2' };
const ECHO = new Uint8Array(32).fill(7);

/** Chained microtasks: lets settled promise chains run, never a timer. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 50; turn += 1) await Promise.resolve();
}

function start(
  id: string,
  options: Partial<{
    status: 'active' | 'revoked' | 'reset';
    bootstrap: boolean;
    fenced: FencedRecord[];
  }> = {},
): ResponseFrame {
  const status = options.status ?? 'active';
  return {
    type: 'SUB_START',
    id,
    status,
    reasonCode:
      status === 'revoked'
        ? 'sync.scope_revoked'
        : status === 'reset'
          ? 'sync.cursor_expired'
          : '',
    bootstrap: options.bootstrap ?? false,
    fenced: options.fenced ?? [],
  };
}

function rows(table: string, ...values: RowValue[][]): ResponseFrame {
  return rowsAt(table, 1, ...values);
}

function rowsAt(
  table: string,
  serverVersion: number,
  ...values: RowValue[][]
): ResponseFrame {
  return {
    type: 'SEGMENT_INLINE',
    payload: encodeRowsSegment({
      table,
      schemaVersion: 1,
      columns: COLUMNS[table]!,
      blocks:
        values.length === 0
          ? []
          : [values.map((row) => ({ serverVersion, values: row }))],
    }),
  };
}

/** A complete bootstrap section with one page per table. */
function bootstrap(
  scopes: UnitScopes,
  pin: number,
  pages: ResponseFrame[],
  fenced: FencedRecord[] = [],
): ResponseFrame[] {
  return [
    start(unitId(scopes), { bootstrap: true, fenced }),
    ...pages,
    { type: 'SUB_END', nextCursor: pin },
  ];
}

/** A change at `rowVersion`; segment rows (`rows`) stand at version 1. */
function change(
  table: string,
  op: 'upsert' | 'delete',
  values: RowValue[],
  rowVersion = 2,
): Omit<CommitChange, 'tableIndex'> & { table: string } {
  const scopes: Record<string, string> = { project_id: String(values[1]) };
  if (table === 'notes') scopes.org_id = String(values[2]);
  return {
    table,
    rowId: String(values[0]),
    op,
    rowVersion,
    scopes,
    ...(op === 'upsert' ? { row: encodeRow(COLUMNS[table]!, values) } : {}),
  };
}

function commit(
  commitSeq: number,
  ...changes: ReturnType<typeof change>[]
): ResponseFrame {
  const tables = [...new Set(changes.map((item) => item.table))];
  return {
    type: 'COMMIT',
    commitSeq,
    createdAtMs: 1,
    actorId: 'actor',
    tables,
    changes: changes.map(({ table, ...item }) => ({
      ...item,
      tableIndex: tables.indexOf(table),
    })),
  };
}

function live(
  throughSeq: number,
  ...commits: ResponseFrame[]
): ResponseFrame[] {
  return [
    { type: 'LIVE_START', status: 'active', reasonCode: '' },
    ...commits,
    { type: 'LIVE_END', throughSeq, echoDigest: ECHO },
  ];
}

function encode(frames: ResponseFrame[]): Uint8Array {
  return encodeMessage({
    wireVersion: PROTOCOL_WIRE_VERSION,
    msgKind: 'response',
    frames: [
      { type: 'RESP_HEADER', logEpoch: 'e1', resetRequired: false },
      ...frames,
    ],
  });
}

/** A client whose transport answers each round with the next script. */
async function scripted(db = new BunClientDatabase()) {
  const requests: RequestFrame[][] = [];
  const script: ResponseFrame[][] = [];
  const handlers: RealtimeHandlers[] = [];
  const acks: number[] = [];
  const client = new SyncClient({
    database: db,
    schema: SCHEMA,
    clientId: 'units-client',
    transport: async (request) => {
      const message = decodeMessage(request);
      if (message.msgKind !== 'request') throw new Error('not a request');
      requests.push(message.frames);
      const next = script.shift();
      if (next === undefined) throw new Error('no scripted response');
      return encode(next);
    },
    realtime: (h) => {
      handlers.push(h);
      return {
        send: (text) => acks.push(JSON.parse(text).cursor),
        sendBytes: () => {
          throw new Error('rounds stay on the scripted transport');
        },
        close: () => {},
      };
    },
  });
  await client.start();
  db.exec(
    "INSERT OR REPLACE INTO _syncular_meta(key,value) VALUES('logEpoch','e1')",
  );
  const round = async (...frames: ResponseFrame[]) => {
    script.push(frames);
    return client.sync();
  };
  const last = () => requests[requests.length - 1]!;
  const ids = (table: string) =>
    client
      .query(`SELECT id FROM ${table} ORDER BY id`)
      .map((row) => String(row.id));
  /** Deliver one delta (§8.2) and wait for its serialized apply. */
  const delta = async (frames: ResponseFrame[] | Uint8Array) => {
    handlers[handlers.length - 1]!.onBinary(
      new Uint8Array([
        0x00,
        ...(frames instanceof Uint8Array ? frames : encode(frames)),
      ]),
    );
    await settle();
    // The window edit runs after the delta on the operation chain.
    await client.setWindow({ variable: 'project_id' }, []);
  };
  return { client, db, requests, last, round, ids, delta, acks };
}

function framesOf<T extends RequestFrame['type']>(
  frames: RequestFrame[],
  type: T,
): Extract<RequestFrame, { type: T }>[] {
  return frames.filter(
    (frame): frame is Extract<RequestFrame, { type: T }> => frame.type === type,
  );
}

describe('§4.1 registration list', () => {
  test('a unit registers once, travels while it changed, and is referenced by digest after', async () => {
    const { client, last, round, ids } = await scripted();
    const id = client.subscribe(P1);
    expect(id).toBe(unitId(P1));
    expect(client.subscribe({ project_id: 'p1' })).toBe(id);
    await round(
      ...bootstrap(P1, 5, [
        rows('notes', ['n1', 'p1', 'o1', 'b']),
        rows('tasks', ['t1', 'p1', 'a']),
      ]),
      ...live(5),
    );
    const first = last();
    const pull = framesOf(first, 'PULL_HEADER')[0]!;
    expect(pull.cursor).toBe(-1);
    expect(pull.registrationDigest).toEqual(registrationDigest([P1]));
    expect(pull.echoDigest).toEqual(new Uint8Array());
    expect(framesOf(first, 'UNIT')).toEqual([{ type: 'UNIT', scopes: P1 }]);
    expect(framesOf(first, 'PROGRESS')).toEqual([
      { type: 'PROGRESS', id, cursor: -1 },
    ]);
    expect(framesOf(first, 'REQ_HEADER')[0]!.outboxId).toMatch(
      /^[0-9a-f-]{36}$/,
    );
    // One unit covers both tables declaring its variable (§4.1).
    expect(ids('tasks')).toEqual(['t1']);
    expect(ids('notes')).toEqual(['n1']);
    expect(client.unit(id)?.cursor).toBeUndefined();
    expect(client.unitCatchup(id)).toEqual({
      state: 'known',
      id,
      status: 'active',
      live: true,
      cursor: 5,
      hasResumeToken: false,
      bootstrapComplete: true,
      knownPendingPages: false,
    });

    await round(...live(5));
    const quiet = last();
    expect(framesOf(quiet, 'UNIT')).toEqual([]);
    expect(framesOf(quiet, 'PROGRESS')).toEqual([]);
    expect(framesOf(quiet, 'PULL_HEADER')[0]!.cursor).toBe(5);
    expect(framesOf(quiet, 'PULL_HEADER')[0]!.echoDigest).toEqual(ECHO);

    const second = client.subscribe(P2);
    await round(
      ...bootstrap(P2, 6, [rows('notes'), rows('tasks')]),
      ...live(6),
    );
    expect(framesOf(last(), 'UNIT').map((frame) => frame.scopes)).toEqual([
      P1,
      P2,
    ]);
    expect(framesOf(last(), 'PROGRESS')).toEqual([
      { type: 'PROGRESS', id: second, cursor: -1 },
    ]);
  });

  test('`unregistered` keeps every cursor and sends the list in the next round at once', async () => {
    const { client, last, round } = await scripted();
    client.subscribe(P1);
    await round(
      ...bootstrap(P1, 3, [rows('notes'), rows('tasks')]),
      ...live(3),
    );
    await round(...live(3));
    expect(framesOf(last(), 'UNIT')).toHaveLength(0);
    await round(
      { type: 'LIVE_START', status: 'unregistered', reasonCode: '' },
      { type: 'LIVE_END', throughSeq: -1, echoDigest: new Uint8Array() },
    );
    expect(client.statusSnapshot().syncNeeded).toBe(true);
    expect(client.diagnosticsSnapshot().replicaCursor).toBe(3);
    await round(...live(3));
    expect(framesOf(last(), 'UNIT')).toEqual([{ type: 'UNIT', scopes: P1 }]);
    expect(framesOf(last(), 'PULL_HEADER')[0]!.cursor).toBe(3);
  });

  test('a scope map without a value, with a wildcard, or covering no table is refused', async () => {
    const { client } = await scripted();
    for (const scopes of [{}, { project_id: '*' }, { tenant_id: 't1' }])
      expect(() => client.subscribe(scopes)).toThrow(
        expect.objectContaining({ code: 'sync.invalid_subscription' }),
      );
    expect(client.units()).toEqual([]);
  });
});

describe('§4.5 replica cursor and live section', () => {
  test('join rule J: a cut section keeps a post-bootstrap unit catching up until T reaches R', async () => {
    const { client, last, round } = await scripted();
    const a = client.subscribe(P1);
    await round(
      ...bootstrap(P1, 10, [rows('notes'), rows('tasks')]),
      ...live(10),
    );
    const b = client.subscribe(P2);
    // B completes at pin 4; the section is cut at T = 7, below R = 10.
    await round(
      ...bootstrap(P2, 4, [rows('notes'), rows('tasks')]),
      ...live(7),
    );
    expect(client.unit(b)?.cursor).toBe(7);
    expect(client.unit(a)?.cursor).toBeUndefined();
    expect(client.diagnosticsSnapshot().replicaCursor).toBe(10);
    expect(client.statusSnapshot().syncNeeded).toBe(true);
    await round(...live(12));
    expect(framesOf(last(), 'PROGRESS')).toEqual([
      { type: 'PROGRESS', id: b, cursor: 7 },
    ]);
    expect(client.unit(b)?.cursor).toBeUndefined();
    expect(client.diagnosticsSnapshot().replicaCursor).toBe(12);
  });

  test('the client applies only changes matching a live or post-bootstrap unit', async () => {
    const { client, round, ids } = await scripted();
    client.subscribe(P1);
    await round(
      ...bootstrap(P1, 2, [rows('notes'), rows('tasks')]),
      ...live(2),
    );
    const p2 = client.subscribe(P2);
    // P2 is still bootstrapping: its section carries a resume token.
    await round(
      start(p2, { bootstrap: true }),
      rows('notes'),
      { type: 'SUB_END', nextCursor: 5, bootstrapState: '{"t":1}' },
      ...live(
        5,
        commit(
          3,
          change('tasks', 'upsert', ['t1', 'p1', 'a']),
          change('tasks', 'upsert', ['t2', 'p2', 'b']),
          change('tasks', 'upsert', ['t3', 'p3', 'c']),
        ),
      ),
    );
    expect(ids('tasks')).toEqual(['t1']);
    expect(client.unit(p2)).toMatchObject({ cursor: 5, seeded: ['notes'] });
  });

  test('§4.6 replica reset: live units bootstrap again, post-bootstrap units keep their cursor', async () => {
    const { client, round, ids } = await scripted();
    const a = client.subscribe(P1);
    await round(
      ...bootstrap(P1, 10, [rows('notes'), rows('tasks', ['t1', 'p1', 'a'])]),
      ...live(10),
    );
    const b = client.subscribe(P2);
    await round(
      ...bootstrap(P2, 4, [rows('notes'), rows('tasks')]),
      ...live(7),
    );
    const summary = await round(
      {
        type: 'LIVE_START',
        status: 'reset',
        reasonCode: 'sync.cursor_expired',
      },
      { type: 'LIVE_END', throughSeq: -1, echoDigest: ECHO },
    );
    expect(summary.resets).toEqual([a]);
    expect(client.unit(a)).toMatchObject({
      cursor: -1,
      reasonCode: 'sync.cursor_expired',
    });
    expect(client.unit(b)?.cursor).toBe(7);
    expect(client.diagnosticsSnapshot()).toMatchObject({
      replicaCursor: -1,
      units: { reset: 1, complete: 1 },
    });
    // A reset is staleness, never a purge.
    expect(ids('tasks')).toEqual(['t1']);
  });
});

describe('§3.3 revocation, purge and row ownership', () => {
  test('a revoked unit purges its echo scopes except rows another unit owns, then re-arms', async () => {
    const { client, last, round, ids } = await scripted();
    const org = { org_id: 'o1' };
    const a = client.subscribe(P1);
    const b = client.subscribe(org);
    await round(
      ...bootstrap(P1, 3, [
        rows('notes', ['n1', 'p1', 'o1', 'x'], ['n2', 'p1', 'o2', 'y']),
        rows('tasks', ['t1', 'p1', 'a']),
      ]),
      ...bootstrap(org, 3, [rows('notes', ['n1', 'p1', 'o1', 'x'])]),
      ...live(3),
    );
    expect(ids('notes')).toEqual(['n1', 'n2']);
    const summary = await round(
      start(a, { status: 'revoked' }),
      { type: 'SUB_END', nextCursor: 3 },
      ...live(3),
    );
    expect(summary.revoked).toEqual([a]);
    // n1 lies in the org unit's scope too: that unit owns it.
    expect(ids('notes')).toEqual(['n1']);
    expect(ids('tasks')).toEqual([]);
    expect(client.unit(a)?.status).toBe('revoked');
    await round(...live(3));
    expect(framesOf(last(), 'UNIT').map((frame) => frame.scopes)).toEqual([
      org,
    ]);
    client.subscribe(P1);
    expect(client.unit(a)).toMatchObject({ status: 'active', cursor: -1 });
    expect(client.statusSnapshot().syncNeeded).toBe(true);
    void b;
  });

  test('a revoked fenced record purges that table only; turning active again re-bootstraps the unit', async () => {
    const { client, round, ids } = await scripted();
    const a = client.subscribe(P1);
    const fenced: FencedRecord[] = [
      { table: 'notes', status: 'active', scopes: { org_id: ['o1'] } },
    ];
    await round(
      ...bootstrap(
        P1,
        3,
        [
          rows('notes', ['n1', 'p1', 'o1', 'x']),
          rows('tasks', ['t1', 'p1', 'a']),
        ],
        fenced,
      ),
      ...live(3),
    );
    await round(
      start(a, {
        fenced: [{ table: 'notes', status: 'revoked', scopes: {} }],
      }),
      { type: 'SUB_END', nextCursor: 3 },
      ...live(3),
    );
    expect(ids('notes')).toEqual([]);
    expect(ids('tasks')).toEqual(['t1']);
    expect(client.unit(a)?.status).toBe('active');
    await round(
      start(a, { fenced }),
      { type: 'SUB_END', nextCursor: 3 },
      ...live(3),
    );
    expect(client.unit(a)).toMatchObject({ cursor: -1, seeded: [] });
  });

  test('§5.6 the first page clears the pair scope except rows an owner holds', async () => {
    const { client, round, ids, db } = await scripted();
    const org = { org_id: 'o1' };
    client.subscribe(org);
    await round(
      ...bootstrap(org, 2, [rows('notes', ['n1', 'p1', 'o1', 'x'])]),
      ...live(2),
    );
    db.exec(
      "INSERT INTO notes(id,project_id,org_id,body,_sync_version) VALUES('stale','p1','o2','s',1)",
    );
    client.subscribe(P1);
    await round(
      ...bootstrap(P1, 4, [rows('notes'), rows('tasks')]),
      ...live(4),
    );
    expect(ids('notes')).toEqual(['n1']);
  });
});

describe('§5.6 fail closed at the first-page clear', () => {
  test('a fenced variable without a local mapping fails the unit and keeps its rows; the response still applies', async () => {
    const { client, round, ids, db } = await scripted();
    const a = client.subscribe(P1);
    const org = client.subscribe({ org_id: 'o1' });
    db.exec(
      "INSERT INTO tasks(id,project_id,title,_sync_version) VALUES('t0','p1','kept',1)",
    );
    const summary = await round(
      ...bootstrap(
        P1,
        3,
        [rows('tasks', ['t1', 'p1', 'a'])],
        [{ table: 'tasks', status: 'active', scopes: { region_id: ['r1'] } }],
      ),
      ...bootstrap({ org_id: 'o1' }, 3, [
        rows('notes', ['n1', 'p9', 'o1', 'x']),
      ]),
      ...live(3),
    );
    expect(summary.failed).toEqual([a]);
    expect(client.unit(a)).toMatchObject({
      status: 'failed',
      reasonCode: 'sync.scope_revoked',
      cursor: -1,
    });
    // Precision or nothing: the table is not cleared as an approximation.
    expect(ids('tasks')).toEqual(['t0']);
    expect(ids('notes')).toEqual(['n1']);
    expect(client.unit(org)?.cursor).toBeUndefined();
    // A failed unit is a configuration error: registering it again keeps it.
    client.subscribe(P1);
    expect(client.unit(a)?.status).toBe('failed');
  });
});

describe('§4.5 version guard', () => {
  const tasks = (client: SyncClient) =>
    client.query('SELECT id,project_id,title FROM tasks');

  test('a live delete of the old scope keeps the row another unit already holds at its new scope', async () => {
    const { client, round, ids } = await scripted();
    client.subscribe(P1);
    await round(
      ...bootstrap(P1, 5, [rows('notes'), rows('tasks', ['x', 'p1', 'old'])]),
      ...live(5),
    );
    client.subscribe(P2);
    // Commit 8 moved x from p1 to p2 at version 2 (§2.2). P2's segment (pin
    // 9) holds x at p2, and the live section from R = 5 carries the delete
    // half tagged p1: the upsert half lies at or below P2's pin.
    await round(
      ...bootstrap(P2, 9, [
        rows('notes'),
        rowsAt('tasks', 2, ['x', 'p2', 'moved']),
      ]),
      ...live(9, commit(8, change('tasks', 'delete', ['x', 'p1', 'old'], 2))),
    );
    expect(tasks(client)).toEqual([
      { id: 'x', project_id: 'p2', title: 'moved' },
    ]);
    // A delete above the row's version applies.
    await round(
      ...live(10, commit(10, change('tasks', 'delete', ['x', 'p2', ''], 3))),
    );
    expect(ids('tasks')).toEqual([]);
  });

  test('a move pair keeps the upsert in either change order', async () => {
    const { client, round } = await scripted();
    client.subscribe(P1);
    client.subscribe(P2);
    await round(
      ...bootstrap(P1, 3, [rows('notes'), rows('tasks', ['x', 'p1', 'a'])]),
      ...bootstrap(P2, 3, [rows('notes'), rows('tasks')]),
      ...live(
        5,
        commit(
          4,
          change('tasks', 'upsert', ['x', 'p2', 'b'], 2),
          change('tasks', 'delete', ['x', 'p1', 'a'], 2),
        ),
        commit(
          5,
          change('tasks', 'delete', ['x', 'p2', 'b'], 3),
          change('tasks', 'upsert', ['x', 'p1', 'c'], 3),
        ),
      ),
    );
    expect(tasks(client)).toEqual([{ id: 'x', project_id: 'p1', title: 'c' }]);
  });

  test("a lagging unit's older segment row, upsert and delete leave the newer row in place", async () => {
    const { client, round } = await scripted();
    client.subscribe(P2);
    // x was created at p1 (commit 4, version 1), moved to p2 (commit 8,
    // version 2) and edited (commit 9, version 3).
    await round(
      ...bootstrap(P2, 9, [
        rows('notes'),
        rowsAt('tasks', 3, ['x', 'p2', 'c']),
      ]),
      ...live(9),
    );
    client.subscribe(P1);
    // P1's bootstrap pinned at 3 and served x from an earlier page; its scan
    // from 3 re-delivers the history tagged p1. Applied unconditionally it
    // would rewind x to p1 and then delete it.
    await round(
      ...bootstrap(P1, 3, [rows('notes'), rows('tasks', ['x', 'p1', 'a'])]),
      ...live(
        9,
        commit(4, change('tasks', 'upsert', ['x', 'p1', 'a'], 1)),
        commit(8, change('tasks', 'delete', ['x', 'p1', 'a'], 2)),
      ),
    );
    expect(tasks(client)).toEqual([{ id: 'x', project_id: 'p2', title: 'c' }]);
  });

  test('an older upsert of a deleted row returns until the same scan removes it again', async () => {
    const { client, round, ids } = await scripted();
    const org = { org_id: 'o1' };
    client.subscribe(P1);
    await round(
      ...bootstrap(P1, 5, [
        rows('notes', ['n', 'p1', 'o1', 'a']),
        rows('tasks'),
      ]),
      ...live(
        6,
        commit(6, change('notes', 'delete', ['n', 'p1', 'o1', 'a'], 2)),
      ),
    );
    expect(ids('notes')).toEqual([]);
    // The org unit's scan starts at its pin 3 and is cut at 4: it re-delivers
    // the insert the replica already saw deleted.
    client.subscribe(org);
    await round(
      ...bootstrap(org, 3, [rows('notes')]),
      ...live(
        4,
        commit(4, change('notes', 'upsert', ['n', 'p1', 'o1', 'a'], 1)),
      ),
    );
    expect(ids('notes')).toEqual(['n']);
    await round(
      { type: 'LIVE_START', status: 'active', reasonCode: '' },
      commit(6, change('notes', 'delete', ['n', 'p1', 'o1', 'a'], 2)),
      { type: 'LIVE_END', throughSeq: 6, echoDigest: ECHO },
    );
    expect(ids('notes')).toEqual([]);
  });

  test('a skipped change leaves the optimistic overlay and its rollback base intact', async () => {
    const { client, round, delta } = await scripted();
    client.subscribe(P1);
    await round(
      ...bootstrap(P1, 3, [
        rows('notes'),
        rowsAt('tasks', 3, ['x', 'p1', 'base']),
      ]),
      ...live(3),
    );
    await client.connectRealtime();
    const pending = client.mutate([
      {
        table: 'tasks',
        op: 'upsert',
        values: { id: 'x', project_id: 'p1', title: 'mine' },
      },
    ]);
    // An older version arrives while the commit is pending: the overlay and
    // the before-image the rollback restores stay as they were.
    await delta(
      live(4, commit(4, change('tasks', 'upsert', ['x', 'p1', 'stale'], 2))),
    );
    expect(tasks(client)).toEqual([
      { id: 'x', project_id: 'p1', title: 'mine' },
    ]);
    client.disconnectRealtime();
    await round(
      {
        type: 'PUSH_RESULT',
        clientCommitId: pending,
        status: 'rejected',
        results: [
          {
            opIndex: 0,
            status: 'error',
            code: 'app.refused',
            message: 'refused',
            retryable: false,
          },
        ],
      },
      ...live(4),
    );
    expect(tasks(client)).toEqual([
      { id: 'x', project_id: 'p1', title: 'base' },
    ]);
  });
});

describe('§4.8 windows as sets of units', () => {
  test('a window and an explicit subscribe share one unit; the last release evicts it', async () => {
    const { client, last, round, ids } = await scripted();
    const base = { variable: 'project_id' };
    await client.setWindow(base, ['p1', 'p2']);
    expect(client.units().map((unit) => unit.id)).toEqual([
      unitId(P1),
      unitId(P2),
    ]);
    expect(client.windowState(base)).toEqual({
      units: ['p1', 'p2'],
      pending: ['p1', 'p2'],
    });
    await round(
      ...bootstrap(P1, 3, [rows('notes'), rows('tasks', ['t1', 'p1', 'a'])]),
      ...bootstrap(P2, 3, [rows('notes'), rows('tasks', ['t2', 'p2', 'b'])]),
      ...live(3),
    );
    expect(client.windowState(base).pending).toEqual([]);
    client.subscribe(P1);
    await client.setWindow(base, []);
    // P1 stays: the explicit reference holds it. P2 left and was evicted.
    expect(client.units().map((unit) => unit.id)).toEqual([unitId(P1)]);
    expect(ids('tasks')).toEqual(['t1']);
    await round(...live(3));
    expect(framesOf(last(), 'UNIT').map((frame) => frame.scopes)).toEqual([P1]);
    // Releasing the explicit reference unregisters without evicting.
    client.unsubscribe(unitId(P1));
    expect(client.units()).toEqual([]);
    expect(ids('tasks')).toEqual(['t1']);
  });

  test('a widen that fails at one value keeps the values before it; the same call converges', async () => {
    const db = new BunClientDatabase();
    const { client } = await scripted(db);
    const base = { variable: 'project_id' };
    const values = ['p1', 'p2', 'p3', 'p4'];
    db.exec(
      "CREATE TRIGGER fail_p3 BEFORE INSERT ON _syncular_windows WHEN new.unit='p3' BEGIN SELECT RAISE(ABORT,'widen failed'); END",
    );
    await expect(client.setWindow(base, values)).rejects.toThrow(
      'widen failed',
    );
    expect(client.windowState(base).units).toEqual(['p1', 'p2']);
    expect(client.units().map((unit) => unit.scopes.project_id)).toEqual([
      'p1',
      'p2',
    ]);
    db.exec('DROP TRIGGER fail_p3');
    await client.setWindow(base, values);
    expect(client.windowState(base).units).toEqual(values);
    expect(
      client
        .units()
        .map((unit) => unit.scopes.project_id)
        .sort(),
    ).toEqual(values);
  });

  test('E1: a pinned row survives the eviction and leaves when its commit drains', async () => {
    const { client, round, ids } = await scripted();
    const base = { variable: 'project_id' };
    await client.setWindow(base, ['p1']);
    await round(
      ...bootstrap(P1, 3, [
        rows('notes'),
        rows('tasks', ['t1', 'p1', 'a'], ['t2', 'p1', 'b']),
      ]),
      ...live(3),
    );
    const pending = client.mutate([
      {
        table: 'tasks',
        op: 'upsert',
        values: { id: 't1', project_id: 'p1', title: 'mine' },
      },
    ]);
    await client.setWindow(base, []);
    expect(ids('tasks')).toEqual(['t1']);
    await round(
      {
        type: 'PUSH_RESULT',
        clientCommitId: pending,
        status: 'applied',
        commitSeq: 4,
        results: [{ opIndex: 0, status: 'applied' }],
      },
      { type: 'LIVE_START', status: 'active', reasonCode: '' },
      { type: 'LIVE_END', throughSeq: -1, echoDigest: new Uint8Array() },
    );
    expect(ids('tasks')).toEqual([]);
  });

  for (const preflight of [false, true])
    test(`a restart drains an interrupted eviction before any read, transport closed (preflight ${preflight})`, async () => {
      const db = new BunClientDatabase();
      const { client, round, ids } = await scripted(db);
      const base = { variable: 'project_id' };
      await client.setWindow(base, ['p1', 'p2']);
      await round(
        ...bootstrap(P1, 3, [rows('notes'), rows('tasks', ['t1', 'p1', 'a'])]),
        ...bootstrap(P2, 3, [rows('notes'), rows('tasks', ['t2', 'p2', 'b'])]),
        ...live(3),
      );
      expect(ids('tasks')).toEqual(['t1', 't2']);
      // The durable state a crash leaves after the release of p2 committed its
      // first eviction chunk: the unit and its window value are gone, the
      // remaining rows wait in the pending-eviction registry.
      db.exec(`DELETE FROM ${WINDOWS_TABLE} WHERE unit=?`, ['p2']);
      deleteUnit(db, unitId(P2));
      savePendingEviction(db, {
        unitId: unitId(P2),
        table: 'tasks',
        effective: { project_id: ['p2'] },
      });
      const reopened = new SyncClient({
        database: db,
        schema: SCHEMA,
        clientId: 'units-client',
        transport: async () => {
          throw new Error('the transport stays closed');
        },
        transportEnabled: false,
        securityPreflight: preflight,
      });
      await reopened.start();
      if (preflight) {
        expect(db.query('SELECT id FROM tasks ORDER BY id')).toHaveLength(2);
        await reopened.activateSecurity();
      }
      expect(
        reopened.query('SELECT id FROM tasks ORDER BY id').map((row) => row.id),
      ).toEqual(['t1']);
      expect(db.query('SELECT 1 FROM _syncular_pending_evictions')).toEqual([]);
    });

  test('a deferred eviction chunk keeps the pages a bootstrapping unit already applied', async () => {
    const { client, round, ids } = await scripted();
    const base = { variable: 'project_id' };
    const org = { org_id: 'o1' };
    await client.setWindow(base, ['p1']);
    await round(
      ...bootstrap(P1, 3, [
        rows('notes', ['n1', 'p1', 'o1', 'a']),
        rows('tasks'),
      ]),
      ...live(3),
    );
    const pending = client.mutate([
      {
        table: 'notes',
        op: 'upsert',
        values: { id: 'n1', project_id: 'p1', org_id: 'o1', body: 'mine' },
      },
    ]);
    // n1 is pinned, so the eviction of p1 stays pending.
    await client.setWindow(base, []);
    expect(ids('notes')).toEqual(['n1']);
    client.subscribe(org);
    // The push drains n1's pin in the same round in which the org unit's
    // first page delivers n1 and n2; its bootstrap is not complete yet.
    await round(
      {
        type: 'PUSH_RESULT',
        clientCommitId: pending,
        status: 'applied',
        commitSeq: 4,
        results: [{ opIndex: 0, status: 'applied' }],
      },
      start(unitId(org), { bootstrap: true }),
      rowsAt('notes', 2, ['n1', 'p1', 'o1', 'mine'], ['n2', 'p1', 'o1', 'b']),
      {
        type: 'SUB_END',
        nextCursor: 4,
        bootstrapState: '{"tableIndex":0,"rowCursor":"n2"}',
      },
      ...live(4),
    );
    expect(ids('notes')).toEqual(['n1', 'n2']);
  });
});

describe('§6.3.2 push sequence', () => {
  test('commits carry the outbox sequence; `sync.commit_expired` is a rejection', async () => {
    const { client, last, round } = await scripted();
    const first = client.mutate([
      {
        table: 'tasks',
        op: 'upsert',
        values: { id: 't1', project_id: 'p1', title: 'a' },
      },
    ]);
    const second = client.mutate([
      {
        table: 'tasks',
        op: 'upsert',
        values: { id: 't2', project_id: 'p1', title: 'b' },
      },
    ]);
    const summary = await round(
      {
        type: 'PUSH_RESULT',
        clientCommitId: first,
        status: 'rejected',
        results: [
          {
            opIndex: 0,
            status: 'error',
            code: 'sync.commit_expired',
            message: 'commit expired',
            retryable: false,
          },
        ],
      },
      {
        type: 'PUSH_RESULT',
        clientCommitId: second,
        status: 'applied',
        commitSeq: 1,
        results: [{ opIndex: 0, status: 'applied' }],
      },
      ...live(1),
    );
    const pushes = framesOf(last(), 'PUSH_COMMIT');
    expect(pushes.map((frame) => frame.clientSeq)).toEqual([1, 2]);
    expect(summary.rejected).toEqual([first]);
    expect(client.pendingCommits()).toEqual([]);
    expect(client.commitOutcome(first)?.status).toBe('rejected');
    expect(client.query('SELECT id FROM tasks ORDER BY id')).toEqual([
      { id: 't2' },
    ]);
  });
});

describe('§8.2 deltas', () => {
  test('a delta applies like a live section, advances the replica cursor and acks it', async () => {
    const { client, round, ids, delta, acks } = await scripted();
    client.subscribe(P1);
    await round(
      ...bootstrap(P1, 3, [rows('notes'), rows('tasks')]),
      ...live(3),
    );
    await client.connectRealtime();
    await delta(
      live(4, commit(4, change('tasks', 'upsert', ['t1', 'p1', 'a']))),
    );
    expect(ids('tasks')).toEqual(['t1']);
    expect(client.diagnosticsSnapshot().replicaCursor).toBe(4);
    expect(acks).toEqual([4]);
    // A duplicate at or below the replica cursor is skipped, not a drop.
    await delta(
      live(4, commit(4, change('tasks', 'delete', ['t1', 'p1', '']))),
    );
    expect(ids('tasks')).toEqual(['t1']);
    expect(client.statusSnapshot().syncNeeded).toBe(false);
  });

  test('a delta whose RESP_HEADER carries a schema floor records it and applies nothing', async () => {
    const { client, round, delta, acks } = await scripted();
    client.subscribe(P1);
    await round(
      ...bootstrap(P1, 3, [rows('notes'), rows('tasks')]),
      ...live(3),
    );
    await client.connectRealtime();
    // RESP_HEADER {required 3, latest 3, logEpoch e1}, LIVE_START active,
    // LIVE_END throughSeq 4; the Rust client test applies the same bytes.
    await delta(
      Uint8Array.fromHex(
        '5353503204000200101100000001030000000103000000020000006531001c0500000001000000001d0c0000000400000000000000000000000000000000',
      ),
    );
    expect(client.statusSnapshot()).toMatchObject({
      schemaFloor: { requiredSchemaVersion: 3, latestSchemaVersion: 3 },
      syncNeeded: false,
    });
    expect(client.diagnosticsSnapshot().replicaCursor).toBe(3);
    expect(acks).toEqual([]);
  });

  test('a delta while no unit is live is a drop', async () => {
    const { client, delta, ids } = await scripted();
    client.subscribe(P1);
    await client.connectRealtime();
    await client.sync().catch(() => {});
    await delta(
      live(4, commit(4, change('tasks', 'upsert', ['t1', 'p1', 'a']))),
    );
    expect(ids('tasks')).toEqual([]);
    expect(client.statusSnapshot().syncNeeded).toBe(true);
  });
});

describe('§7.6 diagnostics', () => {
  test('a snapshot runs seven statements, as before wire version 4', async () => {
    let statements = 0;
    class Counting extends BunClientDatabase {
      override query(sql: string, params?: readonly SqlValue[]): SqlRow[] {
        statements += 1;
        return super.query(sql, params);
      }
    }
    const { client } = await scripted(new Counting());
    client.subscribe(P1);
    statements = 0;
    client.diagnosticsSnapshot();
    // Units, local revision, outbox count, replica cursor, two page
    // pragmas and one storage aggregate.
    expect(statements).toBe(7);
  });

  test('units appear as counts and reason codes, never ids', async () => {
    const { client, round } = await scripted();
    client.subscribe(P1);
    client.subscribe(P2);
    await round(
      ...bootstrap(P1, 3, [rows('notes'), rows('tasks')]),
      start(unitId(P2), { status: 'revoked' }),
      { type: 'SUB_END', nextCursor: -1 },
      ...live(3),
    );
    const snapshot = client.diagnosticsSnapshot();
    expect(snapshot.version).toBe(2);
    expect(snapshot.units).toEqual({
      bootstrapping: 0,
      complete: 1,
      reset: 0,
      revoked: 1,
      failed: 0,
      reasonCodes: ['sync.scope_revoked'],
    });
    expect(snapshot.activeUnits).toBe(1);
    expect(snapshot.replicaCursor).toBe(3);
    expect(JSON.stringify(snapshot)).not.toContain(unitId(P1));
  });
});

describe('§9 upgrade of a version 3 replica', () => {
  function legacyReplica(evictionScopes = '{"project_id":["p9"]}') {
    const db = new BunClientDatabase();
    // The 0.59.0 bookkeeping DDL that matters to the upgrade.
    db.exec(
      'CREATE TABLE _syncular_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)',
    );
    db.exec(
      'CREATE TABLE _syncular_outbox(seq INTEGER PRIMARY KEY AUTOINCREMENT,client_commit_id TEXT NOT NULL UNIQUE,created_at_ms INTEGER NOT NULL,operations TEXT NOT NULL)',
    );
    db.exec(
      "CREATE TABLE _syncular_subscriptions(id TEXT PRIMARY KEY,tbl TEXT NOT NULL,requested_scopes TEXT NOT NULL,params TEXT,cursor INTEGER NOT NULL DEFAULT -1,bootstrap_state TEXT,effective_scopes TEXT,status TEXT NOT NULL DEFAULT 'active',reason_code TEXT)",
    );
    db.exec(
      'CREATE TABLE _syncular_windows(base TEXT NOT NULL,unit TEXT NOT NULL,sub_id TEXT NOT NULL,PRIMARY KEY(base,unit))',
    );
    db.exec(
      'CREATE TABLE _syncular_window_pending_evict(sub_id TEXT PRIMARY KEY,tbl TEXT NOT NULL,effective_scopes TEXT NOT NULL)',
    );
    db.exec(
      'CREATE TABLE _syncular_outbox_before_images(client_commit_id TEXT NOT NULL,op_index INTEGER NOT NULL,existed INTEGER NOT NULL,sync_version INTEGER,values_json TEXT,delivery_seq INTEGER,tbl TEXT,row_id TEXT,PRIMARY KEY(client_commit_id,op_index))',
    );
    db.exec(
      'CREATE TABLE tasks(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,title TEXT NOT NULL,_sync_version INTEGER)',
    );
    db.exec(
      "INSERT INTO _syncular_meta VALUES('clientId','units-client'),('schemaVersion','1'),('logEpoch','e1')",
    );
    db.exec(
      'INSERT INTO _syncular_subscriptions VALUES(\'s1\',\'tasks\',\'{"project_id":["p1","p2"]}\',\'{}\',42,NULL,\'{"project_id":["p1","p2"]}\',\'active\',NULL)',
    );
    db.exec('INSERT INTO _syncular_windows VALUES(?,?,?)', [
      'tasks\0project_id\0{}',
      'p9',
      'w:tasks:1',
    ]);
    db.exec(
      `INSERT INTO _syncular_window_pending_evict VALUES('w:tasks:1','tasks','${evictionScopes}')`,
    );
    db.exec(
      "INSERT INTO tasks VALUES('t1','p1','kept',3),('t9','p9','pinned',1)",
    );
    db.exec(
      `INSERT INTO _syncular_outbox(client_commit_id,created_at_ms,operations) VALUES('c1',1,'${JSON.stringify([{ table: 'tasks', rowId: 't9', op: 'upsert', values: { id: 't9', project_id: 'p9', title: 'pinned' } }])}')`,
    );
    db.exec(
      `INSERT INTO _syncular_outbox_before_images VALUES('c1',0,1,1,'${JSON.stringify({ id: 't9', project_id: 'p9', title: 'pinned' })}',NULL,'tasks','t9')`,
    );
    return db;
  }

  test('the replica keeps outbox and rows, drops its subscriptions and registers units fresh', async () => {
    const db = legacyReplica();
    const { client, last, round } = await scripted(db);
    expect(
      client.pendingCommits().map((commit) => commit.clientCommitId),
    ).toEqual(['c1']);
    expect(client.query('SELECT id FROM tasks ORDER BY id')).toEqual([
      { id: 't1' },
      { id: 't9' },
    ]);
    expect(client.units()).toEqual([]);
    expect(
      db
        .query(
          "SELECT name FROM sqlite_master WHERE name LIKE '_syncular_%' ORDER BY name",
        )
        .map((row) => row.name),
    ).not.toContain('_syncular_subscriptions');
    expect(
      db.query('SELECT unit_id,tbl FROM _syncular_pending_evictions'),
    ).toEqual([{ unit_id: 'w:tasks:1', tbl: 'tasks' }]);
    expect(db.query('SELECT * FROM _syncular_windows')).toEqual([]);
    client.subscribe(P1);
    await round(
      {
        type: 'PUSH_RESULT',
        clientCommitId: 'c1',
        status: 'applied',
        commitSeq: 50,
        results: [{ opIndex: 0, status: 'applied' }],
      },
      ...bootstrap(P1, 50, [
        rows('notes'),
        rows('tasks', ['t1', 'p1', 'fresh']),
      ]),
      ...live(50),
    );
    const request = last();
    expect(framesOf(request, 'REQ_HEADER')[0]!.outboxId).toBeDefined();
    expect(framesOf(request, 'PUSH_COMMIT')[0]!.clientSeq).toBe(1);
    expect(framesOf(request, 'PULL_HEADER')[0]!.cursor).toBe(-1);
    expect(framesOf(request, 'UNIT')).toEqual([{ type: 'UNIT', scopes: P1 }]);
    // The carried eviction finished once the pinning commit drained.
    expect(client.query('SELECT id,title FROM tasks ORDER BY id')).toEqual([
      { id: 't1', title: 'fresh' },
    ]);
  });

  test('a version 3 pending eviction that cannot be carried fails loudly before any write', async () => {
    const db = legacyReplica('not json');
    const client = new SyncClient({
      database: db,
      schema: SCHEMA,
      transport: async () => new Uint8Array(),
    });
    await expect(client.start()).rejects.toMatchObject({
      code: 'sync.local_corrupt',
    });
    expect(
      db.query(
        "SELECT 1 FROM sqlite_master WHERE name='_syncular_subscriptions'",
      ),
    ).toHaveLength(1);
  });
});
