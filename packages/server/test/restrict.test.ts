/**
 * Restricted bootstrap: a unit bootstraps the RESTRICT tables only and joins
 * at its kept cursor (SPEC.md §4.3, §4.6, §4.7).
 */
import { describe, expect, test } from 'bun:test';
import {
  decodeRowsSegment,
  type RequestFrame,
  type SegmentInlineFrame,
} from '@syncular/core';
import { handleSyncRequest } from '@syncular/server';
import {
  expectSyncError,
  live,
  makeContext,
  progressFrame,
  pullFrames,
  pushCommit,
  requestBytes,
  section,
  sync,
  TASK_COLUMNS,
  taskRow,
  type TestContext,
  TEST_SCHEMA,
  upsert,
} from './helpers';

const P1 = { project_id: 'p1' };
const SCHEMA = {
  ...TEST_SCHEMA,
  tables: [
    ...TEST_SCHEMA.tables,
    {
      name: 'subtasks',
      columns: TASK_COLUMNS,
      primaryKey: 'id',
      scopes: ['project:{project_id}'],
    },
  ],
};

/** Commits 1..4: tasks t1, t2, then subtasks s1, s2, all in project p1. */
async function seeded(): Promise<TestContext> {
  const t = makeContext({ schema: SCHEMA });
  for (const [table, id] of [
    ['tasks', 't1'],
    ['tasks', 't2'],
    ['subtasks', 's1'],
    ['subtasks', 's2'],
  ] as const)
    await sync(t, [
      pushCommit(`c-${id}`, [upsert(table, id, taskRow(id, 'p1'))]),
    ]);
  return t;
}

function restricted(
  cursor: number,
  tables: string[],
  progressCursor = -1,
  bootstrapState?: string,
): RequestFrame[] {
  return [
    ...pullFrames([P1], { progress: [] }),
    progressFrame(P1, progressCursor, bootstrapState),
    { type: 'RESTRICT', cursor, tables },
  ];
}

function segmentTables(body: readonly { type: string }[]): string[] {
  return body
    .filter((f): f is SegmentInlineFrame => f.type === 'SEGMENT_INLINE')
    .map((f) => decodeRowsSegment(f.payload).table);
}

describe('restricted bootstrap (§4.7)', () => {
  test('serves only the RESTRICT tables and joins at the kept cursor', async () => {
    const t = await seeded();
    const message = await sync(t, restricted(2, ['subtasks']));
    const s = section(message, P1);
    expect(s.start).toMatchObject({ status: 'active', bootstrap: true });
    expect(segmentTables(s.body)).toEqual(['subtasks']);
    expect(s.body.find((f) => f.type === 'UNIT_EXTENT')).toMatchObject({
      rowsTotal: 2,
      rowsDone: 0,
    });
    expect(s.end).toEqual({ type: 'SUB_END', nextCursor: 2 });
    // The scan from C delivers (C, T] of every covered table.
    expect(live(message).commits.map((c) => c.commitSeq)).toEqual([3, 4]);
    expect(live(message).end.throughSeq).toBe(4);
    const record = await t.storage.getClientRecord('part-1', 'client-1');
    expect(record?.catchingUp).toEqual([]);
    expect(record?.cursor).toBe(4);
  });

  test('a multi-section restricted bootstrap holds the kept cursor and resumes', async () => {
    const t = await seeded();
    const first = await sync(t, [
      ...restricted(1, ['subtasks']).map((frame) =>
        frame.type === 'PULL_HEADER'
          ? { ...frame, limitSnapshotRows: 1, maxSnapshotPages: 1 }
          : frame,
      ),
    ]);
    const s = section(first, P1);
    expect(segmentTables(s.body)).toEqual(['subtasks']);
    expect(s.end.nextCursor).toBe(1);
    const token = s.end.bootstrapState;
    expect(JSON.parse(token!)).toMatchObject({
      asOfCommitSeq: 4,
      tables: ['subtasks'],
      rowsTotal: 2,
      rowsDone: 1,
    });
    expect(live(first).commits).toHaveLength(0);
    const record = await t.storage.getClientRecord('part-1', 'client-1');
    expect(record?.cursor).toBe(1);
    const second = await sync(t, restricted(1, ['subtasks'], 1, token));
    expect(segmentTables(section(second, P1).body)).toEqual(['subtasks']);
    expect(section(second, P1).end).toEqual({ type: 'SUB_END', nextCursor: 1 });
    expect(live(second).commits.map((c) => c.commitSeq)).toEqual([2, 3, 4]);
  });

  test('a token of a whole bootstrap restarts as a restricted one', async () => {
    const t = await seeded();
    const whole = JSON.stringify({
      asOfCommitSeq: 4,
      tables: ['tasks', 'subtasks'],
      tableIndex: 1,
      rowCursor: null,
    });
    const message = await sync(t, restricted(2, ['subtasks'], 4, whole));
    const s = section(message, P1);
    expect(segmentTables(s.body)).toEqual(['subtasks']);
    expect(s.body.find((f) => f.type === 'UNIT_EXTENT')).toMatchObject({
      rowsDone: 0,
    });
    expect(s.end).toEqual({ type: 'SUB_END', nextCursor: 2 });
  });

  test('a kept cursor below the horizon or above maxCommitSeq answers reset (§4.6)', async () => {
    const t = await seeded();
    await t.storage.setHorizonSeq('part-1', 2);
    for (const cursor of [1, 5]) {
      const message = await sync(t, restricted(cursor, ['subtasks']));
      const s = section(message, P1);
      expect(s.start).toMatchObject({
        status: 'reset',
        reasonCode: 'sync.cursor_expired',
        bootstrap: false,
      });
      expect(s.body).toHaveLength(0);
      expect(s.end).toEqual({ type: 'SUB_END', nextCursor: -1 });
    }
  });

  test('RESTRICT naming an uncovered table or every covered table fails (§4.3)', async () => {
    const t = await seeded();
    for (const tables of [['docs'], ['subtasks', 'tasks']]) {
      const error = await expectSyncError(
        handleSyncRequest(requestBytes(restricted(2, tables)), t.ctx),
        'sync.invalid_subscription',
      );
      expect(JSON.parse(error.details!)).toMatchObject({
        reason: 'restrict_tables',
      });
    }
  });
});
