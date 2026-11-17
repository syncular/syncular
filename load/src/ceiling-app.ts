/**
 * The reference app of the partition ceiling, and the template for an app
 * that measures its own server. One partition, the load fixture's `tasks`
 * table, one project scope per pusher. A whole-commit validator reads four
 * rows one after another, the shape of a commit check that looks up the
 * records a write refers to. Each commit upserts `rows` rows of its pusher's
 * project, cycling over 100 row ids so that commits after the first
 * hundred update rows.
 */
import {
  MemorySegmentStore,
  PostgresServerStorage,
  type SyncServerConfig,
} from '@syncular/server';
import { createSyncularHono } from '@syncular/server-hono';
import type { CeilingApp } from './ceiling';
import { ACTOR_ID, clientProject, COLUMNS, SCHEMA, TABLE } from './fixture';

const app: CeilingApp = {
  schema: {
    version: SCHEMA.version,
    tables: [{ name: TABLE, columns: COLUMNS, primaryKey: 'id' }],
  },
  async createServer({ executor }) {
    const storage = new PostgresServerStorage(executor);
    await storage.migrate();
    const config: SyncServerConfig = {
      schema: SCHEMA,
      storage,
      segments: new MemorySegmentStore(),
      resolveScopes: () => ({ project_id: ['*'] }),
      async commitValidator({ operations, read }) {
        const project = String(operations[0]?.row?.project_id);
        for (let i = 0; i < 4; i++) {
          await read.getRow(TABLE, `${project}-r${i}`);
        }
      },
    };
    return createSyncularHono({
      config,
      authenticate: async () => ({ actorId: ACTOR_ID, partition: 'ceiling' }),
    });
  },
  scopes: (client) => ({ project_id: clientProject(client) }),
  commit({ client, seq, rows }) {
    const project = clientProject(client);
    return Array.from({ length: rows }, (_, i) => {
      const n = (seq * rows + i) % 100;
      return {
        table: TABLE,
        rowId: `${project}-r${n}`,
        op: 'upsert',
        values: {
          id: `${project}-r${n}`,
          project_id: project,
          title: `ceiling ${seq}`,
          done: seq % 2 === 0,
          priority: seq % 5,
          updated_at_ms: 1_750_000_000_000 + seq,
        },
      };
    });
  },
};

export default app;
