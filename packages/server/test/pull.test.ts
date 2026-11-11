/**
 * Pull: units, registration by digest, the live section, the echo, the join
 * rule, revocation and the wildcard fence (SPEC.md §3.2, §3.3, §4.1 to §4.5),
 * driven through bytes.
 */
import { describe, expect, test } from 'bun:test';
import {
  decodeRow,
  decodeRowsSegment,
  echoDigest,
  encodeSparseRow,
  registrationDigest,
  type RowColumn,
  type SegmentInlineFrame,
  unitId,
} from '@syncular/core';
import { handleSyncRequest, type ServerSchema } from '@syncular/server';
import { computeEffective } from '../src/scopes';
import {
  docRow,
  expectSyncError,
  live,
  liveChanges,
  makeContext,
  progressFrame,
  pullFrames,
  pullHeader,
  pushCommit,
  requestBytes,
  section,
  sections,
  seedTask,
  sync,
  TASK_COLUMNS,
  taskRow,
  TestReplica,
  unitFrame,
  upsert,
} from './helpers';

const P1 = { project_id: 'p1' };
const DOCS = { org_id: 'o1', projectId: 'p1' };

const NOTE_COLUMNS: readonly RowColumn[] = [
  { name: 'id', type: 'string', nullable: false },
  { name: 'project_id', type: 'string', nullable: false },
  { name: 'org_id', type: 'string', nullable: false },
  { name: 'body', type: 'string', nullable: false },
];

/** `tasks` and `notes` both declare `project_id`: one unit covers both. */
const UNIT_SCHEMA: ServerSchema = {
  version: 1,
  tables: [
    {
      name: 'tasks',
      columns: TASK_COLUMNS,
      primaryKey: 'id',
      scopes: ['project:{project_id}'],
    },
    {
      name: 'notes',
      columns: NOTE_COLUMNS,
      primaryKey: 'id',
      scopes: ['project:{project_id}', 'org:{org_id}'],
    },
  ],
};

function noteRow(id: string, projectId: string, orgId: string): Uint8Array {
  return encodeSparseRow(NOTE_COLUMNS, 0, [id, projectId, orgId, 'note']);
}

function bootstrapRowIds(body: { type: string }[]): unknown[] {
  return body
    .filter((f): f is SegmentInlineFrame => f.type === 'SEGMENT_INLINE')
    .flatMap((f) => decodeRowsSegment(f.payload).blocks.flat())
    .map((row) => row.values[0]);
}

describe('live section (§4.5)', () => {
  test('cached pre-push maximum fails loudly; the accepted push remains idempotent', async () => {
    const t = makeContext();
    const actual = t.storage.getMaxCommitSeq.bind(t.storage);
    t.storage.getMaxCommitSeq = async () => 0;
    const frames = [
      pushCommit('own-accepted', [
        upsert('tasks', 't1', taskRow('t1', 'p1', '200/v2')),
      ]),
      ...pullFrames([P1], { cursor: 0, progress: [] }),
    ];
    const stale = await sync(t, frames);
    expect(stale.frames.find((frame) => frame.type === 'ERROR')).toMatchObject({
      code: 'sync.storage_stale_read',
      retryable: false,
    });
    t.storage.getMaxCommitSeq = actual;
    const message = await sync(t, frames);
    expect(
      message.frames.find((frame) => frame.type === 'PUSH_RESULT'),
    ).toMatchObject({ status: 'cached', commitSeq: 1 });
    const own = live(message).commits;
    expect(own.map((commit) => commit.commitSeq)).toEqual([1]);
    expect(decodeRow(TASK_COLUMNS, own[0]!.changes[0]!.row!)[2]).toBe('200/v2');
  });

  test('a quiet replica refers to its list: no unit section, the cursor advances', async () => {
    const t = makeContext();
    t.scopes.value = { project_id: ['p1', 'p2'] };
    const replica = new TestReplica().register(P1);
    await replica.pull(t);
    expect(replica.idle).toBe(true);
    const seq = await seedTask(t, 'c1', 't1', 'p2');
    const frames = replica.frames();
    expect(frames.map((frame) => frame.type)).toEqual(['PULL_HEADER']);
    const quiet = await replica.pull(t);
    expect(sections(quiet).size).toBe(0);
    expect(live(quiet).start).toMatchObject({
      status: 'active',
      reasonCode: '',
    });
    expect(live(quiet).commits).toHaveLength(0);
    expect(live(quiet).end.throughSeq).toBe(seq);
    expect(replica.cursor).toBe(seq);
  });

  test('one COMMIT per commit across the tables of a unit, in change order', async () => {
    const t = makeContext({ schema: UNIT_SCHEMA });
    t.scopes.value = { project_id: ['p1', 'p2'], org_id: ['o1'] };
    const replica = new TestReplica().register(P1);
    await replica.pull(t);
    await sync(t, [
      pushCommit('c1', [
        upsert('notes', 'n1', noteRow('n1', 'p1', 'o1')),
        upsert('tasks', 't1', taskRow('t1', 'p2')),
        upsert('tasks', 't2', taskRow('t2', 'p1')),
      ]),
    ]);
    const message = await replica.pull(t);
    const [commit] = live(message).commits;
    expect(live(message).commits).toHaveLength(1);
    expect(commit?.tables).toEqual(['notes', 'tasks']);
    expect(
      commit?.changes.map((change) => [change.tableIndex, change.rowId]),
    ).toEqual([
      [0, 'n1'],
      [1, 't2'],
    ]);
    expect(commit?.changes[1]).toMatchObject({
      op: 'upsert',
      rowVersion: 1,
      scopes: { project_id: 'p1' },
    });
  });

  test('a delete carries its advanced version (§2.2)', async () => {
    const t = makeContext();
    const replica = new TestReplica().register(P1);
    await seedTask(t, 'c1', 't1', 'p1');
    await seedTask(t, 'c2', 't1', 'p1', 'second');
    await replica.pull(t);
    await sync(t, [
      pushCommit('c3', [{ table: 'tasks', rowId: 't1', op: 'delete' }]),
    ]);
    const message = await replica.pull(t);
    expect(live(message).commits[0]?.changes[0]).toMatchObject({
      rowId: 't1',
      op: 'delete',
      rowVersion: 3,
    });
  });

  test('multi-variable units match with AND semantics (§3.2)', async () => {
    const t = makeContext();
    t.scopes.value = { org_id: ['o1', 'o2'], projectId: ['p1', 'p2'] };
    const replica = new TestReplica().register(DOCS);
    await replica.pull(t);
    await sync(t, [
      pushCommit('c1', [
        upsert('docs', 'd1', docRow('d1', 'o1', 'p1')),
        upsert('docs', 'd2', docRow('d2', 'o1', 'p2')),
        upsert('docs', 'd3', docRow('d3', 'o2', 'p1')),
      ]),
    ]);
    expect(liveChanges(await replica.pull(t))).toEqual(['docs/d1/upsert']);
  });

  test('limitCommits counts changes, never splits a commit, and T is the last delivered commit (§4.2)', async () => {
    const t = makeContext();
    const replica = new TestReplica().register(P1);
    await replica.pull(t);
    await sync(t, [
      pushCommit('big', [
        upsert('tasks', 't1', taskRow('t1', 'p1')),
        upsert('tasks', 't2', taskRow('t2', 'p1')),
        upsert('tasks', 't3', taskRow('t3', 'p1')),
      ]),
    ]);
    await seedTask(t, 'c2', 't4', 'p1');
    await seedTask(t, 'c3', 't5', 'p1');
    const first = await replica.pull(t, { limitCommits: 2 });
    expect(live(first).commits.map((c) => c.changes.length)).toEqual([3]);
    expect(live(first).end.throughSeq).toBe(1);
    const second = await replica.pull(t, { limitCommits: 2 });
    expect(live(second).commits.map((c) => c.commitSeq)).toEqual([2, 3]);
    expect(live(second).end.throughSeq).toBe(3);
  });

  test('unit sections follow registration order (§1.6)', async () => {
    const t = makeContext();
    const message = await sync(t, pullFrames([DOCS, P1]));
    expect([...sections(message).keys()]).toEqual([unitId(DOCS), unitId(P1)]);
  });

  test('a pull that carries no live unit answers an empty live section at maxCommitSeq', async () => {
    const t = makeContext();
    const seq = await seedTask(t, 'c1', 't1', 'p1');
    const message = await sync(t, pullFrames([]));
    expect(sections(message).size).toBe(0);
    expect(live(message).end).toMatchObject({ throughSeq: seq });
    expect(live(message).end.echoDigest).toEqual(echoDigest([]));
  });
});

describe('registration by digest (§4.1)', () => {
  test('an unknown digest, or no record, answers unregistered and ignores PROGRESS', async () => {
    const t = makeContext();
    const unknown = registrationDigest([{ project_id: 'nope' }]);
    const fresh = await sync(t, [
      pullHeader({ cursor: 0, registrationDigest: unknown }),
      progressFrame({ project_id: 'nope' }, -1),
    ]);
    expect(sections(fresh).size).toBe(0);
    expect(live(fresh).start).toMatchObject({ status: 'unregistered' });
    expect(live(fresh).commits).toHaveLength(0);
    expect(live(fresh).end.throughSeq).toBe(-1);
    expect(live(fresh).end.echoDigest).toEqual(new Uint8Array());
    expect(
      await t.storage.getClientRecord('part-1', 'client-1'),
    ).toBeUndefined();

    const replica = new TestReplica().register(P1);
    await replica.pull(t);
    const before = await t.storage.getClientRecord('part-1', 'client-1');
    t.now.ms += 1_000;
    const stale = await sync(t, [
      pullHeader({ cursor: 0, registrationDigest: unknown }),
    ]);
    expect(live(stale).start.status).toBe('unregistered');
    const after = await t.storage.getClientRecord('part-1', 'client-1');
    // §4.5: only the round outcome is written.
    expect(after?.cursor).toBe(before?.cursor);
    expect(after?.updatedAtMs).toBe(before?.updatedAtMs);
    expect(after?.lastRoundAtMs).toBe(t.now.ms);
    expect(after?.registration?.units).toEqual([P1]);
    expect(after?.catchingUp).toEqual(before?.catchingUp);
  });

  test('after an unregistered answer the replica sends its list and resumes', async () => {
    const t = makeContext();
    const replica = new TestReplica().register(P1);
    await replica.pull(t);
    await t.storage.putClientRecord('part-1', {
      clientId: 'client-1',
      actorId: 'actor-1',
      wireVersion: 4,
      cursor: -1,
      updatedAtMs: t.now.ms,
      catchingUp: [],
      registration: { units: [], digest: registrationDigest([]) },
    });
    expect(live(await replica.pull(t)).start.status).toBe('unregistered');
    expect(replica.frames().filter((f) => f.type === 'UNIT')).toHaveLength(1);
    await seedTask(t, 'c1', 't1', 'p1');
    expect(liveChanges(await replica.pull(t))).toEqual(['tasks/t1/upsert']);
  });

  test('a traveling list whose digest differs fails the request', async () => {
    const t = makeContext();
    const error = await expectSyncError(
      handleSyncRequest(
        requestBytes([
          pullHeader({ registrationDigest: registrationDigest([DOCS]) }),
          unitFrame(P1),
          progressFrame(P1, -1),
        ]),
        t.ctx,
      ),
      'sync.invalid_subscription',
    );
    expect(JSON.parse(error.details ?? '{}')).toEqual({
      reason: 'registration_digest',
    });
  });

  test('the empty list travels by its digest and unregisters every unit', async () => {
    const t = makeContext();
    const replica = new TestReplica().register(P1);
    await replica.pull(t);
    await sync(t, [pullHeader()]);
    const record = await t.storage.getClientRecord('part-1', 'client-1');
    expect(record?.registration?.units).toEqual([]);
    expect(record?.cursor).toBe(-1);
  });

  test('a changed echo sends every unit a section', async () => {
    const t = makeContext();
    const replica = new TestReplica().register(P1, { project_id: 'p2' });
    t.scopes.value = { project_id: ['p1', 'p2'] };
    await replica.pull(t);
    expect(sections(await replica.pull(t)).size).toBe(0);
    replica.echo = new Uint8Array(32);
    const message = await replica.pull(t);
    expect([...sections(message).keys()]).toEqual([
      unitId(P1),
      unitId({ project_id: 'p2' }),
    ]);
    const s = section(message, P1);
    expect(s.start).toMatchObject({ status: 'active', bootstrap: false });
    expect(s.end.nextCursor).toBe(replica.cursor);
  });
});

describe('unit validation (§4.1)', () => {
  const cases: [string, Record<string, string>[], string][] = [
    ['an empty scope map', [{}], 'empty_scope_map'],
    ["a requested '*'", [{ project_id: '*' }], 'wildcard_value'],
    [
      'a variable no table declares',
      [{ team_id: 't1' }],
      'undeclared_variable',
    ],
    [
      'no covered table',
      [{ project_id: 'p1', org_id: 'o1' }],
      'no_covered_table',
    ],
    ['a scope map listed twice', [P1, { project_id: 'p1' }], 'duplicate_unit'],
  ];
  for (const [name, units, reason] of cases) {
    test(`${name} fails the request`, async () => {
      const t = makeContext();
      const error = await expectSyncError(
        handleSyncRequest(
          requestBytes(pullFrames(units, { progress: [] })),
          t.ctx,
        ),
        'sync.invalid_subscription',
      );
      expect(JSON.parse(error.details ?? '{}').reason).toBe(reason);
    });
  }

  test('a PROGRESS frame that names no unit, or repeats one, fails the request', async () => {
    const t = makeContext();
    for (const [progress, reason] of [
      [[progressFrame({ project_id: 'p9' }, -1)], 'unknown_unit'],
      [[progressFrame(P1, -1), progressFrame(P1, -1)], 'duplicate_progress'],
    ] as const) {
      const error = await expectSyncError(
        handleSyncRequest(
          requestBytes(pullFrames([P1], { progress: [...progress] })),
          t.ctx,
        ),
        'sync.invalid_subscription',
      );
      expect(JSON.parse(error.details ?? '{}').reason).toBe(reason);
    }
  });
});

describe('join rule and the client record (§4.5)', () => {
  test('a bootstrap completes into the scan set and the unit joins the live set', async () => {
    const t = makeContext();
    await seedTask(t, 'c1', 't1', 'p1');
    const replica = new TestReplica().register(P1);
    const first = await replica.pull(t);
    expect(section(first, P1).start).toMatchObject({ bootstrap: true });
    expect(section(first, P1).end.nextCursor).toBe(1);
    expect(live(first).end.throughSeq).toBe(1);
    expect(replica.idle).toBe(true);
    const record = await t.storage.getClientRecord('part-1', 'client-1');
    expect(record).toMatchObject({
      cursor: 1,
      catchingUp: [],
      schemaVersion: 1,
      wireVersion: 4,
      registration: { units: [P1], digest: registrationDigest([P1]) },
    });
  });

  test('a bootstrap completing above a cut section joins at once', async () => {
    const t = makeContext();
    t.scopes.value = { project_id: ['p1', 'p2'] };
    const P2 = { project_id: 'p2' };
    const replica = new TestReplica().register(P1);
    await replica.pull(t);
    for (let i = 1; i <= 4; i++) await seedTask(t, `c${i}`, `t${i}`, 'p1');
    replica.register(P2);
    const message = await replica.pull(t, { limitCommits: 1 });
    // P2 pins at 4; the live section is cut at 1, so R* = 1 and P2 joins.
    expect(section(message, P2).end.nextCursor).toBe(4);
    expect(live(message).end.throughSeq).toBe(1);
    expect(replica.cursor).toBe(1);
    expect(replica.idle).toBe(true);
  });

  test('a post-bootstrap unit below a cut section keeps catching up', async () => {
    const t = makeContext();
    t.scopes.value = { project_id: ['p1', 'p2'] };
    const P2 = { project_id: 'p2' };
    for (let i = 1; i <= 3; i++) await seedTask(t, `c${i}`, `t${i}`, 'p2');
    const message = await sync(
      t,
      pullFrames([P1, P2], {
        cursor: 3,
        limitCommits: 1,
        progress: [progressFrame(P2, 0)],
      }),
    );
    // P2's bound 0 is L: the section is cut at commit 1, below R = 3.
    expect(live(message).end.throughSeq).toBe(1);
    expect(liveChanges(message)).toEqual(['tasks/t1/upsert']);
    const record = await t.storage.getClientRecord('part-1', 'client-1');
    expect(record?.catchingUp).toEqual([{ id: unitId(P2), cursor: 1 }]);
    expect(record?.cursor).toBe(1);
  });

  test('an incomplete bootstrap holds the record cursor at its pin', async () => {
    const t = makeContext();
    for (let i = 1; i <= 3; i++) await seedTask(t, `c${i}`, `t${i}`, 'p1');
    const replica = new TestReplica().register(P1);
    await replica.pull(t, { limitSnapshotRows: 1, maxSnapshotPages: 1 });
    const record = await t.storage.getClientRecord('part-1', 'client-1');
    expect(record?.catchingUp).toEqual([{ id: unitId(P1), cursor: 3 }]);
    expect(record?.cursor).toBe(3);
  });
});

describe('revocation (§3.2 rule 5, §3.3)', () => {
  test('a unit value missing from allowed revokes the unit; SUB_END echoes its cursor', async () => {
    const t = makeContext();
    await seedTask(t, 'c1', 't1', 'p1');
    t.scopes.value = { org_id: ['o1'] };
    const message = await sync(t, [
      ...pullFrames([P1], { progress: [progressFrame(P1, 0)] }),
    ]);
    const s = section(message, P1);
    expect(s.start).toEqual({
      type: 'SUB_START',
      id: unitId(P1),
      status: 'revoked',
      reasonCode: 'sync.scope_revoked',
      bootstrap: false,
      fenced: [],
    });
    expect(s.body).toHaveLength(0);
    expect(s.end).toEqual({ type: 'SUB_END', nextCursor: 0 });
    expect(live(message).commits).toHaveLength(0);
  });

  test('an empty intersection and a throwing resolver revoke', async () => {
    const t = makeContext();
    t.scopes.value = { project_id: ['p2'] };
    expect(section(await sync(t, pullFrames([P1])), P1).start.status).toBe(
      'revoked',
    );
    t.scopes.error = true;
    expect(section(await sync(t, pullFrames([P1])), P1).start.status).toBe(
      'revoked',
    );
  });

  test("allowed '*' passes requested values through", async () => {
    const t = makeContext();
    t.scopes.value = { project_id: ['*'] };
    await seedTask(t, 'c1', 't1', 'p77');
    const replica = new TestReplica().register({ project_id: 'p77' });
    const message = await replica.pull(t);
    expect(section(message, { project_id: 'p77' }).start).toMatchObject({
      status: 'active',
      fenced: [],
    });
    expect(
      bootstrapRowIds(section(message, { project_id: 'p77' }).body),
    ).toEqual(['t1']);
  });

  test('revocation of a live unit: active first, revoked after, the list travels again', async () => {
    const t = makeContext();
    const replica = new TestReplica().register(P1);
    await replica.pull(t);
    await seedTask(t, 'c1', 't1', 'p1');
    t.scopes.value = { org_id: ['o1'] };
    const revoked = await replica.pull(t);
    expect(section(revoked, P1).start.status).toBe('revoked');
    expect(section(revoked, P1).end.nextCursor).toBe(0);
    expect(live(revoked).commits).toHaveLength(0);
    const record = await t.storage.getClientRecord('part-1', 'client-1');
    expect(record?.catchingUp).toEqual([{ id: unitId(P1), cursor: -1 }]);
    expect(replica.units).toEqual([]);
    expect(replica.frames()[0]).toMatchObject({
      registrationDigest: registrationDigest([]),
    });
  });
});

describe('wildcard fence (§3.2 rule 4)', () => {
  /** docs in (o1, p1) and (o2, p1), seeded by an all-wildcard actor. */
  async function fencedDocs() {
    const t = makeContext();
    t.scopes.value = { org_id: ['*'], projectId: ['*'] };
    await sync(t, [
      pushCommit('c1', [
        upsert('docs', 'd-o1', docRow('d-o1', 'o1', 'p1')),
        upsert('docs', 'd-o2', docRow('d-o2', 'o2', 'p1')),
      ]),
    ]);
    return t;
  }

  test("a value through '*' keeps the actor's other lists as fences, echoed per table", async () => {
    const t = await fencedDocs();
    t.scopes.value = { org_id: ['o1'], projectId: ['*'] };
    const unit = { projectId: 'p1' };
    const replica = new TestReplica().register(unit);
    const boot = await replica.pull(t);
    const s = section(boot, unit);
    expect(s.start.fenced).toEqual([
      { table: 'docs', status: 'active', scopes: { org_id: ['o1'] } },
    ]);
    expect(bootstrapRowIds(s.body)).toEqual(['d-o1']);
    expect(live(boot).end.echoDigest).toEqual(
      echoDigest([
        {
          id: unitId(unit),
          status: 'active',
          fenced: [
            { table: 'docs', status: 'active', scopes: { org_id: ['o1'] } },
          ],
        },
      ]),
    );
    t.scopes.value = { org_id: ['*'], projectId: ['*'] };
    await sync(t, [
      pushCommit('c2', [
        upsert('docs', 'd-o1', docRow('d-o1', 'o1', 'p1', 'b2')),
        upsert('docs', 'd-o2', docRow('d-o2', 'o2', 'p1', 'b2')),
      ]),
    ]);
    t.scopes.value = { org_id: ['o1'], projectId: ['*'] };
    const incremental = await replica.pull(t);
    expect(sections(incremental).size).toBe(0);
    expect(liveChanges(incremental)).toEqual(['docs/d-o1/upsert']);
  });

  test('a changed fence changes the echo digest and sends the unit a section', async () => {
    const t = await fencedDocs();
    t.scopes.value = { org_id: ['o1'], projectId: ['*'] };
    const unit = { projectId: 'p1' };
    const replica = new TestReplica().register(unit);
    await replica.pull(t);
    t.scopes.value = { org_id: ['o1', 'o2'], projectId: ['*'] };
    const message = await replica.pull(t);
    expect(section(message, unit).start).toMatchObject({
      status: 'active',
      bootstrap: false,
      fenced: [
        { table: 'docs', status: 'active', scopes: { org_id: ['o1', 'o2'] } },
      ],
    });
  });

  test('all-wildcard actors and fully named units are unchanged', async () => {
    const t = await fencedDocs();
    const open = await sync(t, pullFrames([{ projectId: 'p1' }]));
    expect(section(open, { projectId: 'p1' }).start.fenced).toEqual([]);
    expect(
      bootstrapRowIds(section(open, { projectId: 'p1' }).body).sort(),
    ).toEqual(['d-o1', 'd-o2']);
    t.scopes.value = { org_id: ['o1', 'o2'], projectId: ['*'] };
    const named = { org_id: 'o2', projectId: 'p1' };
    const message = await sync(t, pullFrames([named]));
    expect(section(message, named).start.fenced).toEqual([]);
    expect(bootstrapRowIds(section(message, named).body)).toEqual(['d-o2']);
  });

  test('a fence with no value revokes the pair: a revoked fenced record in an active unit', async () => {
    const t = makeContext({ schema: UNIT_SCHEMA });
    t.scopes.value = { project_id: ['*'], org_id: ['*'] };
    await sync(t, [
      pushCommit('c1', [
        upsert('tasks', 't1', taskRow('t1', 'p1')),
        upsert('notes', 'n1', noteRow('n1', 'p1', 'o1')),
      ]),
    ]);
    t.scopes.value = { project_id: ['*'], org_id: [] };
    const replica = new TestReplica().register(P1);
    const message = await replica.pull(t);
    const s = section(message, P1);
    expect(s.start).toMatchObject({
      status: 'active',
      bootstrap: true,
      fenced: [{ table: 'notes', status: 'revoked', scopes: {} }],
    });
    // No segment for the revoked pair (§3.3).
    expect(
      s.body
        .filter((f): f is SegmentInlineFrame => f.type === 'SEGMENT_INLINE')
        .map((f) => decodeRowsSegment(f.payload).table),
    ).toEqual(['tasks']);
    t.scopes.value = { project_id: ['*'], org_id: ['*'] };
    await sync(t, [
      pushCommit('c2', [
        upsert('tasks', 't2', taskRow('t2', 'p1')),
        upsert('notes', 'n2', noteRow('n2', 'p1', 'o1')),
      ]),
    ]);
    t.scopes.value = { project_id: ['*'], org_id: [] };
    expect(liveChanges(await replica.pull(t))).toEqual(['tasks/t2/upsert']);
  });

  test('every pair revoked by the fence revokes the unit', async () => {
    const t = await fencedDocs();
    t.scopes.value = { org_id: [], projectId: ['*'] };
    const message = await sync(t, pullFrames([{ projectId: 'p1' }]));
    expect(section(message, { projectId: 'p1' }).start).toMatchObject({
      status: 'revoked',
      fenced: [],
    });
  });

  test('without a wildcard the omitted variable stays open (independent dimensions)', () => {
    const declared = new Set(['org_id', 'projectId']);
    expect(
      computeEffective(
        declared,
        { projectId: ['p1'] },
        { ok: true, allowed: { org_id: ['o1'], projectId: ['p1'] } },
      ),
    ).toEqual({ status: 'active', effective: { projectId: ['p1'] } });
    // Variables of other tables never join this table's effective scopes.
    expect(
      computeEffective(
        new Set(['project_id']),
        { project_id: ['p1'] },
        { ok: true, allowed: { project_id: ['*'], org_id: ['o1'] } },
      ),
    ).toEqual({ status: 'active', effective: { project_id: ['p1'] } });
  });
});
