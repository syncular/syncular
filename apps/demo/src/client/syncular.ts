import {
  getSyncularV2RuntimeArtifact,
  SyncularV2ClientLifecycle,
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
const demoDatabaseFilePrefix = 'syncular-demo-rust-v2';

function consoleDiagnosticsUrl(): string {
  return `${consoleBaseUrl.replace(/\/$/u, '')}/client-diagnostics`;
}

function startConsoleDiagnosticPublishing(
  clientId: string,
  database: SyncularAppDatabase
): () => void {
  let closed = false;
  let publishQueued = false;

  const publish = async () => {
    if (closed) return;
    if (!browserIsOnline()) return;
    try {
      const [snapshot, lifecycle] = await Promise.all([
        database.client.diagnosticSnapshot(),
        Promise.resolve(database.client.lifecycleState()),
      ]);
      await fetch(consoleDiagnosticsUrl(), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${consoleToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          clientId,
          actorId,
          partitionId: 'default',
          lifecycle,
          snapshot,
        }),
      });
    } catch {
      // Diagnostic publishing must not affect the demo sync path.
    }
  };

  const schedulePublish = () => {
    if (closed || publishQueued) return;
    publishQueued = true;
    window.setTimeout(() => {
      publishQueued = false;
      void publish();
    }, 100);
  };

  const stopListening = [
    database.client.addDiagnosticListener(schedulePublish),
    database.client.addEventListener('lifecycleChanged', schedulePublish),
    database.client.addEventListener('bootstrapChanged', schedulePublish),
    database.client.addEventListener('outboxChanged', schedulePublish),
    database.client.addEventListener('conflictsChanged', schedulePublish),
    database.client.addEventListener('blobUploadsChanged', schedulePublish),
  ];
  schedulePublish();

  return () => {
    closed = true;
    for (const stop of stopListening) stop();
  };
}

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
    runtimeArtifacts: [getSyncularV2RuntimeArtifact('full')],
    subscriptions: [taskSubscription({ actorId })],
    sync: {
      rowsChangedDebounceMs: 25,
      mutationSyncDebounceMs: 25,
    },
  });

  const lifecycle = new SyncularV2ClientLifecycle(database.client, {
    realtime: {
      params: { token: demoToken },
      initialReconnectDelayMs: 500,
      maxReconnectDelayMs: 5_000,
    },
    pollIntervalMs: false,
  });

  try {
    await lifecycle.start();
    const stopConsoleDiagnostics = startConsoleDiagnosticPublishing(
      `demo-${name}`,
      database
    );

    return {
      name,
      database,
      close: async () => {
        stopConsoleDiagnostics();
        await lifecycle.stop();
        await database.close();
      },
    };
  } catch (error) {
    await database.close();
    throw error;
  }
}

function browserIsOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
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
