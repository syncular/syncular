import { getSyncularV2RuntimeArtifact } from '@syncular/client';
import {
  createSyncularAppDatabase,
  type SyncularAppDatabase,
  type TaskRow,
  taskSubscription,
} from '../../../../rust/examples/todo-app/generated/typescript/syncular.generated';

export type DemoClientName = 'left' | 'right';
export type DemoTask = Pick<
  TaskRow,
  | 'id'
  | 'title'
  | 'completed'
  | 'user_id'
  | 'project_id'
  | 'image'
  | 'server_version'
>;

export interface DemoClientHandle {
  name: DemoClientName;
  database: SyncularAppDatabase;
  syncNow(): Promise<void>;
  close(): Promise<void>;
}

const actorId = 'demo-user';
const demoToken = 'demo-user';
const syncBaseUrl =
  import.meta.env.VITE_SYNCULAR_SYNC_URL ?? 'http://127.0.0.1:4101/sync';

export async function openDemoClient(
  name: DemoClientName
): Promise<DemoClientHandle> {
  const database = await createSyncularAppDatabase({
    config: {
      baseUrl: syncBaseUrl,
      actorId,
      clientId: `demo-${name}`,
      fileName: `syncular-demo-${name}.sqlite`,
      projectId: null,
      storage: 'indexedDb',
    },
    requestTimeoutMs: 15_000,
    getHeaders: async () => ({
      authorization: `Bearer ${demoToken}`,
    }),
    runtimeArtifacts: [getSyncularV2RuntimeArtifact('full')],
    subscriptions: [taskSubscription({ actorId })],
    sync: {
      autoSyncAfterMutation: true,
      mutationSyncDebounceMs: 25,
      rowsChangedDebounceMs: 25,
    },
  });

  const syncNow = async () => {
    await database.client.syncOnce();
  };

  await syncNow();
  await database.client.startRealtime({
    params: { token: demoToken },
  });

  return {
    name,
    database,
    syncNow,
    close: () => database.close(),
  };
}

export function selectTasks(database: SyncularAppDatabase) {
  return database.db
    .selectFrom('tasks')
    .select([
      'id',
      'title',
      'completed',
      'user_id',
      'project_id',
      'image',
      'server_version',
    ])
    .orderBy('completed', 'asc')
    .orderBy('title', 'asc');
}
