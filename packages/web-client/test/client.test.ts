/**
 * Full loopback integration: two clients syncing through one real B2
 * server (the REVISE tripwire scenario) — push/pull convergence, conflict
 * surfacing (§6.2/§6.5), offline drain + idempotent replay (§2.3/§7.2),
 * rejection handling (§6.3), and the schema-floor stop state (§1.6).
 */
import { describe, expect, test } from 'bun:test';
import { type ClientSchema, ClientSyncError } from '@syncular/client';
import {
  CLIENT_SCHEMA,
  makeClient,
  makeServer,
  PARTITION,
  tableRows,
  taskValues,
} from './helpers';

describe('two clients, one server (tripwire)', () => {
  test('mutation → push → other-client pull converges', async () => {
    const server = makeServer();
    const a = await makeClient(server, { clientId: 'client-a' });
    const b = await makeClient(server, { clientId: 'client-b' });
    a.client.subscribe({
      id: 's1',
      table: 'tasks',
      scopes: { project_id: ['p1'] },
    });
    b.client.subscribe({
      id: 's1',
      table: 'tasks',
      scopes: { project_id: ['p1'] },
    });
    await a.client.syncUntilIdle();
    await b.client.syncUntilIdle();

    a.client.mutate([
      { table: 'tasks', op: 'upsert', values: taskValues('t1', 'p1', 'hello') },
    ]);
    // Optimistic local read before any network round (§7.1).
    expect(tableRows(a.db, 'tasks')).toHaveLength(1);

    const summary = await a.client.sync();
    expect(summary.applied).toHaveLength(1);
    expect(a.client.pendingCommits()).toHaveLength(0);

    await b.client.syncUntilIdle();
    const rows = tableRows(b.db, 'tasks');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe('hello');
    expect(rows[0]?._sync_version).toBe(1);
  });

  test('interleaved upserts and deletes converge in both directions', async () => {
    const server = makeServer();
    const a = await makeClient(server, { clientId: 'client-a' });
    const b = await makeClient(server, { clientId: 'client-b' });
    for (const c of [a, b]) {
      c.client.subscribe({
        id: 's1',
        table: 'tasks',
        scopes: { project_id: ['p1'] },
      });
      await c.client.syncUntilIdle();
    }
    a.client.mutate([
      {
        table: 'tasks',
        op: 'upsert',
        values: taskValues('t1', 'p1', 'from-a'),
      },
      {
        table: 'tasks',
        op: 'upsert',
        values: taskValues('t2', 'p1', 'from-a'),
      },
    ]);
    await a.client.syncUntilIdle();
    await b.client.syncUntilIdle();
    b.client.mutate([
      { table: 'tasks', op: 'delete', rowId: 't1' },
      {
        table: 'tasks',
        op: 'upsert',
        values: taskValues('t3', 'p1', 'from-b'),
      },
    ]);
    await b.client.syncUntilIdle();
    await a.client.syncUntilIdle();

    const aRows = tableRows(a.db, 'tasks');
    const bRows = tableRows(b.db, 'tasks');
    expect(aRows.map((r) => r.id)).toEqual(['t2', 't3']);
    expect(aRows).toEqual(bRows);
  });

  test('a pushing client gets its own changes back in the same round', async () => {
    const server = makeServer();
    const a = await makeClient(server, { clientId: 'client-a' });
    a.client.subscribe({
      id: 's1',
      table: 'tasks',
      scopes: { project_id: ['p1'] },
    });
    await a.client.syncUntilIdle();
    a.client.mutate([
      { table: 'tasks', op: 'upsert', values: taskValues('t1', 'p1') },
    ]);
    const summary = await a.client.sync();
    // §7.2: push and pull ride the same combined request; the commit comes
    // back in the pull half and replaces the optimistic row.
    expect(summary.applied).toHaveLength(1);
    expect(summary.commitsApplied).toBe(1);
    expect(tableRows(a.db, 'tasks')[0]?._sync_version).toBe(1);
  });
});

describe('conflict surfacing (§6.2, §6.5)', () => {
  test('baseVersion conflict surfaces serverVersion + decoded serverRow', async () => {
    const server = makeServer();
    const a = await makeClient(server, { clientId: 'client-a' });
    const b = await makeClient(server, { clientId: 'client-b' });
    for (const c of [a, b]) {
      c.client.subscribe({
        id: 's1',
        table: 'tasks',
        scopes: { project_id: ['p1'] },
      });
    }
    a.client.mutate([
      { table: 'tasks', op: 'upsert', values: taskValues('t1', 'p1', 'v1') },
    ]);
    await a.client.syncUntilIdle();
    await b.client.syncUntilIdle();

    // Both edit from server_version 1; A wins.
    a.client.mutate([
      {
        table: 'tasks',
        op: 'upsert',
        values: taskValues('t1', 'p1', 'a-edit'),
        baseVersion: 1,
      },
    ]);
    await a.client.syncUntilIdle();

    b.client.mutate([
      {
        table: 'tasks',
        op: 'upsert',
        values: taskValues('t1', 'p1', 'b-edit'),
        baseVersion: 1,
      },
    ]);
    const summary = await b.client.sync();
    expect(summary.rejected).toHaveLength(1);
    expect(summary.conflicts).toHaveLength(1);
    const conflict = summary.conflicts[0];
    expect(conflict?.code).toBe('sync.version_conflict');
    expect(conflict?.serverVersion).toBe(2);
    expect(conflict?.serverRow.title).toBe('a-edit');
    expect(conflict?.operation?.op).toBe('upsert');
    // Not auto-resolved: the commit left the outbox, the pull half
    // reconciled the row to server state.
    expect(b.client.pendingCommits()).toHaveLength(0);
    expect(tableRows(b.db, 'tasks')[0]?.title).toBe('a-edit');

    // keep-local resolution (§6.5): explicit overwrite with the new base.
    b.client.mutate([
      {
        table: 'tasks',
        op: 'upsert',
        values: taskValues('t1', 'p1', 'b-edit'),
        baseVersion: conflict?.serverVersion ?? 0,
      },
    ]);
    await b.client.syncUntilIdle();
    await a.client.syncUntilIdle();
    expect(tableRows(a.db, 'tasks')[0]?.title).toBe('b-edit');
    expect(tableRows(a.db, 'tasks')[0]?._sync_version).toBe(3);
  });

  test('lost insert race (baseVersion 0) surfaces the winner row', async () => {
    const server = makeServer();
    const a = await makeClient(server, { clientId: 'client-a' });
    const b = await makeClient(server, { clientId: 'client-b' });
    for (const c of [a, b]) {
      c.client.subscribe({
        id: 's1',
        table: 'tasks',
        scopes: { project_id: ['p1'] },
      });
      await c.client.syncUntilIdle();
    }
    a.client.mutate([
      {
        table: 'tasks',
        op: 'upsert',
        values: taskValues('t9', 'p1', 'a-first'),
        baseVersion: 0,
      },
    ]);
    await a.client.syncUntilIdle();

    b.client.mutate([
      {
        table: 'tasks',
        op: 'upsert',
        values: taskValues('t9', 'p1', 'b-second'),
        baseVersion: 0,
      },
    ]);
    const summary = await b.client.sync();
    const conflict = summary.conflicts[0];
    expect(conflict?.code).toBe('sync.version_conflict');
    expect(conflict?.serverVersion).toBe(1);
    expect(conflict?.serverRow.title).toBe('a-first');
    expect(tableRows(b.db, 'tasks')[0]?.title).toBe('a-first');
  });

  test('sibling operations of a conflicted commit roll back atomically', async () => {
    const server = makeServer();
    const a = await makeClient(server, { clientId: 'client-a' });
    const b = await makeClient(server, { clientId: 'client-b' });
    for (const c of [a, b]) {
      c.client.subscribe({
        id: 's1',
        table: 'tasks',
        scopes: { project_id: ['p1'] },
      });
    }
    a.client.mutate([
      { table: 'tasks', op: 'upsert', values: taskValues('t1', 'p1', 'v1') },
    ]);
    await a.client.syncUntilIdle();
    await b.client.syncUntilIdle();
    a.client.mutate([
      {
        table: 'tasks',
        op: 'upsert',
        values: taskValues('t1', 'p1', 'a-edit'),
        baseVersion: 1,
      },
    ]);
    await a.client.syncUntilIdle();

    // B's commit: a sibling insert plus the conflicting edit — §6.4: the
    // whole commit rolls back; the sibling never lands.
    b.client.mutate([
      {
        table: 'tasks',
        op: 'upsert',
        values: taskValues('t2', 'p1', 'sibling'),
      },
      {
        table: 'tasks',
        op: 'upsert',
        values: taskValues('t1', 'p1', 'b-edit'),
        baseVersion: 1,
      },
    ]);
    await b.client.syncUntilIdle();
    await a.client.syncUntilIdle();
    expect(tableRows(a.db, 'tasks').map((r) => r.id)).toEqual(['t1']);
    expect(tableRows(b.db, 'tasks').map((r) => r.id)).toEqual(['t1']);
  });
});

describe('offline outbox (§7)', () => {
  test('accumulated commits drain FIFO in one combined request', async () => {
    const server = makeServer();
    const a = await makeClient(server, { clientId: 'client-a' });
    a.client.subscribe({
      id: 's1',
      table: 'tasks',
      scopes: { project_id: ['p1'] },
    });
    await a.client.syncUntilIdle();

    a.client.mutate([
      { table: 'tasks', op: 'upsert', values: taskValues('t1', 'p1', 'one') },
    ]);
    a.client.mutate([
      { table: 'tasks', op: 'upsert', values: taskValues('t1', 'p1', 'two') },
    ]);
    a.client.mutate([
      { table: 'tasks', op: 'delete', rowId: 't1' },
      { table: 'tasks', op: 'upsert', values: taskValues('t2', 'p1', 'three') },
    ]);
    expect(a.client.pendingCommits()).toHaveLength(3);
    // Optimistic local state reflects the whole queue.
    expect(tableRows(a.db, 'tasks').map((r) => r.id)).toEqual(['t2']);

    const summary = await a.client.sync();
    expect(summary.pushed).toBe(3);
    expect(summary.applied).toHaveLength(3);
    expect(a.client.pendingCommits()).toHaveLength(0);

    const b = await makeClient(server, { clientId: 'client-b' });
    b.client.subscribe({
      id: 's1',
      table: 'tasks',
      scopes: { project_id: ['p1'] },
    });
    await b.client.syncUntilIdle();
    const rows = tableRows(b.db, 'tasks');
    expect(rows.map((r) => r.id)).toEqual(['t2']);
    expect(rows[0]?.title).toBe('three');
  });

  test('idempotent replay after a lost response: cached drain, no double apply', async () => {
    const server = makeServer();
    const a = await makeClient(server, { clientId: 'client-a' });
    a.client.subscribe({
      id: 's1',
      table: 'tasks',
      scopes: { project_id: ['p1'] },
    });
    await a.client.syncUntilIdle();

    a.client.mutate([
      { table: 'tasks', op: 'upsert', values: taskValues('t1', 'p1') },
    ]);
    a.faults.dropResponseOnce = true;
    await expect(a.client.sync()).rejects.toThrow('simulated response loss');
    // The ack was lost; the outbox keeps the commit (§7.2).
    expect(a.client.pendingCommits()).toHaveLength(1);
    const seqAfterLoss = await server.storage.getMaxCommitSeq(PARTITION);

    const summary = await a.client.sync();
    expect(summary.applied).toHaveLength(1);
    expect(a.client.pendingCommits()).toHaveLength(0);
    // §2.3: replay returned the persisted result — no second commit.
    expect(await server.storage.getMaxCommitSeq(PARTITION)).toBe(seqAfterLoss);
  });

  test('idempotency_cache_miss keeps the commit queued for retry (§6.3)', async () => {
    const server = makeServer();
    const a = await makeClient(server, { clientId: 'client-a' });
    a.client.subscribe({
      id: 's1',
      table: 'tasks',
      scopes: { project_id: ['p1'] },
    });
    await a.client.syncUntilIdle();
    a.client.mutate([
      { table: 'tasks', op: 'upsert', values: taskValues('t1', 'p1') },
    ]);
    server.faults.cacheMissOnce = true;
    const first = await a.client.sync();
    expect(first.retryable).toHaveLength(1);
    expect(first.rejected).toHaveLength(0);
    expect(a.client.pendingCommits()).toHaveLength(1);

    const second = await a.client.sync();
    expect(second.applied).toHaveLength(1);
    expect(a.client.pendingCommits()).toHaveLength(0);
  });

  test('a forbidden write is rejected, surfaced, and dropped', async () => {
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
      scopes: { project_id: ['p1'] },
    });
    await a.client.syncUntilIdle();
    a.client.mutate([
      { table: 'tasks', op: 'upsert', values: taskValues('tx', 'p9', 'nope') },
    ]);
    const summary = await a.client.sync();
    expect(summary.rejected).toHaveLength(1);
    expect(a.client.rejections[0]?.code).toBe('sync.forbidden');
    expect(a.client.pendingCommits()).toHaveLength(0);
  });
});

describe('schema floor (§1.6)', () => {
  test('requiredSchemaVersion stops syncing and surfaces the floor', async () => {
    const server = makeServer();
    const futureSchema: ClientSchema = { ...CLIENT_SCHEMA, version: 2 };
    const a = await makeClient(server, {
      clientId: 'client-a',
      schema: futureSchema,
    });
    a.client.subscribe({
      id: 's1',
      table: 'tasks',
      scopes: { project_id: ['p1'] },
    });
    a.client.mutate([
      { table: 'tasks', op: 'upsert', values: taskValues('t1', 'p1') },
    ]);
    const summary = await a.client.sync();
    expect(summary.schemaFloor).toEqual({
      requiredSchemaVersion: 1,
      latestSchemaVersion: 1,
    });
    expect(a.client.stopped).toBe(true);
    // §1.6: nothing was processed — the push commit stays queued.
    expect(a.client.pendingCommits()).toHaveLength(1);

    // Further syncs are local no-ops while stopped.
    const again = await a.client.sync();
    expect(again.pushed).toBe(0);
    expect(again.schemaFloor?.requiredSchemaVersion).toBe(1);
  });

  test('a client mid-conversation keeps working at the served version', async () => {
    const server = makeServer();
    const a = await makeClient(server, { clientId: 'client-a' });
    a.client.subscribe({
      id: 's1',
      table: 'tasks',
      scopes: { project_id: ['p1'] },
    });
    await a.client.syncUntilIdle();
    expect(a.client.stopped).toBe(false);
    expect(a.client.schemaFloor).toBeUndefined();
  });
});

describe('sync loop discipline', () => {
  test('concurrent sync() calls are rejected — one loop owns the database', async () => {
    const server = makeServer();
    const a = await makeClient(server, { clientId: 'client-a' });
    a.client.subscribe({
      id: 's1',
      table: 'tasks',
      scopes: { project_id: ['p1'] },
    });
    const first = a.client.sync();
    await expect(a.client.sync()).rejects.toBeInstanceOf(ClientSyncError);
    await first;
  });
});
