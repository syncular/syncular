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
          id: `unrelated-${index}`,
          table: 'docs',
          scopes: {
            org_id: ['org-1'],
            projectId: [index % 2 ? 'empty' : 'project-1'],
          },
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
        client.subscribe({
          id: `again-${index}`,
          table: 'docs',
          scopes: { org_id: ['org-1'], projectId: ['empty'] },
        });
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
      client.subscribe({
        id: 'other-tasks',
        table: 'tasks',
        scopes: { project_id: ['empty'] },
      });
      db.reset();
      await client.sync();
      expect([db.restores, db.replays]).toEqual([0, 0]);
      expect(db.query('SELECT title FROM tasks')).toHaveLength(32);

      // Matching delivery retires the ACK journal. Later server changes win.
      client.subscribe({
        id: 'own-tasks',
        table: 'tasks',
        scopes: { project_id: ['project-1'] },
      });
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
