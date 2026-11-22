import { expect, test } from 'bun:test';
import { decodeMessage } from '@syncular/core';
import type { ServerSchema } from '@syncular/server';
import { BunClientDatabase } from '../src/bun-database';
import { defineOutboxControl } from '../src/outbox-control';
import {
  ensureFailedOverlaySchema,
  RETAINED_ROWS,
} from '../src/failed-overlay';
import { makeClient, makeServer, type TestServer } from './helpers';

const SCHEMA = {
  version: 1,
  tables: [
    {
      name: 'slots',
      primaryKey: 'id',
      scopes: ['room:{room_id}'],
      indexes: [
        { name: 'room_number', columns: ['room_id', 'number'], unique: true },
      ],
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'room_id', type: 'string', nullable: false },
        { name: 'number', type: 'integer', nullable: false },
      ],
    },
    {
      name: 'sealed',
      primaryKey: 'id',
      scopes: ['room:{room_id}'],
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'room_id', type: 'string', nullable: false },
      ],
    },
  ],
} as const satisfies ServerSchema;

const pushed = (requests: readonly Uint8Array[]) =>
  requests.flatMap((bytes) => {
    const message = decodeMessage(bytes);
    return message.msgKind === 'request'
      ? message.frames.flatMap((frame) =>
          frame.type === 'PUSH_COMMIT' ? [frame.clientCommitId] : [],
        )
      : [];
  });

async function peer(
  server: TestServer,
  clientId: string,
  database?: BunClientDatabase,
) {
  const handle = await makeClient(server, {
    clientId,
    schema: SCHEMA,
    retainFailedCommits: true,
    outboxControl: defineOutboxControl(),
    ...(database ? { database } : {}),
  });
  handle.client.subscribe({ room_id: 'room' });
  await handle.client.syncUntilIdle();
  return handle;
}

const slot = (id: string) => ({
  op: 'upsert' as const,
  table: 'slots',
  values: { id, room_id: 'room', number: 2 },
});
const seal = {
  op: 'upsert' as const,
  table: 'sealed',
  values: { id: 'seal', room_id: 'room' },
};

for (const order of ['ordinary-first', 'seal-first'] as const)
  test(`a pull accepts a unique-key winner over a pending insert, ${order} (§7.2)`, async () => {
    const server = makeServer(SCHEMA);
    server.allowed['actor-1'] = { room_id: ['room'] };
    const a = await peer(server, `a-${order}`);
    const b = await peer(server, `b-${order}`);
    try {
      a.client.setTransportGate('pull');
      const ids =
        order === 'ordinary-first'
          ? [a.client.mutate([slot('mine')]), a.client.mutate([seal])]
          : [a.client.mutate([seal]), a.client.mutate([slot('mine')])];
      const mine = ids[order === 'ordinary-first' ? 0 : 1]!;
      b.client.mutate([slot('theirs')]);
      await b.client.syncUntilIdle();
      a.requests.length = 0;

      await a.client.syncUntilIdle();
      expect(pushed(a.requests)).toEqual([]);
      expect(a.client.query('SELECT id FROM slots')).toEqual([
        { id: 'theirs' },
      ]);
      expect(a.client.pendingCommits().map((c) => c.clientCommitId)).toEqual(
        ids,
      );

      // A bounded push settles the first commit alone; the gate returns to pull.
      a.client.setTransportGate({ through: ids[0]! });
      await a.client.syncUntilIdle();
      expect(pushed(a.requests)).toEqual([ids[0]!]);
      expect(a.client.transportGate()).toBe('pull');
      expect(a.client.pendingCommits().map((c) => c.clientCommitId)).toEqual([
        ids[1]!,
      ]);

      a.client.setTransportGate('open');
      await a.client.syncUntilIdle();
      expect(pushed(a.requests)).toEqual(ids);
      expect(a.client.pendingCommits()).toEqual([]);
      const outcome = a.client.commitDelivery(mine);
      expect(outcome.status === 'known' && outcome.outcome.status).toBe(
        'rejected',
      );
      // The retained loser names the winner that already held its key.
      expect(
        outcome.status === 'known' &&
          outcome.outcome.retainedRows?.[0]?.uniqueConflicts?.map(
            (conflict) => conflict.rowId,
          ),
      ).toEqual(['theirs']);
      expect(a.client.query('SELECT id FROM slots')).toEqual([
        { id: 'theirs' },
      ]);
      expect(a.client.query('SELECT id FROM sealed')).toEqual([{ id: 'seal' }]);
    } finally {
      await a.client.close();
      await b.client.close();
    }
  });

for (const inline of [true, false])
  test(`a bootstrap ${inline ? 'rows segment' : 'segment download'} accepts a unique-key winner over a pending insert (§7.2)`, async () => {
    const server = makeServer(SCHEMA);
    server.allowed['actor-1'] = { room_id: ['room'] };
    if (!inline) server.limits.inlineSegmentMaxBytes = 0;
    const b = await peer(server, `b-boot-${inline}`);
    const a = await makeClient(server, {
      clientId: `a-boot-${inline}`,
      schema: SCHEMA,
      retainFailedCommits: true,
    });
    try {
      b.client.mutate([slot('theirs')]);
      await b.client.syncUntilIdle();
      a.client.setTransportGate('pull');
      const mine = a.client.mutate([slot('mine')]);
      a.client.subscribe({ room_id: 'room' });
      await a.client.syncUntilIdle();
      expect(pushed(a.requests)).toEqual([]);
      expect(a.client.query('SELECT id FROM slots')).toEqual([
        { id: 'theirs' },
      ]);
      expect(a.client.pendingCommits().map((c) => c.clientCommitId)).toEqual([
        mine,
      ]);
    } finally {
      await a.client.close();
      await b.client.close();
    }
  });

test('a pull on a unique table with no pending row adds no statement', async () => {
  const server = makeServer(SCHEMA);
  server.allowed['actor-1'] = { room_id: ['room'] };
  let statements = 0;
  const database = new BunClientDatabase();
  const exec = database.exec.bind(database);
  const query = database.query.bind(database);
  database.exec = (sql, params) => {
    statements++;
    exec(sql, params);
  };
  database.query = (sql, params) => {
    statements++;
    return query(sql, params);
  };
  const a = await peer(server, 'a-count', database);
  const b = await peer(server, 'b-count');
  try {
    b.client.mutate([slot('theirs')]);
    await b.client.syncUntilIdle();
    statements = 0;
    await a.client.syncUntilIdle();
    expect(a.client.query('SELECT id FROM slots')).toEqual([{ id: 'theirs' }]);
    // The 0.103.0 count for this pull: the pending-row restore shares the
    // retained-row statement.
    expect(statements).toBe(STATEMENTS_0103);
  } finally {
    await a.client.close();
    await b.client.close();
  }
});

const STATEMENTS_0103 = 59;

for (const path of ['rows', 'image'] as const)
  test(`a later ${path} page accepts a unique-key winner over a pending insert the first page re-admitted (§7.2)`, async () => {
    const server = makeServer(SCHEMA);
    server.allowed['actor-1'] = { room_id: ['room'] };
    if (path === 'image') {
      server.limits.inlineSegmentMaxBytes = 0;
      server.limits.maxImageSegmentBytes = 1;
    }
    const b = await peer(server, `b-page-${path}`);
    // One row per page: the clear on page one removes the pending row, its
    // replay re-admits it, and page two carries the winner of its key.
    const a = await makeClient(server, {
      clientId: `a-page-${path}`,
      schema: SCHEMA,
      retainFailedCommits: true,
      limits: { limitSnapshotRows: 1 },
    });
    try {
      b.client.mutate([
        {
          ...slot('a-other'),
          values: { id: 'a-other', room_id: 'room', number: 1 },
        },
        slot('z-winner'),
      ]);
      await b.client.syncUntilIdle();
      a.client.setTransportGate('pull');
      const mine = a.client.mutate([slot('mine')]);
      a.client.subscribe({ room_id: 'room' });
      await a.client.syncUntilIdle();
      expect(pushed(a.requests)).toEqual([]);
      expect(a.client.query('SELECT id FROM slots ORDER BY id')).toEqual([
        { id: 'a-other' },
        { id: 'z-winner' },
      ]);
      expect(a.client.pendingCommits().map((c) => c.clientCommitId)).toEqual([
        mine,
      ]);
    } finally {
      await a.client.close();
      await b.client.close();
    }
  });

test('a deferred pending insert returns once its unique key is free (§7.2)', async () => {
  const server = makeServer(SCHEMA);
  server.allowed['actor-1'] = { room_id: ['room'] };
  const a = await peer(server, 'a-free');
  const b = await peer(server, 'b-free');
  try {
    a.client.setTransportGate('pull');
    const mine = a.client.mutate([slot('mine')]);
    b.client.mutate([slot('theirs')]);
    await b.client.syncUntilIdle();
    await a.client.syncUntilIdle();
    expect(a.client.query('SELECT id FROM slots')).toEqual([{ id: 'theirs' }]);
    b.client.mutate([{ op: 'delete', table: 'slots', rowId: 'theirs' }]);
    await b.client.syncUntilIdle();
    await a.client.syncUntilIdle();
    expect(a.client.query('SELECT id FROM slots')).toEqual([{ id: 'mine' }]);
    expect(a.client.pendingCommits().map((c) => c.clientCommitId)).toEqual([
      mine,
    ]);
  } finally {
    await a.client.close();
    await b.client.close();
  }
});

test('retained-row columns keep the order the pending-row UNION arm produces', () => {
  // retainedRows() appends pending rows positionally after `rowid AS r,*`.
  // A migration that adds or reorders a column must change that arm too.
  const order = [
    'commit_id',
    'idx',
    'tbl',
    'id',
    'at',
    'op',
    'intent',
    'base',
    'version',
    'unique_conflicts',
    'commit_seq',
  ];
  const fresh = new BunClientDatabase();
  const upgraded = new BunClientDatabase();
  try {
    ensureFailedOverlaySchema(fresh);
    // The table as the first release created it, before both added columns.
    upgraded.exec(
      `CREATE TABLE ${RETAINED_ROWS}(commit_id TEXT NOT NULL,idx INTEGER NOT NULL,tbl TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,op TEXT NOT NULL,intent TEXT,base TEXT,version INTEGER,PRIMARY KEY(commit_id,idx))`,
    );
    ensureFailedOverlaySchema(upgraded);
    for (const db of [fresh, upgraded])
      expect(
        db
          .query(`PRAGMA table_info(${RETAINED_ROWS})`)
          .map((row) => row['name']),
      ).toEqual(order);
  } finally {
    fresh.close();
    upgraded.close();
  }
});
