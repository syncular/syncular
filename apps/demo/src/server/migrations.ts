/**
 * @syncular/demo - Server database migrations
 *
 * Version-tracked migrations for the server schema (Postgres/PGlite).
 */

import { defineMigrations } from '@syncular/migrations';
import type { SyncBlobDb, SyncCoreDb } from '@syncular/server';
import type { ClientDb } from '../client/types.generated';

type ServerMigrationDb = SyncCoreDb & SyncBlobDb & ClientDb;

export const serverMigrations = defineMigrations<ServerMigrationDb>({
  v1: async (db) => {
    // Create tasks table
    await db.schema
      .createTable('tasks')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('title', 'text', (col) => col.notNull())
      .addColumn('completed', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('user_id', 'text', (col) => col.notNull())
      .addColumn('server_version', 'integer', (col) =>
        col.notNull().defaultTo(1)
      )
      .execute();

    // Add index for user_id lookups
    await db.schema
      .createIndex('idx_tasks_user_id')
      .on('tasks')
      .columns(['user_id'])
      .execute();

    // Create shared_tasks table (shared scope for E2EE key-share demo)
    await db.schema
      .createTable('shared_tasks')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('share_id', 'text', (col) => col.notNull())
      .addColumn('title', 'text', (col) => col.notNull())
      .addColumn('completed', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('owner_id', 'text', (col) => col.notNull())
      .addColumn('server_version', 'integer', (col) =>
        col.notNull().defaultTo(1)
      )
      .execute();

    await db.schema
      .createIndex('idx_shared_tasks_share_id')
      .on('shared_tasks')
      .columns(['share_id'])
      .execute();

    await db.schema
      .createIndex('idx_shared_tasks_owner_id')
      .on('shared_tasks')
      .columns(['owner_id'])
      .execute();

    // Large catalog table (read-only demo; loaded via chunked snapshots)
    await db.schema
      .createTable('catalog_items')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('name', 'text', (col) => col.notNull())
      .execute();

    // Patient notes table (symmetric E2EE demo with per-patient scopes)
    await db.schema
      .createTable('patient_notes')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('patient_id', 'text', (col) => col.notNull())
      .addColumn('note', 'text', (col) => col.notNull())
      .addColumn('created_by', 'text', (col) => col.notNull())
      .addColumn('created_at', 'text', (col) => col.notNull())
      .addColumn('server_version', 'integer', (col) =>
        col.notNull().defaultTo(1)
      )
      .execute();

    await db.schema
      .createIndex('idx_patient_notes_patient_id')
      .on('patient_notes')
      .columns(['patient_id'])
      .execute();

    await db.schema
      .createIndex('idx_patient_notes_created_by')
      .on('patient_notes')
      .columns(['created_by'])
      .execute();
  },

  v2: async (db) => {
    // Add image column to tasks (stores JSON BlobRef)
    await db.schema.alterTable('tasks').addColumn('image', 'text').execute();
  },
});
