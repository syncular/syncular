/**
 * Auto-generated database types from migrations.
 * DO NOT EDIT - regenerate with @syncular/typegen
 */

import type { SyncClientDb } from '@syncular/client';

import type { Generated } from 'kysely';

export interface CatalogItemsTable {
  id: string;
  name: string;
}

export interface PatientNotesTable {
  id: string;
  patient_id: string;
  note: string;
  created_by: string;
  created_at: string;
  server_version: Generated<number>;
}

export interface SharedTasksTable {
  id: string;
  share_id: string;
  title: string;
  completed: Generated<number>;
  owner_id: string;
  server_version: Generated<number>;
}

export interface TasksTable {
  id: string;
  title: string;
  completed: Generated<number>;
  user_id: string;
  server_version: Generated<number>;
  image: string | null;
  title_yjs_state: string | null;
}

export interface ClientDb extends SyncClientDb {
  catalog_items: CatalogItemsTable;
  patient_notes: PatientNotesTable;
  shared_tasks: SharedTasksTable;
  tasks: TasksTable;
}
