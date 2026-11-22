import { expect, test } from 'bun:test';
import type { ServerSchema } from '@syncular/server';
import { BunClientDatabase } from '../src/bun-database';
import type { SqlRow, SqlValue } from '../src/database';
import { makeClient, makeServer } from './helpers';

const SCHEMA = {
  version: 1,
  tables: ['notes', 'items'].map((name) => ({
    name,
    primaryKey: 'id',
    scopes: ['room:{room_id}'],
    columns: [
      { name: 'id', type: 'string' as const, nullable: false },
      { name: 'room_id', type: 'string' as const, nullable: false },
      { name: 'body', type: 'string' as const, nullable: false },
    ],
  })),
} satisfies ServerSchema;

/** Statements a replay-mode image chunk runs: it reads its rows into JS. */
class StatementLog extends BunClientDatabase {
  readonly sql: string[] = [];
  override query(sql: string, params: readonly SqlValue[] = []): SqlRow[] {
    this.sql.push(sql);
    return super.query(sql, params);
  }
}

const replayReads = (log: StatementLog) =>
  log.sql.filter((sql) => /^SELECT \* FROM syncular_image\.\S+ WHERE/.test(sql))
    .length;

for (const pendingIn of ['notes', 'items', 'both'] as const)
  test(`an image import replays only with intent in its own table, pending in ${pendingIn} (§7.2)`, async () => {
    const server = makeServer(SCHEMA);
    server.allowed['actor-1'] = { room_id: ['notes-room', 'items-room'] };
    server.limits.inlineSegmentMaxBytes = 0;
    const seed = await makeClient(server, {
      clientId: `seed-${pendingIn}`,
      schema: SCHEMA,
    });
    for (let i = 0; i < 3000; i += 500)
      seed.client.mutate(
        Array.from({ length: 500 }, (_, j) => ({
          table: 'items',
          op: 'upsert' as const,
          values: {
            id: `item-${i + j}`,
            room_id: 'items-room',
            body: 'server',
          },
        })),
      );
    await seed.client.syncUntilIdle();
    const database = new StatementLog();
    const a = await makeClient(server, {
      clientId: `reader-${pendingIn}`,
      schema: SCHEMA,
      database,
    });
    try {
      a.client.subscribe({ room_id: 'notes-room' });
      await a.client.syncUntilIdle();
      a.client.setTransportGate('pull');
      // `both`: one commit spans notes and items, so it counts for items.
      const tables =
        pendingIn === 'both' ? (['notes', 'items'] as const) : [pendingIn];
      const pending = a.client.mutate(
        tables.map((table) => ({
          table,
          op: 'upsert' as const,
          values: { id: 'local', room_id: `${table}-room`, body: 'mine' },
        })),
      );
      database.sql.length = 0;
      a.client.subscribe({ room_id: 'items-room' });
      await a.client.syncUntilIdle();
      expect(
        Number(a.client.query('SELECT count(*) AS n FROM items')[0]?.n),
      ).toBe(pendingIn === 'notes' ? 3000 : 3001);
      // A pending row of another table keeps the bulk path; its own replays.
      expect(replayReads(database) > 0).toBe(pendingIn !== 'notes');
      // The pending rows survive the import, visible and still pending.
      for (const table of tables)
        expect(
          a.client.query(`SELECT body FROM ${table} WHERE id='local'`),
        ).toEqual([{ body: 'mine' }]);
      expect(a.client.pendingCommits().map((c) => c.clientCommitId)).toEqual([
        pending,
      ]);
    } finally {
      await a.client.close();
      await seed.client.close();
    }
  });
