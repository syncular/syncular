import type { SyncClientDb } from '@syncular/client';
import { defineMigrations } from '@syncular/migrations';
import type { SyncCoreDb } from '@syncular/server';

export interface TasksTable {
  id: string;
  title: string;
  completed: number;
  user_id: string;
  server_version: number;
}

export interface AppClientDb extends SyncClientDb {
  tasks: TasksTable;
}

export interface AppServerDb extends SyncCoreDb {
  tasks: TasksTable;
}

export const demoMigrations = defineMigrations<AppServerDb>({
  v1: async (db) => {
    await db.schema
      .createTable('tasks')
      .ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('title', 'text', (col) => col.notNull())
      .addColumn('completed', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('user_id', 'text', (col) => col.notNull())
      .addColumn('server_version', 'integer', (col) => col.notNull().defaultTo(1))
      .execute();

    await db.schema
      .createIndex('idx_tasks_user_id')
      .ifNotExists()
      .on('tasks')
      .columns(['user_id'])
      .execute();
  },
});
