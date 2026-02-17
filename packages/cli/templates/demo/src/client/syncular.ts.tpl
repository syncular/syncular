import { createClient, type Client } from '@syncular/client';
import { createWaSqliteDb } from '@syncular/dialect-wa-sqlite';
import { createHttpTransport } from '@syncular/transport-http';
import type { Kysely } from 'kysely';
import type { AppClientDb, TasksTable } from '../shared/db';

const ACTOR_ID = 'demo-user';
const CLIENT_DATABASE_FILE = 'syncular-demo-client.sqlite';

interface DemoRuntime {
  db: Kysely<AppClientDb>;
  client: Client<AppClientDb>;
}

let runtimePromise: Promise<DemoRuntime> | null = null;

async function ensureClientAppTables(db: Kysely<AppClientDb>): Promise<void> {
  await db.schema
    .createTable('tasks')
    .ifNotExists()
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('title', 'text', (col) => col.notNull())
    .addColumn('completed', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('user_id', 'text', (col) => col.notNull())
    .addColumn('server_version', 'integer', (col) => col.notNull().defaultTo(0))
    .execute();
}

async function createRuntime(): Promise<DemoRuntime> {
  const db = createWaSqliteDb<AppClientDb>({ fileName: CLIENT_DATABASE_FILE });
  await ensureClientAppTables(db);

  const { client } = await createClient<AppClientDb>({
    db,
    actorId: ACTOR_ID,
    transport: createHttpTransport({
      baseUrl: '/api/sync',
      getHeaders: () => ({ 'x-user-id': ACTOR_ID }),
    }),
    tables: ['tasks'],
    scopes: ['user:{user_id}'],
    sync: {
      realtime: false,
      pollIntervalMs: 3000,
    },
  });

  await client.sync();
  return { db, client };
}

async function getRuntime(): Promise<DemoRuntime> {
  if (!runtimePromise) {
    runtimePromise = createRuntime();
  }
  return runtimePromise;
}

export async function initializeDemoSync(): Promise<void> {
  await getRuntime();
}

export async function listTasks(): Promise<TasksTable[]> {
  const runtime = await getRuntime();
  return runtime.db
    .selectFrom('tasks')
    .selectAll()
    .orderBy('server_version desc')
    .execute();
}

export async function addTask(title: string): Promise<void> {
  const runtime = await getRuntime();
  await runtime.client.mutations.tasks.insert({
    id: crypto.randomUUID(),
    title,
    completed: 0,
    user_id: ACTOR_ID,
    server_version: 0,
  });
  await runtime.client.sync();
}

export async function toggleTask(task: TasksTable): Promise<void> {
  const runtime = await getRuntime();
  await runtime.client.mutations.tasks.update(task.id, {
    completed: task.completed === 1 ? 0 : 1,
  });
  await runtime.client.sync();
}

export async function removeTask(taskId: string): Promise<void> {
  const runtime = await getRuntime();
  await runtime.client.mutations.tasks.delete(taskId);
  await runtime.client.sync();
}

export async function subscribeToTaskChanges(
  callback: () => void
): Promise<() => void> {
  const runtime = await getRuntime();
  const unsubscribeData = runtime.client.on('data:change', callback);
  const unsubscribeSync = runtime.client.on('sync:complete', callback);

  return () => {
    unsubscribeData();
    unsubscribeSync();
  };
}
