/**
 * Auto-generated database types from migrations.
 * DO NOT EDIT - regenerate with @syncular/typegen
 */

import type { SyncClientDb } from '@syncular/client';

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
  server_version?: number;
}

export interface SharedTasksTable {
  id: string;
  share_id: string;
  title: string;
  completed?: number;
  owner_id: string;
  server_version?: number;
}

export interface TasksTable {
  id: string;
  title: string;
  completed?: number;
  user_id: string;
  server_version?: number;
  image?: string | null;
  title_yjs_state?: string | null;
}

export type ClientDb = SyncClientDb & {
  catalog_items: CatalogItemsTable;
  patient_notes: PatientNotesTable;
  shared_tasks: SharedTasksTable;
  tasks: TasksTable;
};
