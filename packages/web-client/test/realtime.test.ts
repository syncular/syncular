/**
 * Realtime client side (§8) against the server's RealtimeHub over the
 * loopback socket seam: hello, binary deltas applied like pull responses
 * with post-apply acks, and wake-up → coalesced catch-up pull.
 */
import { describe, expect, test } from 'bun:test';
import {
  makeClient,
  makeServer,
  PARTITION,
  tableRows,
  taskValues,
  waitFor,
} from './helpers';

describe('handshake (§8.1)', () => {
  test('hello with requiresSync flags a pull; a caught-up client is quiet', async () => {
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
    await b.client.syncUntilIdle();
    await b.client.connectRealtime();
    // Caught up at connect: no sync needed.
    expect(b.client.syncNeeded).toBe(false);
    expect(b.wakes).toHaveLength(0);
    b.client.disconnectRealtime();

    // A advances the log while B is offline; reconnect demands a pull.
    a.client.mutate([
      { table: 'tasks', op: 'upsert', values: taskValues('t1', 'p1') },
    ]);
    await a.client.syncUntilIdle();
    await b.client.connectRealtime();
    expect(b.client.syncNeeded).toBe(true);
    expect(b.wakes).toEqual(['hello']);
  });
});

describe('deltas (§8.2)', () => {
  test('a pushed commit arrives as a binary delta, applies, and acks', async () => {
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
    await b.client.connectRealtime();
    expect(b.client.syncNeeded).toBe(false);

    a.client.mutate([
      {
        table: 'tasks',
        op: 'upsert',
        values: taskValues('t1', 'p1', 'via-delta'),
      },
    ]);
    await a.client.syncUntilIdle();

    // No pull on B: the delta alone must land the row.
    await waitFor(() => tableRows(b.db, 'tasks').length === 1, 'delta applied');
    expect(tableRows(b.db, 'tasks')[0]?.title).toBe('via-delta');
    expect(tableRows(b.db, 'tasks')[0]?._sync_version).toBe(1);

    // The cursor advanced through SUB_END, and the post-apply ack reached
    // the server's client record (§8.2: acks update it without a pull).
    const seq = await server.storage.getMaxCommitSeq(PARTITION);
    expect(b.client.subscription('s1')?.cursor).toBe(seq);
    await waitFor(async () => {
      const record = await server.storage.getClientRecord(
        PARTITION,
        'client-b',
      );
      return record?.cursor === seq;
    }, 'ack persisted');
  });

  test('deltas keep flowing commit by commit', async () => {
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
    await b.client.connectRealtime();
    for (let i = 0; i < 3; i++) {
      a.client.mutate([
        { table: 'tasks', op: 'upsert', values: taskValues(`t${i}`, 'p1') },
      ]);
      await a.client.syncUntilIdle();
    }
    await waitFor(() => tableRows(b.db, 'tasks').length === 3, 'all deltas');
    expect(b.client.syncNeeded).toBe(false);
  });

  test('scope-filtered deltas: unrelated commits do not reach the client', async () => {
    const server = makeServer();
    const a = await makeClient(server, { clientId: 'client-a' });
    const b = await makeClient(server, { clientId: 'client-b' });
    a.client.subscribe({
      id: 's1',
      table: 'tasks',
      scopes: { project_id: ['p1', 'p2'] },
    });
    b.client.subscribe({
      id: 's1',
      table: 'tasks',
      scopes: { project_id: ['p1'] },
    });
    await a.client.syncUntilIdle();
    await b.client.syncUntilIdle();
    await b.client.connectRealtime();

    a.client.mutate([
      { table: 'tasks', op: 'upsert', values: taskValues('other', 'p2') },
    ]);
    a.client.mutate([
      { table: 'tasks', op: 'upsert', values: taskValues('mine', 'p1') },
    ]);
    await a.client.syncUntilIdle();
    await waitFor(() => tableRows(b.db, 'tasks').length === 1, 'scoped delta');
    expect(tableRows(b.db, 'tasks')[0]?.id).toBe('mine');
  });
});

describe('wake-ups and catch-up (§8.3, §8.4)', () => {
  test('a behind session gets catchup-required; the pull re-arms deltas', async () => {
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
    // B connects while already behind → wakePending on the session.
    a.client.mutate([
      { table: 'tasks', op: 'upsert', values: taskValues('t1', 'p1') },
    ]);
    await a.client.syncUntilIdle();
    await b.client.connectRealtime();
    expect(b.client.syncNeeded).toBe(true); // hello.requiresSync

    // While behind, a matching commit becomes a coalescible wake-up, not a
    // delta (§8.2: deltas must be cursor-contiguous).
    a.client.mutate([
      { table: 'tasks', op: 'upsert', values: taskValues('t2', 'p1') },
    ]);
    await a.client.syncUntilIdle();
    await waitFor(() => b.wakes.includes('catchup-required'), 'wake-up');
    expect(tableRows(b.db, 'tasks')).toHaveLength(0);

    // The recovery pull converges and acks; deltas then resume.
    await b.client.syncUntilIdle();
    expect(tableRows(b.db, 'tasks')).toHaveLength(2);
    expect(b.client.syncNeeded).toBe(false);

    a.client.mutate([
      {
        table: 'tasks',
        op: 'upsert',
        values: taskValues('t3', 'p1', 'resumed'),
      },
    ]);
    await a.client.syncUntilIdle();
    await waitFor(() => tableRows(b.db, 'tasks').length === 3, 'delta resumed');
    expect(tableRows(b.db, 'tasks')[2]?.title).toBe('resumed');
  });

  test('a broadcast reset-required wake-up flags a pull (§8.3)', async () => {
    const server = makeServer();
    const b = await makeClient(server, { clientId: 'client-b' });
    b.client.subscribe({
      id: 's1',
      table: 'tasks',
      scopes: { project_id: ['p1'] },
    });
    await b.client.syncUntilIdle();
    await b.client.connectRealtime();
    server.hub.wake(PARTITION, 'reset-required');
    expect(b.client.syncNeeded).toBe(true);
    expect(b.wakes).toContain('reset-required');
    // §8.3: a wake-up is never data — recovery is a pull.
    await b.client.syncUntilIdle();
    expect(b.client.syncNeeded).toBe(false);
  });
});
