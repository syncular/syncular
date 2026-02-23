/**
 * Standalone load test server
 *
 * Uses a configurable DB dialect and seeds configurable data for load testing.
 * Default is SQLite to better mirror Durable Object style deployments.
 *
 * Environment variables:
 *   - PORT: Server port (default: 3001)
 *   - LOAD_DB_DIALECT: `sqlite` or `pglite` (default: sqlite)
 *   - SQLITE_PATH: SQLite DB path (default: :memory:)
 *   - SEED_ROWS: Total rows to seed exactly across all generated users (default: 10000)
 *   - SEED_USERS: Number of users to create (default: 100)
 *   - SEED_RANDOM_SEED: Optional deterministic seed for generated row randomness
 *
 * Usage:
 *   bun tests/load/server.ts
 *   LOAD_DB_DIALECT=sqlite SEED_ROWS=100000 SEED_USERS=1000 bun tests/load/server.ts
 */

import type { SyncOperation } from '@syncular/core';
import { createBunSqliteDb } from '@syncular/dialect-bun-sqlite';
import { createPgliteDb } from '@syncular/dialect-pglite';
import {
  type ApplyOperationResult,
  type EmittedChange,
  ensureSyncSchema,
  type ServerSyncDialect,
  type ServerTableHandler,
  type SyncCoreDb,
} from '@syncular/server';
import { createPostgresServerDialect } from '@syncular/server-dialect-postgres';
import { createSqliteServerDialect } from '@syncular/server-dialect-sqlite';
import { createSyncRoutes } from '@syncular/server-hono';
import { Hono } from 'hono';
import { upgradeWebSocket, websocket } from 'hono/bun';
import { cors } from 'hono/cors';
import type { Kysely } from 'kysely';
import {
  buildSeedPlan,
  createSeededRandom,
  SEED_USER_PREFIXES,
} from './seeding';

// Server database schema
interface ServerDb extends SyncCoreDb {
  tasks: {
    id: string;
    title: string;
    completed: number;
    user_id: string;
    server_version: number;
  };
}

type LoadServerDialect = 'sqlite' | 'pglite';

// Tasks table handler
const tasksServerShape: ServerTableHandler<ServerDb> = {
  table: 'tasks',
  scopePatterns: ['user:{user_id}'],

  async resolveScopes(ctx) {
    return {
      user_id: ctx.actorId,
    };
  },

  extractScopes(row: Record<string, unknown>) {
    return {
      user_id: String(row.user_id ?? ''),
    };
  },

  async snapshot(ctx): Promise<{ rows: unknown[]; nextCursor: string | null }> {
    const d = ctx.db;

    const userIdValue = ctx.scopeValues.user_id;
    const userId = Array.isArray(userIdValue) ? userIdValue[0] : userIdValue;

    if (!userId || userId !== ctx.actorId) {
      return { rows: [], nextCursor: null };
    }

    const query = d
      .selectFrom('tasks')
      .select(['id', 'title', 'completed', 'user_id', 'server_version'])
      .where('user_id', '=', userId);

    const pageSize = Math.max(1, Math.min(10_000, ctx.limit));
    const cursor = ctx.cursor;

    const rows = await (cursor ? query.where('id', '>', cursor) : query)
      .orderBy('id', 'asc')
      .limit(pageSize + 1)
      .execute();

    const hasMore = rows.length > pageSize;
    const pageRows = hasMore ? rows.slice(0, pageSize) : rows;
    const nextCursor = hasMore
      ? (pageRows[pageRows.length - 1]?.id ?? null)
      : null;

    return {
      rows: pageRows,
      nextCursor:
        typeof nextCursor === 'string' && nextCursor.length > 0
          ? nextCursor
          : null,
    };
  },

  async applyOperation(
    ctx,
    op: SyncOperation,
    opIndex: number
  ): Promise<ApplyOperationResult> {
    const d = ctx.trx;

    if (op.table !== 'tasks') {
      return {
        result: {
          opIndex,
          status: 'error',
          error: `UNKNOWN_TABLE:${op.table}`,
          code: 'UNKNOWN_TABLE',
          retriable: false,
        },
        emittedChanges: [],
      };
    }

    if (op.op === 'delete') {
      const existing = await d
        .selectFrom('tasks')
        .select(['id'])
        .where('id', '=', op.row_id)
        .where('user_id', '=', ctx.actorId)
        .executeTakeFirst();

      if (!existing) {
        return { result: { opIndex, status: 'applied' }, emittedChanges: [] };
      }

      await d
        .deleteFrom('tasks')
        .where('id', '=', op.row_id)
        .where('user_id', '=', ctx.actorId)
        .execute();

      const emitted: EmittedChange = {
        table: 'tasks',
        row_id: op.row_id,
        op: 'delete',
        row_json: null,
        row_version: null,
        scopes: { user_id: ctx.actorId },
      };

      return {
        result: { opIndex, status: 'applied' },
        emittedChanges: [emitted],
      };
    }

    const payload = (op.payload ?? {}) as {
      title?: string;
      completed?: number;
      user_id?: string;
    };

    const existing = await d
      .selectFrom('tasks')
      .select(['id', 'title', 'completed', 'server_version'])
      .where('id', '=', op.row_id)
      .where('user_id', '=', ctx.actorId)
      .executeTakeFirst();

    if (
      existing &&
      op.base_version != null &&
      existing.server_version !== op.base_version
    ) {
      return {
        result: {
          opIndex,
          status: 'conflict',
          message: `Version conflict: server=${existing.server_version}, base=${op.base_version}`,
          server_version: existing.server_version,
          server_row: {
            id: existing.id,
            title: existing.title,
            completed: existing.completed,
            user_id: ctx.actorId,
            server_version: existing.server_version,
          },
        },
        emittedChanges: [],
      };
    }

    if (existing) {
      const nextVersion = existing.server_version + 1;
      await d
        .updateTable('tasks')
        .set({
          title: payload.title ?? existing.title,
          completed: payload.completed ?? existing.completed,
          server_version: nextVersion,
        })
        .where('id', '=', op.row_id)
        .where('user_id', '=', ctx.actorId)
        .execute();
    } else {
      await d
        .insertInto('tasks')
        .values({
          id: op.row_id,
          title: payload.title ?? '',
          completed: payload.completed ?? 0,
          user_id: ctx.actorId,
          server_version: 1,
        })
        .execute();
    }

    const updated = await d
      .selectFrom('tasks')
      .select(['id', 'title', 'completed', 'user_id', 'server_version'])
      .where('id', '=', op.row_id)
      .where('user_id', '=', ctx.actorId)
      .executeTakeFirstOrThrow();

    const emitted: EmittedChange = {
      table: 'tasks',
      row_id: op.row_id,
      op: 'upsert',
      row_json: updated,
      row_version: updated.server_version,
      scopes: { user_id: ctx.actorId },
    };

    return {
      result: { opIndex, status: 'applied' },
      emittedChanges: [emitted],
    };
  },
};

/**
 * Seed the database with test data
 */
async function seedData(
  db: Kysely<ServerDb>,
  totalRows: number,
  userCount: number,
  random: () => number
): Promise<void> {
  const batchSize = 1000;
  const seedPlan = buildSeedPlan(totalRows, userCount);

  console.log(
    `Seeding ${totalRows} rows across ${userCount} users and ${SEED_USER_PREFIXES.length} traffic profiles...`
  );

  const startTime = Date.now();
  let seededRows = 0;

  for (
    let identityIndex = 0;
    identityIndex < seedPlan.length;
    identityIndex++
  ) {
    const identity = seedPlan[identityIndex];
    if (!identity) continue;

    let seededForIdentity = 0;
    while (seededForIdentity < identity.rowCount) {
      const currentBatchSize = Math.min(
        batchSize,
        identity.rowCount - seededForIdentity
      );

      const batch: ServerDb['tasks'][] = [];
      for (let i = 0; i < currentBatchSize; i++) {
        const rowIndex = seededForIdentity + i;
        batch.push({
          id: `task-${identity.userId}-${rowIndex}`,
          title: `Task ${rowIndex + 1} for ${identity.userId}`,
          completed: random() > 0.7 ? 1 : 0,
          user_id: identity.userId,
          server_version: 1,
        });
      }

      await db.insertInto('tasks').values(batch).execute();
      seededForIdentity += currentBatchSize;
      seededRows += currentBatchSize;
    }

    if (
      (identityIndex + 1) % 50 === 0 ||
      identityIndex === seedPlan.length - 1
    ) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(
        `  Seeded ${identityIndex + 1}/${seedPlan.length} users (${seededRows}/${totalRows} rows, ${elapsed}s)`
      );
    }
  }

  const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(
    `Seeding complete in ${totalElapsed}s (${seededRows} rows total)`
  );
}

async function main() {
  const port = Number.parseInt(process.env.PORT || '3001', 10);
  const seedRows = Number.parseInt(process.env.SEED_ROWS || '10000', 10);
  const seedUsers = Number.parseInt(process.env.SEED_USERS || '100', 10);
  const seedRandomSeed = process.env.SEED_RANDOM_SEED;
  const dbDialectRaw = process.env.LOAD_DB_DIALECT || 'sqlite';
  const dbDialect: LoadServerDialect =
    dbDialectRaw === 'pglite' ? 'pglite' : 'sqlite';
  const sqlitePath = process.env.SQLITE_PATH || ':memory:';

  console.log('=== Load Test Server ===');
  console.log(`Port: ${port}`);
  console.log(`DB dialect: ${dbDialect}`);
  if (dbDialect === 'sqlite') {
    console.log(`SQLite path: ${sqlitePath}`);
  }
  console.log(`Seed rows: ${seedRows}`);
  console.log(`Seed users: ${seedUsers}`);
  console.log(`Seed random seed: ${seedRandomSeed ?? '(random)'}`);
  console.log('');

  // Initialize database
  console.log('Initializing database...');
  const db =
    dbDialect === 'pglite'
      ? createPgliteDb<ServerDb>()
      : createBunSqliteDb<ServerDb>({ path: sqlitePath });
  const dialect: ServerSyncDialect =
    dbDialect === 'pglite'
      ? createPostgresServerDialect()
      : createSqliteServerDialect();

  await ensureSyncSchema(db, dialect);

  // Create tasks table
  await db.schema
    .createTable('tasks')
    .ifNotExists()
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('title', 'text', (col) => col.notNull())
    .addColumn('completed', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('user_id', 'text', (col) => col.notNull())
    .addColumn('server_version', 'integer', (col) => col.notNull().defaultTo(1))
    .execute();

  // Add index for user_id lookups
  await db.schema
    .createIndex('idx_tasks_user_id')
    .ifNotExists()
    .on('tasks')
    .columns(['user_id'])
    .execute();

  console.log('Database ready.');

  // Seed data
  if (seedRows > 0) {
    const random = createSeededRandom(seedRandomSeed);
    await seedData(db, seedRows, seedUsers, random);
  }

  // Create Hono app
  const app = new Hono();

  // Enable CORS
  app.use(
    '*',
    cors({
      origin: '*',
      credentials: true,
    })
  );

  // Simple auth - extract user ID from header
  const authenticate = async (c: {
    req: {
      header: (name: string) => string | undefined;
      query: (name: string) => string | undefined;
    };
  }) => {
    const userId = c.req.header('x-user-id') ?? c.req.query('userId');
    if (!userId) return null;
    return { actorId: userId };
  };

  // Mount sync routes
  const syncRoutes = createSyncRoutes({
    db,
    dialect,
    handlers: [tasksServerShape],
    authenticate,
    sync: {
      rateLimit: false,
      websocket: {
        enabled: true,
        upgradeWebSocket,
        heartbeatIntervalMs: 30_000,
      },
    },
  });
  app.route('/api/sync', syncRoutes);

  // Health check
  app.get('/api/health', (c) => c.json({ status: 'ok' }));

  // Stats endpoint
  app.get('/api/stats', async (c) => {
    const taskCount = await db
      .selectFrom('tasks')
      .select(db.fn.count('id').as('count'))
      .executeTakeFirst();

    return c.json({
      tasks: Number(taskCount?.count ?? 0),
      seedUsers,
      seedRows,
      seedRandomSeed: seedRandomSeed ?? null,
    });
  });

  // Per-user stats (used by bootstrap load tests)
  app.get('/api/stats/user/:userId', async (c) => {
    const userId = c.req.param('userId');
    const taskCount = await db
      .selectFrom('tasks')
      .select(db.fn.count('id').as('count'))
      .where('user_id', '=', userId)
      .executeTakeFirst();

    return c.json({
      userId,
      rows: Number(taskCount?.count ?? 0),
    });
  });

  console.log('');
  console.log(`Load test server running at http://localhost:${port}`);
  console.log(`Health: http://localhost:${port}/api/health`);
  console.log(`Stats: http://localhost:${port}/api/stats`);

  Bun.serve({
    port,
    fetch: app.fetch,
    websocket,
    idleTimeout: 0,
  });
}

main().catch((err) => {
  console.error('Failed to start load test server:', err);
  process.exit(1);
});
