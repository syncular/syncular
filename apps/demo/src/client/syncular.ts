import {
  getSyncularRuntimeArtifact,
  SyncularClientLifecycle,
} from '@syncular/client';
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
  close(): Promise<void>;
}

const actorId = 'demo-user';
const demoToken = 'demo-user';
const syncBaseUrl =
  import.meta.env.VITE_SYNCULAR_SYNC_URL ?? 'http://127.0.0.1:4101/sync';
const consoleBaseUrl =
  import.meta.env.VITE_SYNCULAR_CONSOLE_URL ?? 'http://127.0.0.1:4101/console';
const consoleToken =
  import.meta.env.VITE_SYNCULAR_CONSOLE_TOKEN ?? 'demo-console';
const consoleDiagnosticsEnabled =
  import.meta.env.VITE_SYNCULAR_CONSOLE_DIAGNOSTICS !== 'false';
const demoDatabaseFilePrefix = 'syncular-demo-rust-v3';

export async function openDemoClient(
  name: DemoClientName
): Promise<DemoClientHandle> {
  const database = await createSyncularAppDatabase({
    config: {
      baseUrl: syncBaseUrl,
      actorId,
      clientId: `demo-${name}`,
      fileName: `${demoDatabaseFilePrefix}-${name}.sqlite`,
      projectId: null,
      storage: 'indexedDb',
    },
    requestTimeoutMs: 15_000,
    getHeaders: async () => ({
      authorization: `Bearer ${demoToken}`,
    }),
    runtimeArtifacts: [getSyncularRuntimeArtifact('full')],
    subscriptions: [taskSubscription({ actorId })],
    sync: {
      rowsChangedDebounceMs: 25,
      mutationSyncDebounceMs: 25,
    },
    consoleDiagnostics: consoleDiagnosticsEnabled
      ? {
          baseUrl: consoleBaseUrl,
          token: consoleToken,
          partitionId: 'default',
          debounceMs: 100,
        }
      : false,
  });

  const lifecycle = new SyncularClientLifecycle(database.client, {
    realtime: {
      params: { token: demoToken },
      initialReconnectDelayMs: 500,
      maxReconnectDelayMs: 5_000,
    },
    pollIntervalMs: false,
  });

  try {
    await lifecycle.start();

    return {
      name,
      database,
      close: async () => {
        await lifecycle.stop();
        await database.close();
      },
    };
  } catch (error) {
    await database.close();
    throw error;
  }
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
