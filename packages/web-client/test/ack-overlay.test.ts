import { expect, test } from 'bun:test';
import { BunClientDatabase } from '@syncular/client/bun';
import type { SqlRow, SqlValue } from '@syncular/client';
import { makeClient, makeServer, taskValues } from './helpers';

class OverlayCountingDatabase extends BunClientDatabase {
  restores = 0;
  replays = 0;
  journalRows = 0;

  override exec(sql: string, params: readonly SqlValue[] = []): void {
    super.exec(sql, params);
    if (sql.startsWith('DELETE FROM "tasks"'))
      this.restores += Number(super.query('SELECT changes() AS n')[0]?.n);
    if (sql.startsWith('INSERT INTO "tasks"'))
      this.replays += Number(super.query('SELECT changes() AS n')[0]?.n);
  }

  override query(sql: string, params: readonly SqlValue[] = []): SqlRow[] {
    const rows = super.query(sql, params);
    if (sql.startsWith('SELECT * FROM _syncular_failed_rows'))
      this.journalRows += rows.length;
    return rows;
  }

  reset(): void {
    this.restores = 0;
    this.replays = 0;
    this.journalRows = 0;
  }
}

for (const subscriptions of [0, 2, 6, 12]) {
  test(`ACK restore/replay stays bounded with ${subscriptions} unrelated subscriptions`, async () => {
    const source = makeServer();
    const db = new OverlayCountingDatabase();
    const { client } = await makeClient(source, {
      clientId: `ack-${subscriptions}`,
      database: db,
    });
    try {
      // ACK-only tasks have no subscription. Alternate empty/nonempty docs
      // bootstraps in the same unrelated table.
      const writer = await makeClient(source, {
        clientId: `writer-${subscriptions}`,
      });
      try {
        writer.client.mutate([
          {
            table: 'docs',
            op: 'upsert',
            values: {
              id: 'doc',
              org_id: 'org-1',
              project_id: 'project-1',
              body: 'server',
            },
          },
        ]);
        await writer.client.syncUntilIdle();
      } finally {
        await writer.client.close();
        writer.db.close();
      }
      for (let index = 0; index < subscriptions; index += 1)
        client.subscribe({
          org_id: 'org-1',
          projectId: index % 2 ? 'empty' : 'project-1',
        });
      const ids = Array.from({ length: 32 }, (_, index) =>
        client.mutate([
          {
            table: 'tasks',
            op: 'upsert',
            values: taskValues(`task-${index}`, 'project-1', 'accepted'),
          },
        ]),
      );
      db.reset();
      const report = await client.sync();
      expect(report.applied).toEqual(ids);
      expect(client.pendingCommits()).toEqual([]);
      expect(db.restores).toBe(0);
      expect(db.replays).toBe(0);
      expect(db.journalRows).toBe(0);
      expect(
        db.query(
          'SELECT count(*) AS n FROM _syncular_failed_rows WHERE commit_seq IS NOT NULL',
        )[0]?.n,
      ).toBe(32);
      expect(db.query('SELECT title FROM tasks')).toHaveLength(32);

      // Repeated empty pulls and fresh unrelated bootstraps preserve intent
      // without writing or materializing any protected task row.
      for (let index = 0; index < subscriptions; index += 1)
        client.subscribe({ org_id: 'org-1', projectId: 'empty' });
      db.reset();
      await client.sync();
      expect([db.restores, db.replays, db.journalRows]).toEqual([0, 0, 0]);

      // Revoking unrelated subscriptions must not restore accepted tasks.
      source.allowed['actor-1'] = {
        project_id: ['*'],
        org_id: ['org-1'],
        projectId: [],
      };
      db.reset();
      await client.sync();
      expect([db.restores, db.replays]).toEqual([0, 0]);
      expect(db.query('SELECT title FROM tasks')).toHaveLength(32);

      // An empty bootstrap of another scope in the SAME nonunique table must
      // also leave unsubscribed intent intact after its covering SUB_END.
      client.subscribe({ project_id: 'empty' });
      db.reset();
      await client.sync();
      expect([db.restores, db.replays]).toEqual([0, 0]);
      expect(db.query('SELECT title FROM tasks')).toHaveLength(32);

      // Matching delivery retires the ACK journal. Later server changes win.
      client.subscribe({ project_id: 'project-1' });
      await client.syncUntilIdle();
      expect(
        db.query('SELECT count(*) AS n FROM _syncular_failed_rows')[0]?.n,
      ).toBe(0);
      expect(db.query('SELECT title FROM tasks')).toHaveLength(32);
    } finally {
      await client.close();
      db.close();
      source.storage.db.close();
    }
  });
}

// §7.1: the acknowledgement of `early` is lost; a pull delivers its change
// (v2) and B's later write (v3) before the resent commit drains as `cached`.
// `trailing` makes B write again (v4) so that COMMIT lands in the response
// right after the acknowledgements.
for (const variant of ['single', 'rollback', 'retained'] as const)
  for (const trailing of [false, true])
    test(`a cached ACK after delivery restores the delivered row (${variant}${trailing ? ', trailing COMMIT' : ''})`, async () => {
      const server = makeServer();
      const a = await makeClient(server, {
        clientId: 'a',
        retainFailedCommits: variant === 'retained',
      });
      const b = await makeClient(server, { clientId: 'b' });
      const title = () =>
        a.db.query('SELECT title, _sync_version AS v FROM tasks');
      const failedRows = () =>
        a.db.query('SELECT count(*) AS n FROM _syncular_failed_rows')[0]?.n;
      try {
        a.client.subscribe({ project_id: 'p1' });
        b.client.subscribe({ project_id: 'p1' });
        a.client.mutate([
          { table: 'tasks', op: 'upsert', values: taskValues('t1', 'p1') },
        ]);
        await a.client.syncUntilIdle();
        await b.client.syncUntilIdle();

        const early = a.client.patch('tasks', 't1', { title: 'early' });
        a.faults.dropResponseOnce = true;
        await expect(a.client.sync()).rejects.toThrow('transport round failed');
        a.client.setTransportGate('pull');
        const late =
          variant === 'single'
            ? undefined
            : a.client.patch(
                'tasks',
                't1',
                { title: 'late' },
                { baseVersion: 1 },
              );
        await b.client.syncUntilIdle();
        b.client.patch('tasks', 't1', { title: 'winner' });
        await b.client.syncUntilIdle();
        await a.client.syncUntilIdle();
        if (trailing) {
          b.client.patch('tasks', 't1', { title: 'winner-2' });
          await b.client.syncUntilIdle();
        }
        const winner = trailing
          ? { title: 'winner-2', v: 4 }
          : { title: 'winner', v: 3 };

        a.client.setTransportGate('open');
        const report = await a.client.sync();
        expect(report.applied).toEqual([early]);
        expect(report.rejected).toEqual(late === undefined ? [] : [late]);
        await a.client.syncUntilIdle();
        expect(a.client.pendingCommits()).toEqual([]);
        expect(title()).toEqual([
          variant === 'retained' ? { title: 'late', v: winner.v } : winner,
        ]);
        if (variant === 'retained') {
          expect(failedRows()).toBe(1);
          expect(
            a.client
              .commitOutcomes()
              .find((outcome) => outcome.clientCommitId === late)
              ?.retainedRows?.map((row) => [
                row.serverRow?.title,
                row.serverVersion,
              ]),
          ).toEqual([[winner.title, winner.v]]);
          expect(
            a.client.resolveCommitOutcome({
              clientCommitId: late!,
              resolution: 'resolved_keep_server',
            }).resolution,
          ).toBe('resolved_keep_server');
          await a.client.syncUntilIdle();
          expect(title()).toEqual([winner]);
        }
        expect(failedRows()).toBe(0);
      } finally {
        await a.client.close();
        await b.client.close();
        a.db.close();
        b.db.close();
        server.storage.db.close();
      }
    });
