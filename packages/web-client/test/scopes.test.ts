/**
 * Effective-scope persistence and the §3.3 revocation purge contract:
 * purge is keyed on the LAST-echoed effective scopes (not the requested
 * map), doomed outbox writes are dropped, unrelated scopes survive, and a
 * missing local scope-column mapping fails closed.
 */
import { describe, expect, test } from 'bun:test';
import type { ClientSchema } from '@syncular/client';
import {
  DOC_COLUMNS,
  makeClient,
  makeServer,
  TASK_COLUMNS,
  tableRows,
  taskValues,
} from './helpers';

describe('effective-scope echo persistence (§3.2, §3.3)', () => {
  test('the persisted effective scopes are the intersection, not the request', async () => {
    const server = makeServer();
    server.allowed['actor-1'] = {
      project_id: ['p1'],
      projectId: ['p1'],
      org_id: ['o1'],
    };
    const a = await makeClient(server, { clientId: 'client-a' });
    a.client.subscribe({
      id: 's1',
      table: 'tasks',
      scopes: { project_id: ['p1', 'p2'] },
    });
    await a.client.syncUntilIdle();
    // Requested [p1, p2] ∩ allowed [p1] = [p1] (§3.2 rule 4).
    expect(a.client.subscription('s1')?.effectiveScopes).toEqual({
      project_id: ['p1'],
    });
  });

  test('the echo refreshes on every active pull', async () => {
    const server = makeServer();
    server.allowed['actor-1'] = {
      project_id: ['p1'],
      projectId: ['p1'],
      org_id: ['o1'],
    };
    const a = await makeClient(server, { clientId: 'client-a' });
    a.client.subscribe({
      id: 's1',
      table: 'tasks',
      scopes: { project_id: ['p1', 'p2'] },
    });
    await a.client.syncUntilIdle();
    server.allowed['actor-1'] = {
      project_id: ['p1', 'p2'],
      projectId: ['p1'],
      org_id: ['o1'],
    };
    await a.client.sync();
    expect(a.client.subscription('s1')?.effectiveScopes).toEqual({
      project_id: ['p1', 'p2'],
    });
  });
});

describe('revocation purge (§3.3)', () => {
  test('purges exactly the last-effective rows and stops pulling', async () => {
    const server = makeServer();
    server.allowed['actor-1'] = {
      project_id: ['p1'],
      projectId: ['p1'],
      org_id: ['o1'],
    };
    const a = await makeClient(server, { clientId: 'client-a' });
    a.client.subscribe({
      id: 's1',
      table: 'tasks',
      // p2 is requested but never becomes effective (§3.3: not purged).
      scopes: { project_id: ['p1', 'p2'] },
    });
    a.client.mutate([
      {
        table: 'tasks',
        op: 'upsert',
        values: taskValues('t1', 'p1', 'synced'),
      },
    ]);
    await a.client.syncUntilIdle();
    // Local-only rows: one inside the subscribed table but in p2 (never
    // effective), one in a different table entirely.
    a.db.exec(
      `INSERT INTO "tasks" (id, project_id, title, done, priority, meta, _sync_version)
       VALUES ('local-p2', 'p2', 'local only', 0, NULL, NULL, 0)`,
    );
    a.db.exec(
      `INSERT INTO "docs" (id, org_id, project_id, body, _sync_version)
       VALUES ('d1', 'o1', 'p1', 'doc body', 0)`,
    );
    // Pending outbox commits at revocation time: one into the revoked
    // scope (guaranteed rejection), one into a still-held scope.
    a.client.mutate([
      {
        table: 'tasks',
        op: 'upsert',
        values: taskValues('t2', 'p1', 'doomed'),
      },
    ]);
    const keptCommit = a.client.mutate([
      { table: 'tasks', op: 'upsert', values: taskValues('t3', 'p3', 'kept') },
    ]);

    // The host re-homes the actor to p3 only: [p1,p2] ∩ [p3] = ∅ → revoked.
    server.allowed['actor-1'] = {
      project_id: ['p3'],
      projectId: ['p1'],
      org_id: ['o1'],
    };
    const summary = await a.client.sync();
    expect(summary.revoked).toEqual(['s1']);
    // The doomed commit was rejected by write-path authorization (§3.4)
    // in the same combined request; the p3 commit applied.
    expect(summary.rejected).toHaveLength(1);
    expect(summary.applied).toEqual([keptCommit]);
    expect(a.client.rejections[0]?.code).toBe('sync.forbidden');
    expect(a.client.pendingCommits()).toHaveLength(0);

    const sub = a.client.subscription('s1');
    expect(sub?.status).toBe('revoked');
    expect(sub?.reasonCode).toBe('sync.scope_revoked');
    expect(a.client.diagnosticsSnapshot().subscriptions[0]).toMatchObject({
      id: 's1',
      state: 'revoked',
      complete: false,
      reasonCode: 'sync.scope_revoked',
    });

    const ids = tableRows(a.db, 'tasks').map((r) => r.id);
    expect(ids).not.toContain('t1'); // purged: matches effective p1
    expect(ids).toContain('local-p2'); // requested-but-never-effective survives
    expect(ids).toContain('t3'); // the applied p3 row is not the purge's to destroy
    expect(tableRows(a.db, 'docs')).toHaveLength(1); // other table untouched

    // The subscription is no longer pulled.
    const next = await a.client.sync();
    expect(next.revoked).toHaveLength(0);
    expect(a.client.subscription('s1')?.status).toBe('revoked');
  });

  test('a throwing resolver revokes (fail loud, §3.2 rule 5)', async () => {
    const server = makeServer();
    const a = await makeClient(server, { clientId: 'client-a' });
    a.client.subscribe({
      id: 's1',
      table: 'tasks',
      scopes: { project_id: ['p1'] },
    });
    a.client.mutate([
      { table: 'tasks', op: 'upsert', values: taskValues('t1', 'p1') },
    ]);
    await a.client.syncUntilIdle();
    server.resolverError.value = true;
    const summary = await a.client.sync();
    expect(summary.revoked).toEqual(['s1']);
    expect(tableRows(a.db, 'tasks')).toHaveLength(0);
  });

  test('fails closed when the table has no local mapping for an effective key', async () => {
    const server = makeServer();
    // A (mis)generated client schema whose tasks table maps variable
    // `proj`, so the echoed `project_id` key has no local column mapping.
    const mismatchedSchema: ClientSchema = {
      version: 1,
      tables: [
        {
          name: 'tasks',
          columns: TASK_COLUMNS,
          primaryKey: 'id',
          scopes: [{ pattern: 'project:{proj}', column: 'project_id' }],
        },
        {
          name: 'docs',
          columns: DOC_COLUMNS,
          primaryKey: 'id',
          scopes: ['org:{org_id}'],
        },
      ],
    };
    const a = await makeClient(server, {
      clientId: 'client-a',
      schema: mismatchedSchema,
    });
    a.client.subscribe({
      id: 's1',
      table: 'tasks',
      scopes: { project_id: ['p1'] },
    });
    a.client.mutate([
      { table: 'tasks', op: 'upsert', values: taskValues('t1', 'p1') },
    ]);
    // The very first fresh bootstrap already needs the mapping (§5.6 uses
    // the §3.3 matching rule) — it fails closed immediately.
    const summary = await a.client.sync();
    expect(summary.applied).toHaveLength(1); // the push half still worked
    expect(summary.failed).toEqual(['s1']);
    // Precision or nothing: the table is NOT cleared as an approximation.
    expect(tableRows(a.db, 'tasks')).toHaveLength(1);
    const sub = a.client.subscription('s1');
    expect(sub?.status).toBe('failed');
    expect(sub?.reasonCode).toBe('sync.scope_revoked');
    expect(sub?.cursor).toBe(-1); // SUB_END was never persisted (§1.4)
    expect(a.client.diagnosticsSnapshot().subscriptions[0]).toMatchObject({
      id: 's1',
      state: 'failed',
      complete: false,
      reasonCode: 'sync.scope_revoked',
    });

    // The table is no longer synced.
    const next = await a.client.sync();
    expect(next.failed).toHaveLength(0);
    expect(a.client.subscription('s1')?.status).toBe('failed');
  });
});
