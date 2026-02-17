import type { SyncBlobDb, SyncCoreDb } from '@syncular/server';
import type { Kysely } from 'kysely';
import type { ClientDb } from '../client/types.generated';

type DemoResetDb = SyncCoreDb & SyncBlobDb & ClientDb;
type DemoResetTable = keyof DemoResetDb;

const RESET_TABLES: readonly DemoResetTable[] = [
  'sync_table_commits',
  'sync_changes',
  'sync_client_cursors',
  'sync_snapshot_chunks',
  'sync_commits',
  'sync_blob_uploads',
  'sync_blobs',
  'tasks',
  'shared_tasks',
  'catalog_items',
  'patient_notes',
];

export async function resetDemoData<DB extends DemoResetDb>(
  db: Kysely<DB>
): Promise<void> {
  // Delete sequentially without transaction — D1 doesn't support transactions
  for (const table of RESET_TABLES) {
    await db.deleteFrom(table).execute();
  }
}
