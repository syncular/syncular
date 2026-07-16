/**
 * Full loopback integration: two clients syncing through one real B2
 * server (the REVISE tripwire scenario) — push/pull convergence, conflict
 * surfacing (§6.2/§6.5), offline drain + idempotent replay (§2.3/§7.2),
 * rejection handling (§6.3), and the schema-floor stop state (§1.6).
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ClientSchema, ClientSyncError } from '@syncular/client';
import { ValidationRejection } from '@syncular/server';
import {
  CLIENT_SCHEMA,
  makeClient,
  makeServer,
  PARTITION,
  TASK_COLUMNS,
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

describe('durable commit outcomes', () => {
  test('journals the final result atomically with outbox drain and survives restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'syncular-outcomes-'));
    const databasePath = join(directory, 'client.db');
    const server = makeServer();
    try {
      const first = await makeClient(server, {
        clientId: 'durable-client',
        databasePath,
      });
      first.client.subscribe({
        id: 's1',
        table: 'tasks',
        scopes: { project_id: ['durable'] },
      });
      const clientCommitId = first.client.mutate([
        {
          table: 'tasks',
          op: 'upsert',
          values: taskValues('durable-1', 'durable', 'persisted'),
        },
      ]);
      await first.client.syncUntilIdle();
      expect(first.client.pendingCommits()).toHaveLength(0);
      expect(first.client.commitOutcome(clientCommitId)).toMatchObject({
        clientCommitId,
        status: 'applied',
        resolution: 'active',
        results: [{ status: 'applied', opIndex: 0 }],
      });
      await first.client.close();
      first.db.close();

      const reopened = await makeClient(server, {
        clientId: 'durable-client',
        databasePath,
      });
      expect(reopened.client.pendingCommits()).toHaveLength(0);
      expect(reopened.client.commitOutcome(clientCommitId)).toMatchObject({
        status: 'applied',
        results: [{ status: 'applied', opIndex: 0 }],
      });
      await reopened.client.close();
      reopened.db.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('restores exact conflict evidence and its one-way resolution lifecycle', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'syncular-conflict-'));
    const databasePath = join(directory, 'loser.db');
    const server = makeServer();
    try {
      const winner = await makeClient(server, { clientId: 'winner' });
      const loser = await makeClient(server, {
        clientId: 'loser',
        databasePath,
      });
      for (const entry of [winner, loser]) {
        entry.client.subscribe({
          id: 's1',
          table: 'tasks',
          scopes: { project_id: ['conflict'] },
        });
      }
      winner.client.mutate([
        {
          table: 'tasks',
          op: 'upsert',
          values: taskValues('conflict-1', 'conflict', 'base'),
        },
      ]);
      await winner.client.syncUntilIdle();
      await loser.client.syncUntilIdle();
      winner.client.mutate([
        {
          table: 'tasks',
          op: 'upsert',
          values: taskValues('conflict-1', 'conflict', 'winner'),
          baseVersion: 1,
        },
      ]);
      await winner.client.syncUntilIdle();
      const losingCommitId = loser.client.patch(
        'tasks',
        'conflict-1',
        { title: 'loser' },
        { baseVersion: 1 },
      );
      await loser.client.syncUntilIdle();

      const outcome = loser.client.commitOutcome(losingCommitId);
      expect(outcome).toMatchObject({
        status: 'conflict',
        resolution: 'active',
        results: [
          {
            status: 'conflict',
            conflict: {
              clientCommitId: losingCommitId,
              opIndex: 0,
              table: 'tasks',
              rowId: 'conflict-1',
              code: 'sync.version_conflict',
              serverVersion: 2,
              serverRow: { title: 'winner' },
              operation: {
                op: 'upsert',
                rowId: 'conflict-1',
                baseVersion: 1,
                changedFields: ['title'],
              },
            },
          },
        ],
      });
      await loser.client.close();
      loser.db.close();

      const reopened = await makeClient(server, {
        clientId: 'loser',
        databasePath,
      });
      expect(reopened.client.conflicts).toHaveLength(1);
      expect(reopened.client.conflicts[0]?.serverRow.title).toBe('winner');
      expect(reopened.client.conflicts[0]?.operation?.changedFields).toEqual([
        'title',
      ]);
      const resolved = reopened.client.resolveCommitOutcome({
        clientCommitId: losingCommitId,
        resolution: 'resolved_keep_server',
      });
      expect(resolved.resolution).toBe('resolved_keep_server');
      expect(reopened.client.conflicts).toHaveLength(0);
      // Resolution is one-way and idempotent; a later choice cannot rewrite it.
      expect(
        reopened.client.resolveCommitOutcome({
          clientCommitId: losingCommitId,
          resolution: 'superseded',
          replacementClientCommitId: 'replacement',
        }),
      ).toEqual(resolved);
      await reopened.client.close();
      reopened.db.close();

      const twice = await makeClient(server, {
        clientId: 'loser',
        databasePath,
      });
      expect(twice.client.conflicts).toHaveLength(0);
      expect(twice.client.commitOutcome(losingCommitId)?.resolution).toBe(
        'resolved_keep_server',
      );
      await twice.client.close();
      twice.db.close();
      await winner.client.close();
      winner.db.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('retention never purges unresolved failures and records replacement links', async () => {
    const server = makeServer();
    const winner = await makeClient(server, { clientId: 'retention-winner' });
    const loser = await makeClient(server, {
      clientId: 'retention-loser',
      limits: { outcomeRetentionMaxEntries: 1 },
    });
    for (const entry of [winner, loser]) {
      entry.client.subscribe({
        id: 's1',
        table: 'tasks',
        scopes: { project_id: ['retention'] },
      });
    }
    winner.client.mutate([
      {
        table: 'tasks',
        op: 'upsert',
        values: taskValues('retention-1', 'retention', 'base'),
      },
    ]);
    await winner.client.syncUntilIdle();
    await loser.client.syncUntilIdle();
    winner.client.patch(
      'tasks',
      'retention-1',
      { title: 'winner' },
      {
        baseVersion: 1,
      },
    );
    await winner.client.syncUntilIdle();
    const conflictId = loser.client.patch(
      'tasks',
      'retention-1',
      { title: 'loser' },
      { baseVersion: 1 },
    );
    await loser.client.syncUntilIdle();
    const appliedId = loser.client.mutate([
      {
        table: 'tasks',
        op: 'upsert',
        values: taskValues('retention-2', 'retention', 'applied'),
      },
    ]);
    await loser.client.syncUntilIdle();
    expect(loser.client.commitOutcome(conflictId)?.status).toBe('conflict');
    expect(loser.client.commitOutcome(appliedId)).toBeUndefined();

    const replacementId = loser.client.patch(
      'tasks',
      'retention-1',
      { title: 'replacement' },
      { baseVersion: 2 },
    );
    const resolved = loser.client.resolveCommitOutcome({
      clientCommitId: conflictId,
      resolution: 'superseded',
      replacementClientCommitId: replacementId,
    });
    expect(resolved.replacementClientCommitId).toBe(replacementId);
    await winner.client.close();
    winner.db.close();
    await loser.client.close();
    loser.db.close();
  });

  test('retains the complete failed aggregate envelope across restart', async () => {
    const directory = mkdtempSync(
      join(tmpdir(), 'syncular-aggregate-outcome-'),
    );
    const databasePath = join(directory, 'loser.db');
    const server = makeServer();
    try {
      const winner = await makeClient(server, { clientId: 'aggregate-winner' });
      const loser = await makeClient(server, {
        clientId: 'aggregate-loser',
        databasePath,
      });
      for (const entry of [winner, loser]) {
        entry.client.subscribe({
          id: 's1',
          table: 'tasks',
          scopes: { project_id: ['aggregate'] },
        });
      }
      winner.client.mutate([
        {
          table: 'tasks',
          op: 'upsert',
          values: taskValues('aggregate-root', 'aggregate', 'base'),
        },
      ]);
      await winner.client.syncUntilIdle();
      await loser.client.syncUntilIdle();
      winner.client.mutate([
        {
          table: 'tasks',
          op: 'upsert',
          values: taskValues('aggregate-root', 'aggregate', 'winner'),
          baseVersion: 1,
        },
      ]);
      await winner.client.syncUntilIdle();

      const losingCommitId = loser.client.mutate([
        {
          table: 'tasks',
          op: 'upsert',
          values: taskValues('aggregate-root', 'aggregate', 'loser'),
          baseVersion: 1,
        },
        {
          table: 'tasks',
          op: 'upsert',
          values: taskValues('aggregate-child', 'aggregate', 'sibling intent'),
          baseVersion: 0,
        },
      ]);
      await loser.client.syncUntilIdle();
      expect(loser.client.commitOutcome(losingCommitId)).toMatchObject({
        status: 'conflict',
        results: [{ status: 'conflict' }],
        operations: [
          { rowId: 'aggregate-root', baseVersion: 1 },
          { rowId: 'aggregate-child', baseVersion: 0 },
        ],
      });
      await loser.client.close();
      loser.db.close();

      const reopened = await makeClient(server, {
        clientId: 'aggregate-loser',
        databasePath,
      });
      expect(
        reopened.client.commitOutcome(losingCommitId)?.operations,
      ).toMatchObject([
        { table: 'tasks', rowId: 'aggregate-root', op: 'upsert' },
        { table: 'tasks', rowId: 'aggregate-child', op: 'upsert' },
      ]);
      await reopened.client.close();
      reopened.db.close();
      await winner.client.close();
      winner.db.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('structured rejection details and patch intent survive restart', async () => {
    const directory = mkdtempSync(
      join(tmpdir(), 'syncular-rejection-details-'),
    );
    const databasePath = join(directory, 'client.db');
    const server = makeServer(CLIENT_SCHEMA, {
      validators: {
        tasks: (operation) => {
          if (operation.row?.title === 'invalid') {
            throw new ValidationRejection(
              'app.invalid_title',
              'diagnostic only',
              {
                fieldPaths: ['title'],
                reason: 'invalid_value',
                requiredAction: 'edit_fields',
                references: { task_id: operation.rowId },
              },
            );
          }
        },
      },
    });
    try {
      const first = await makeClient(server, {
        clientId: 'rejection-details',
        databasePath,
      });
      first.client.subscribe({
        id: 's1',
        table: 'tasks',
        scopes: { project_id: ['details'] },
      });
      first.client.mutate([
        {
          table: 'tasks',
          op: 'upsert',
          values: taskValues('details-1', 'details', 'valid'),
        },
      ]);
      await first.client.syncUntilIdle();
      const rejectedId = first.client.patch(
        'tasks',
        'details-1',
        { title: 'invalid' },
        { baseVersion: 1 },
      );
      await first.client.syncUntilIdle();
      expect(first.client.commitOutcome(rejectedId)).toMatchObject({
        status: 'rejected',
        results: [
          {
            status: 'error',
            rejection: {
              code: 'app.invalid_title',
              details: {
                fieldPaths: ['title'],
                reason: 'invalid_value',
                requiredAction: 'edit_fields',
                references: { task_id: 'details-1' },
              },
              operation: { changedFields: ['title'] },
            },
          },
        ],
      });
      await first.client.close();
      first.db.close();

      const reopened = await makeClient(server, {
        clientId: 'rejection-details',
        databasePath,
      });
      expect(reopened.client.rejections[0]).toMatchObject({
        clientCommitId: rejectedId,
        details: { fieldPaths: ['title'], requiredAction: 'edit_fields' },
        operation: { changedFields: ['title'] },
      });
      await reopened.client.close();
      reopened.db.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('validator rejection restores updates, deletes, aggregate siblings, and downstream overlays', async () => {
    const server = makeServer(CLIENT_SCHEMA, {
      validators: {
        tasks: (operation) => {
          if (
            operation.op === 'delete' ||
            String(operation.row?.title ?? '').startsWith('invalid')
          ) {
            throw new ValidationRejection(
              'app.invalid_change',
              'diagnostic only',
            );
          }
        },
      },
    });
    const client = await makeClient(server, { clientId: 'rollback-client' });
    client.client.subscribe({
      id: 'rollback-tasks',
      table: 'tasks',
      scopes: { project_id: ['rollback'] },
    });
    client.client.mutate([
      {
        table: 'tasks',
        op: 'upsert',
        values: taskValues('rollback-root', 'rollback', 'accepted'),
      },
    ]);
    await client.client.syncUntilIdle();

    const firstRejected = client.client.patch(
      'tasks',
      'rollback-root',
      { title: 'invalid-first' },
      { baseVersion: 1 },
    );
    const secondRejected = client.client.patch(
      'tasks',
      'rollback-root',
      { title: 'invalid-second' },
      { baseVersion: 1 },
    );
    expect(tableRows(client.db, 'tasks')[0]?.title).toBe('invalid-second');
    await client.client.syncUntilIdle();
    expect(client.client.commitOutcome(firstRejected)?.status).toBe('rejected');
    expect(client.client.commitOutcome(secondRejected)?.status).toBe(
      'rejected',
    );
    expect(tableRows(client.db, 'tasks')[0]).toMatchObject({
      title: 'accepted',
      _sync_version: 1,
    });

    const aggregateRejected = client.client.mutate([
      {
        table: 'tasks',
        op: 'upsert',
        values: taskValues('rollback-sibling', 'rollback', 'sibling'),
        baseVersion: 0,
      },
      {
        table: 'tasks',
        op: 'upsert',
        values: taskValues('rollback-root', 'rollback', 'invalid-aggregate'),
        baseVersion: 1,
      },
    ]);
    await client.client.syncUntilIdle();
    expect(client.client.commitOutcome(aggregateRejected)).toMatchObject({
      status: 'rejected',
      operations: [{ rowId: 'rollback-sibling' }, { rowId: 'rollback-root' }],
    });
    expect(tableRows(client.db, 'tasks').map((row) => row.id)).toEqual([
      'rollback-root',
    ]);
    expect(tableRows(client.db, 'tasks')[0]?.title).toBe('accepted');

    const deleteRejected = client.client.mutate([
      {
        table: 'tasks',
        op: 'delete',
        rowId: 'rollback-root',
        baseVersion: 1,
      },
    ]);
    expect(tableRows(client.db, 'tasks')).toHaveLength(0);
    await client.client.syncUntilIdle();
    expect(client.client.commitOutcome(deleteRejected)?.status).toBe(
      'rejected',
    );
    expect(tableRows(client.db, 'tasks')[0]).toMatchObject({
      id: 'rollback-root',
      title: 'accepted',
      _sync_version: 1,
    });
    expect(
      client.db.query('SELECT * FROM _syncular_outbox_before_images'),
    ).toHaveLength(0);
  });

  test('rollback before-images survive restart without entering the public failed envelope', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'syncular-rollback-image-'));
    const databasePath = join(directory, 'client.db');
    const server = makeServer(CLIENT_SCHEMA, {
      validators: {
        tasks: (operation) => {
          if (operation.row?.title === 'invalid-after-restart') {
            throw new ValidationRejection(
              'app.invalid_change',
              'diagnostic only',
            );
          }
        },
      },
    });
    try {
      const first = await makeClient(server, {
        clientId: 'restart-rollback-client',
        databasePath,
      });
      first.client.subscribe({
        id: 'restart-rollback-tasks',
        table: 'tasks',
        scopes: { project_id: ['restart-rollback'] },
      });
      first.client.mutate([
        {
          table: 'tasks',
          op: 'upsert',
          values: taskValues('restart-root', 'restart-rollback', 'accepted'),
        },
      ]);
      await first.client.syncUntilIdle();
      const rejectedId = first.client.patch(
        'tasks',
        'restart-root',
        { title: 'invalid-after-restart' },
        { baseVersion: 1 },
      );
      expect(
        first.db.query('SELECT * FROM _syncular_outbox_before_images'),
      ).toHaveLength(1);
      await first.client.close();
      first.db.close();

      const reopened = await makeClient(server, {
        clientId: 'restart-rollback-client',
        databasePath,
      });
      await reopened.client.syncUntilIdle();
      expect(tableRows(reopened.db, 'tasks')[0]).toMatchObject({
        title: 'accepted',
        _sync_version: 1,
      });
      expect(reopened.client.commitOutcome(rejectedId)).toMatchObject({
        status: 'rejected',
        operations: [
          {
            rowId: 'restart-root',
            values: { title: 'invalid-after-restart' },
          },
        ],
      });
      expect(
        JSON.stringify(reopened.client.commitOutcome(rejectedId)),
      ).not.toContain('values_json');
      await reopened.client.close();
      reopened.db.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
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
  test('a schema bump adds an indexed column before any new index DDL runs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncular-indexed-column-bump-'));
    const databasePath = join(dir, 'client.sqlite');
    const server = makeServer();
    try {
      const first = await makeClient(server, {
        clientId: 'schema-bump-client',
        databasePath,
      });
      await first.client.close();
      first.db.close();

      const upgradedSchema: ClientSchema = {
        version: 2,
        tables: CLIENT_SCHEMA.tables.map((table) =>
          table.name === 'tasks'
            ? {
                ...table,
                columns: [
                  ...TASK_COLUMNS,
                  {
                    name: 'facility_membership_id',
                    type: 'string' as const,
                    nullable: true,
                  },
                ],
                indexes: [
                  {
                    name: 'tasks_by_membership',
                    columns: ['project_id', 'facility_membership_id'],
                    unique: false,
                  },
                ],
              }
            : table,
        ),
      };
      const reopened = await makeClient(server, {
        clientId: 'schema-bump-client',
        databasePath,
        schema: upgradedSchema,
      });
      expect(
        reopened.db
          .query('PRAGMA table_info("tasks")')
          .map((column) => column.name),
      ).toContain('facility_membership_id');
      expect(
        reopened.db.query(
          `SELECT name FROM sqlite_master
             WHERE type = 'index' AND name = 'tasks_by_membership'`,
        ),
      ).toEqual([{ name: 'tasks_by_membership' }]);
      await reopened.client.close();
      reopened.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

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

describe('the SELECT * → mutate round trip (RFC 0002 §2.1)', () => {
  test('query() strips _sync_* columns; explicit aliases pass through', async () => {
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

    const rows = a.client.query('SELECT * FROM tasks');
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0] ?? {})).not.toContain('_sync_version');
    expect(rows[0]?.title).toBe('task');
    // The raw database tier keeps the column (engine internals need it).
    expect(tableRows(a.db, 'tasks')[0]?._sync_version).toBe(1);
    // An explicit alias reads it on purpose.
    const aliased = a.client.query('SELECT _sync_version AS v FROM tasks');
    expect(aliased[0]?.v).toBe(1);
  });

  test('a stray _sync_* key in mutation values fails with the SELECT * hint', async () => {
    const server = makeServer();
    const a = await makeClient(server, { clientId: 'client-a' });
    expect(() =>
      a.client.mutate([
        {
          table: 'tasks',
          op: 'upsert',
          values: { ...taskValues('t1', 'p1'), _sync_version: 1 },
        },
      ]),
    ).toThrow(/internal sync column/);
  });

  test('a SELECT * row round-trips into mutate() unchanged', async () => {
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
    const row = a.client.query('SELECT * FROM tasks')[0] ?? {};
    a.client.mutate([
      { table: 'tasks', op: 'upsert', values: { ...row, title: 'renamed' } },
    ]);
    await a.client.syncUntilIdle();
    expect(a.client.query('SELECT title FROM tasks')[0]?.title).toBe('renamed');
  });

  test('patch() merges a partial over the current row and converges', async () => {
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
      {
        table: 'tasks',
        op: 'upsert',
        values: taskValues('t1', 'p1', 'keep-me', false, 3),
      },
    ]);
    await a.client.syncUntilIdle();

    // camelCase keys follow the same two-casing rule as mutate values.
    a.client.patch('tasks', 't1', { done: true });
    const local = tableRows(a.db, 'tasks')[0];
    expect(local?.done).toBe(1);
    expect(local?.title).toBe('keep-me');
    expect(local?.priority).toBe(3);

    await a.client.syncUntilIdle();
    await b.client.syncUntilIdle();
    const remote = tableRows(b.db, 'tasks')[0];
    expect(remote?.done).toBe(1);
    expect(remote?.title).toBe('keep-me');
  });

  test('patch() of an absent row fails loud', async () => {
    const server = makeServer();
    const a = await makeClient(server, { clientId: 'client-a' });
    expect(() => a.client.patch('tasks', 'missing', { done: true })).toThrow(
      /no local row/,
    );
  });
});
