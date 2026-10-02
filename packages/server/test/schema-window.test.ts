import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { buildSqliteImage } from '@syncular/server/sqlite';
import {
  decodeMessage,
  decodeRow,
  decodeRowsSegment,
  encodeRow,
  encodeSparseRow,
  type RequestFrame,
  type RowColumn,
} from '@syncular/core';
import {
  compileSchema,
  createRealtimeHub,
  handleSyncRequest,
  handleSegmentDownload,
  schemaWindowOf,
  ValidationRejection,
  type ServerSchema,
} from '@syncular/server';
import {
  makeContext,
  pullHeader,
  pushCommit,
  requestBytes,
  section,
  subFrame,
  TASK_COLUMNS,
  TEST_SCHEMA,
  taskRow,
  upsert,
} from './helpers';

const columns: readonly RowColumn[] = [
  ...TASK_COLUMNS,
  { name: 'note', type: 'string', nullable: true },
];
const current: ServerSchema = {
  version: 3,
  tables: [
    { ...TEST_SCHEMA.tables[0]!, columns },
    TEST_SCHEMA.tables[1]!,
    {
      name: 'new_rows',
      columns: [{ name: 'id', type: 'string', nullable: false }],
      primaryKey: 'id',
      scopes: [{ pattern: 'new:{new_id}', column: 'id' }],
    },
  ],
};
const window = [
  compileSchema(current),
  compileSchema({ ...TEST_SCHEMA, version: 2 }),
];

function fixture() {
  const t = makeContext({ schema: current, schemaWindow: window });
  t.scopes.value = { ...t.scopes.value, new_id: ['n1'] };
  const round = async (frames: RequestFrame[], version = 2, client = 'old') => {
    const decoded = decodeMessage(
      await handleSyncRequest(requestBytes(frames, client, version), t.ctx),
    );
    if (decoded.msgKind !== 'response') throw new Error('expected response');
    return decoded;
  };
  return { t, round };
}

test('N-1 pushes use their codec and current validators; added nullable values survive an old patch', async () => {
  const { t, round } = fixture();
  const first = await round([
    pushCommit('insert', [
      upsert('tasks', 't1', taskRow('t1', 'p1', 'old insert')),
    ]),
  ]);
  expect(
    first.frames.find((frame) => frame.type === 'PUSH_RESULT'),
  ).toMatchObject({ status: 'applied' });
  const row = await t.storage.getRow(t.ctx.partition, 'tasks', 't1');
  expect(decodeRow(columns, row!.payload)).toEqual([
    't1',
    'p1',
    'old insert',
    false,
    null,
    null,
    null,
  ]);
  await round(
    [
      pushCommit('current', [
        upsert(
          'tasks',
          't1',
          encodeSparseRow(columns, 0, [
            't1',
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            'kept',
          ]),
          1,
        ),
      ]),
    ],
    3,
    'current',
  );
  await round([
    pushCommit('old-patch', [
      upsert(
        'tasks',
        't1',
        encodeSparseRow(TASK_COLUMNS, 0, [
          't1',
          undefined,
          'old patch',
          undefined,
          undefined,
          undefined,
        ]),
        2,
      ),
    ]),
  ]);
  expect(
    decodeRow(
      columns,
      (await t.storage.getRow(t.ctx.partition, 'tasks', 't1'))!.payload,
    )[6],
  ).toBe('kept');
  t.ctx = {
    ...t.ctx,
    validators: {
      tasks: () => {
        throw new ValidationRejection('host.rule');
      },
    },
  };
  const rejected = await round([
    pushCommit('invalid', [upsert('tasks', 't2', taskRow('t2', 'p1'))]),
  ]);
  expect(
    rejected.frames.find((frame) => frame.type === 'PUSH_RESULT'),
  ).toMatchObject({ status: 'rejected', results: [{ code: 'host.rule' }] });
});

test('bootstrap segments, incremental pulls and realtime deltas omit new columns', async () => {
  const { t, round } = fixture();
  await round(
    [
      pushCommit('seed', [
        upsert(
          'tasks',
          't1',
          encodeSparseRow(columns, 0, [
            't1',
            'p1',
            'one',
            false,
            null,
            null,
            'private-to-new-codec',
          ]),
        ),
      ]),
    ],
    3,
    'current',
  );
  const boot = await round([
    pullHeader({ accept: 0b0010 }),
    subFrame('tasks', 'tasks', { project_id: ['p1'] }, -1),
  ]);
  const ref = boot.frames.find((frame) => frame.type === 'SEGMENT_REF');
  if (ref?.type !== 'SEGMENT_REF') throw new Error('missing segment');
  const downloaded = await handleSegmentDownload(t.ctx, {
    segmentId: ref.segmentId,
    scopesHeader: JSON.stringify({ project_id: ['p1'] }),
  });
  const segment = decodeRowsSegment(downloaded.bytes);
  expect(segment.schemaVersion).toBe(2);
  expect(segment.columns).toEqual(TASK_COLUMNS);
  const increment = await round([
    pullHeader(),
    subFrame('tasks', 'tasks', { project_id: ['p1'] }, 0),
  ]);
  const commit = section(increment, 'tasks').body.find(
    (frame) => frame.type === 'COMMIT',
  );
  if (commit?.type !== 'COMMIT') throw new Error('missing commit');
  const golden = encodeRow(TASK_COLUMNS, [
    't1',
    'p1',
    'one',
    false,
    null,
    null,
  ]);
  expect(commit.changes[0]!.row).toEqual(golden);
  expect(Buffer.from(golden).toString('hex')).toBe(
    '30020000007431020000007031030000006f6e6500',
  );
  const sent: (string | Uint8Array)[] = [];
  const hub = createRealtimeHub(t.ctx);
  const peer = await hub.connect({
    partition: t.ctx.partition,
    actorId: t.ctx.actorId,
    clientId: 'old',
    send: (message) => {
      sent.push(message);
    },
  });
  t.ctx = { ...t.ctx, realtime: hub };
  await round(
    [
      pushCommit('changed', [
        upsert(
          'tasks',
          't1',
          encodeSparseRow(columns, 0, [
            't1',
            undefined,
            'two',
            undefined,
            undefined,
            undefined,
            undefined,
          ]),
          1,
        ),
      ]),
    ],
    3,
    'current',
  );
  const delta = sent.find((message) => message instanceof Uint8Array);
  if (!(delta instanceof Uint8Array)) throw new Error('missing realtime delta');
  const decoded = decodeMessage(delta.subarray(1));
  const change = decoded.frames.find((frame) => frame.type === 'COMMIT');
  if (change?.type !== 'COMMIT') throw new Error('missing delta commit');
  expect(decodeRow(TASK_COLUMNS, change.changes[0]!.row!)[2]).toBe('two');
  peer.close();
});

test('floors name the oldest served version, and privacy/removed-column windows fail before serving', async () => {
  const { round } = fixture();
  expect((await round([pullHeader()], 1)).frames[0]).toMatchObject({
    type: 'RESP_HEADER',
    requiredSchemaVersion: 2,
    latestSchemaVersion: 3,
  });
  expect((await round([pullHeader()], 4)).frames[0]).toMatchObject({
    type: 'RESP_HEADER',
    requiredSchemaVersion: 2,
    latestSchemaVersion: 3,
  });
  expect(() => schemaWindowOf(current, [])).toThrow('invalid_head');
  expect(() => schemaWindowOf(current, [window[0]!, window[0]!])).toThrow(
    'invalid_order',
  );
  const privateScope: ServerSchema = {
    ...current,
    tables: [
      {
        ...current.tables[0]!,
        scopes: [{ pattern: 'clinician:{clinician_id}', column: 'id' }],
      },
      ...current.tables.slice(1),
    ],
  };
  expect(() =>
    schemaWindowOf(privateScope, [compileSchema(privateScope), window[1]!]),
  ).toThrow('incompatible_schema');
  const removed: ServerSchema = {
    ...current,
    tables: [
      { ...current.tables[0]!, columns: TASK_COLUMNS.slice(0, 5) },
      ...current.tables.slice(1),
    ],
  };
  expect(() =>
    schemaWindowOf(removed, [compileSchema(removed), window[1]!]),
  ).toThrow('incompatible_schema');
});

test('N-1 SQLite images use only their columns and conflict rows retain their codec', async () => {
  const { t, round } = fixture();
  t.ctx = { ...t.ctx, sqliteImageBuilder: buildSqliteImage };
  await round(
    [
      pushCommit(
        'seed-image',
        ['t1', 't2'].map((id) =>
          upsert(
            'tasks',
            id,
            encodeSparseRow(columns, 0, [
              id,
              'p1',
              'current',
              false,
              null,
              null,
              'new only',
            ]),
          ),
        ),
      ),
    ],
    3,
    'current',
  );
  const boot = await round([
    pullHeader({ accept: 0b0111, limitSnapshotRows: 1 }),
    subFrame('image', 'tasks', { project_id: ['p1'] }, -1),
  ]);
  const ref = boot.frames.find((frame) => frame.type === 'SEGMENT_REF');
  if (ref?.type !== 'SEGMENT_REF') throw new Error('missing image');
  const image = await handleSegmentDownload(t.ctx, {
    segmentId: ref.segmentId,
    scopesHeader: JSON.stringify({ project_id: ['p1'] }),
  });
  expect(image.record.mediaType).toBe('sqlite');
  const db = Database.deserialize(image.bytes);
  try {
    expect(
      db
        .query<{ name: string }, []>('PRAGMA table_info(tasks)')
        .all()
        .map((row) => row.name),
    ).toEqual([
      ...TASK_COLUMNS.map((column) => column.name),
      '_syncular_version',
    ]);
    expect(
      db
        .query<{ schemaVersion: number }, []>(
          'SELECT schemaVersion FROM _syncular_segment',
        )
        .get()!.schemaVersion,
    ).toBe(2);
  } finally {
    db.close();
  }
  const conflict = await round([
    pushCommit('stale', [
      upsert('tasks', 't1', taskRow('t1', 'p1', 'stale'), 0),
    ]),
  ]);
  const result = conflict.frames.find((frame) => frame.type === 'PUSH_RESULT');
  if (result?.type !== 'PUSH_RESULT') throw new Error('missing push result');
  const operation = result.results[0];
  if (operation?.status !== 'conflict') throw new Error('missing conflict');
  expect(decodeRow(TASK_COLUMNS, operation.serverRow)[2]).toBe('current');
  expect(operation.conflictColumns.length).toBe(
    Math.ceil(TASK_COLUMNS.length / 8),
  );
});
