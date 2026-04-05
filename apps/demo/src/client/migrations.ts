/**
 * @syncular/demo - Client database migrations
 *
 * Version-tracked migrations that define the client schema.
 * Types and deterministic checksums are generated from these migrations.
 */

import { defineMigrations } from '@syncular/migrations';
import type { ClientDb } from './types.generated';

/** @public Used by scripts/generate-types.ts */
export const clientMigrations = defineMigrations<ClientDb>({
  v1: {
    up: async (db) => {
      // Create tasks table
      await db.schema
        .createTable('tasks')
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('title', 'text', (col) => col.notNull())
        .addColumn('completed', 'integer', (col) => col.notNull().defaultTo(0))
        .addColumn('user_id', 'text', (col) => col.notNull())
        .addColumn('server_version', 'integer', (col) =>
          col.notNull().defaultTo(0)
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
          col.notNull().defaultTo(0)
        )
        .execute();

      await db.schema
        .createIndex('idx_shared_tasks_share_id')
        .on('shared_tasks')
        .columns(['share_id'])
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
          col.notNull().defaultTo(0)
        )
        .execute();

      await db.schema
        .createIndex('idx_patient_notes_patient_id')
        .on('patient_notes')
        .columns(['patient_id'])
        .execute();
    },
    down: async (db) => {
      await db.schema.dropTable('patient_notes').ifExists().execute();
      await db.schema.dropTable('catalog_items').ifExists().execute();
      await db.schema.dropTable('shared_tasks').ifExists().execute();
      await db.schema.dropTable('tasks').ifExists().execute();
    },
  },

  v2: {
    up: async (db) => {
      // Add image column to tasks (stores JSON BlobRef)
      await db.schema.alterTable('tasks').addColumn('image', 'text').execute();
    },
    down: async (db) => {
      await db.schema.alterTable('tasks').dropColumn('image').execute();
    },
  },

  v3: {
    up: async (db) => {
      // Add Yjs state column for CRDT-backed task titles
      await db.schema
        .alterTable('tasks')
        .addColumn('title_yjs_state', 'text')
        .execute();
    },
    down: async (db) => {
      await db.schema
        .alterTable('tasks')
        .dropColumn('title_yjs_state')
        .execute();
    },
  },
});
