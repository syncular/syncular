/**
 * Pull: cursor advancement, scope-filtered commit delivery, revocation
 * (SPEC.md §3.2, §3.3, §4.5) — driven through bytes.
 */
import { describe, expect, test } from 'bun:test';
import { type CommitFrame, decodeRow } from '@syncular-v2/core';
import {
  docRow,
  makeContext,
  pullHeader,
  pushCommit,
  section,
  sections,
  seedTask,
  subFrame,
  sync,
  TASK_COLUMNS,
  taskRow,
  upsert,
} from './helpers';

function commitsOf(body: { type: string }[]): CommitFrame[] {
  return body.filter((f): f is CommitFrame => f.type === 'COMMIT');
}

describe('incremental pull (§4.5)', () => {
  test('quiet subscription: cursor advances with zero commits', async () => {
    const t = makeContext();
    t.scopes.value = { project_id: ['p1', 'p2'] };
    const seq = await seedTask(t, 'c1', 't1', 'p2'); // p2: not requested below
    const message = await sync(t, [
      pullHeader(),
      subFrame('s1', 'tasks', { project_id: ['p1'] }, 0),
    ]);
    const s = section(message, 's1');
    expect(s.start.status).toBe('active');
    expect(s.start.effectiveScopes).toEqual({ project_id: ['p1'] });
    expect(s.start.bootstrap).toBe(false);
    expect(commitsOf(s.body)).toHaveLength(0);
    expect(s.end.nextCursor).toBe(seq);
  });

  test('delivers matching commits with decodable rows, filtered by scope', async () => {
    const t = makeContext();
    t.scopes.value = { project_id: ['p1', 'p2'] };
    await seedTask(t, 'c1', 't1', 'p1', 'in-scope');
    await seedTask(t, 'c2', 't2', 'p2', 'other-scope');
    const message = await sync(t, [
      pullHeader(),
      subFrame('s1', 'tasks', { project_id: ['p1'] }, 0),
    ]);
    const commits = commitsOf(section(message, 's1').body);
    expect(commits).toHaveLength(1);
    const commit = commits[0];
    expect(commit?.tables).toEqual(['tasks']);
    expect(commit?.changes).toHaveLength(1);
    const change = commit?.changes[0];
    expect(change?.rowId).toBe('t1');
    expect(change?.scopes).toEqual({ project_id: 'p1' });
    expect(change?.rowVersion).toBe(1);
    const row = decodeRow(TASK_COLUMNS, change?.row ?? new Uint8Array());
    expect(row[2]).toBe('in-scope');
    expect(section(message, 's1').end.nextCursor).toBe(2);
  });

  test('multi-variable scopes match with AND semantics (§3.2)', async () => {
    const t = makeContext();
    t.scopes.value = { org_id: ['o1', 'o2'], projectId: ['p1', 'p2'] };
    await sync(t, [
      pushCommit('c1', [
        upsert('docs', 'd1', docRow('d1', 'o1', 'p1')),
        upsert('docs', 'd2', docRow('d2', 'o1', 'p2')),
        upsert('docs', 'd3', docRow('d3', 'o2', 'p1')),
      ]),
    ]);
    const message = await sync(t, [
      pullHeader(),
      subFrame('s1', 'docs', { org_id: ['o1'], projectId: ['p1'] }, 0),
    ]);
    const commits = commitsOf(section(message, 's1').body);
    expect(commits).toHaveLength(1);
    expect(commits[0]?.changes.map((c) => c.rowId)).toEqual(['d1']);
  });

  test('limitCommits counts changes and never splits a commit (§4.2)', async () => {
    const t = makeContext();
    await seedTask(t, 'c1', 't1', 'p1');
    await seedTask(t, 'c2', 't2', 'p1');
    await seedTask(t, 'c3', 't3', 'p1');
    const first = await sync(t, [
      pullHeader({ limitCommits: 2 }),
      subFrame('s1', 'tasks', { project_id: ['p1'] }, 0),
    ]);
    const s1 = section(first, 's1');
    expect(commitsOf(s1.body)).toHaveLength(2);
    expect(s1.end.nextCursor).toBe(2);
    const second = await sync(t, [
      pullHeader({ limitCommits: 2 }),
      subFrame('s1', 'tasks', { project_id: ['p1'] }, s1.end.nextCursor),
    ]);
    const s2 = section(second, 's1');
    expect(commitsOf(s2.body)).toHaveLength(1);
    expect(s2.end.nextCursor).toBe(3);
  });

  test('a single commit larger than the limit is delivered whole and alone (§4.2)', async () => {
    const t = makeContext();
    await sync(t, [
      pushCommit('big', [
        upsert('tasks', 't1', taskRow('t1', 'p1')),
        upsert('tasks', 't2', taskRow('t2', 'p1')),
        upsert('tasks', 't3', taskRow('t3', 'p1')),
      ]),
    ]);
    await seedTask(t, 'c2', 't4', 'p1');
    const message = await sync(t, [
      pullHeader({ limitCommits: 2 }),
      subFrame('s1', 'tasks', { project_id: ['p1'] }, 0),
    ]);
    const commits = commitsOf(section(message, 's1').body);
    expect(commits).toHaveLength(1);
    expect(commits[0]?.changes).toHaveLength(3);
    expect(section(message, 's1').end.nextCursor).toBe(1);
  });

  test('push and pull ride one request: own changes come back (§7.2)', async () => {
    const t = makeContext();
    const message = await sync(t, [
      pushCommit('c1', [upsert('tasks', 't1', taskRow('t1', 'p1'))]),
      pullHeader(),
      subFrame('s1', 'tasks', { project_id: ['p1'] }, 0),
    ]);
    const commits = commitsOf(section(message, 's1').body);
    expect(commits).toHaveLength(1);
    expect(commits[0]?.changes[0]?.rowId).toBe('t1');
  });

  test('subscriptions are echoed in request order (§1.6)', async () => {
    const t = makeContext();
    const message = await sync(t, [
      pullHeader(),
      subFrame('zz', 'tasks', { project_id: ['p1'] }, 0),
      subFrame('aa', 'docs', { org_id: ['o1'], projectId: ['p1'] }, 0),
    ]);
    expect([...sections(message).keys()]).toEqual(['zz', 'aa']);
  });
});

describe('revocation (§3.2 rule 5, §3.3)', () => {
  test('a requested key missing from allowed revokes the subscription', async () => {
    const t = makeContext();
    await seedTask(t, 'c1', 't1', 'p1');
    t.scopes.value = { org_id: ['o1'] }; // project_id gone
    const message = await sync(t, [
      pullHeader(),
      subFrame('s1', 'tasks', { project_id: ['p1'] }, 7),
    ]);
    const s = section(message, 's1');
    expect(s.start.status).toBe('revoked');
    expect(s.start.reasonCode).toBe('sync.scope_revoked');
    expect(s.start.effectiveScopes).toEqual({});
    expect(s.body).toHaveLength(0);
    expect(s.end.nextCursor).toBe(7); // cursor echoed unchanged
    expect(s.end.bootstrapState).toBeUndefined();
  });

  test('an empty intersection revokes (§3.2 rule 4)', async () => {
    const t = makeContext();
    t.scopes.value = { project_id: ['p2'] };
    const message = await sync(t, [
      pullHeader(),
      subFrame('s1', 'tasks', { project_id: ['p1'] }, 0),
    ]);
    expect(section(message, 's1').start.status).toBe('revoked');
  });

  test('partial scope loss revokes the whole subscription (§3.2 rule 5)', async () => {
    const t = makeContext();
    t.scopes.value = { org_id: ['o1'] }; // projectId not resolvable
    const message = await sync(t, [
      pullHeader(),
      subFrame('s1', 'docs', { org_id: ['o1'], projectId: ['p1'] }, 0),
    ]);
    expect(section(message, 's1').start.status).toBe('revoked');
  });

  test('a throwing resolveScopes revokes — no data on errors', async () => {
    const t = makeContext();
    await seedTask(t, 'c1', 't1', 'p1');
    t.scopes.error = true;
    const message = await sync(t, [
      pullHeader(),
      subFrame('s1', 'tasks', { project_id: ['p1'] }, 0),
    ]);
    const s = section(message, 's1');
    expect(s.start.status).toBe('revoked');
    expect(s.body).toHaveLength(0);
  });

  test("allowed '*' passes requested values through (§3.2 rule 4)", async () => {
    const t = makeContext();
    t.scopes.value = { project_id: ['*'] };
    await seedTask(t, 'c1', 't1', 'p77');
    const message = await sync(t, [
      pullHeader(),
      subFrame('s1', 'tasks', { project_id: ['p77'] }, 0),
    ]);
    const s = section(message, 's1');
    expect(s.start.status).toBe('active');
    expect(s.start.effectiveScopes).toEqual({ project_id: ['p77'] });
    expect(commitsOf(s.body)).toHaveLength(1);
  });

  test('revocation between pulls: active first, revoked after (purge signal, §3.3)', async () => {
    const t = makeContext();
    await seedTask(t, 'c1', 't1', 'p1');
    const active = await sync(t, [
      pullHeader(),
      subFrame('s1', 'tasks', { project_id: ['p1'] }, 0),
    ]);
    expect(section(active, 's1').start.status).toBe('active');
    const cursor = section(active, 's1').end.nextCursor;
    t.scopes.value = { org_id: ['o1'] };
    const revoked = await sync(t, [
      pullHeader(),
      subFrame('s1', 'tasks', { project_id: ['p1'] }, cursor),
    ]);
    const s = section(revoked, 's1');
    expect(s.start.status).toBe('revoked');
    expect(s.start.reasonCode).toBe('sync.scope_revoked');
    expect(s.end.nextCursor).toBe(cursor);
  });
});
