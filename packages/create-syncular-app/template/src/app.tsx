import {
  getSyncularBrowserHealth,
  installSyncularBrowserLifecycleResume,
  type SyncularBrowserHealth,
  type SyncularBrowserLifecycleResumeController,
  type SyncularClientStatus,
  type SyncularSchemaReadinessResult,
  type SyncularSupportBundle,
} from '@syncular/client';
import { createSyncularReact } from '@syncular/client/react';
import type { Dispatch, FormEvent, SetStateAction } from 'react';
import { useEffect, useRef, useState } from 'react';
import {
  type AppDb,
  type AppSyncClient,
  appActorId,
  openAppClient,
  syncularGeneratedRequiredRuntimeFeatures,
  type Task,
} from './client/syncular';

type LifecycleResumePreview = {
  count: number;
  error: string | null;
  lastReason: string | null;
  status: 'idle' | 'running' | 'complete' | 'failed';
};

type StarterTimelinePreview = {
  bootstrapReadyMs: number | null;
  bootstrapStatus: 'pending' | 'ready';
  databaseOpenMs: number | null;
  healthRefreshMs: number | null;
  localVisibilityErrorCode: string | null;
  localVisibilityMs: number | null;
  localVisibilityStatus: 'idle' | 'running' | 'visible' | 'failed';
  realtimeConnectedMs: number | null;
  realtimeStatus: 'pending' | 'connected';
  schemaReadinessMs: number | null;
  supportBundleExportMs: number | null;
};

const initialLifecycleResume: LifecycleResumePreview = {
  count: 0,
  error: null,
  lastReason: null,
  status: 'idle',
};

const initialStarterTimeline: StarterTimelinePreview = {
  bootstrapReadyMs: null,
  bootstrapStatus: 'pending',
  databaseOpenMs: null,
  healthRefreshMs: null,
  localVisibilityErrorCode: null,
  localVisibilityMs: null,
  localVisibilityStatus: 'idle',
  realtimeConnectedMs: null,
  realtimeStatus: 'pending',
  schemaReadinessMs: null,
  supportBundleExportMs: null,
};

const appStartedAtMs = performance.now();

// One hook set, bound to this app's database schema.
const {
  SyncProvider,
  useMutations,
  useOutboxStats,
  useSyncQuery,
  useSyncStatus,
} = createSyncularReact<AppDb>();

export function App() {
  const [client, setClient] = useState<AppSyncClient | null>(null);
  const [lifecycleResume, setLifecycleResume] =
    useState<LifecycleResumePreview>(initialLifecycleResume);
  const [openError, setOpenError] = useState<string | null>(null);
  const [starterTimeline, setStarterTimeline] =
    useState<StarterTimelinePreview>(initialStarterTimeline);

  useEffect(() => {
    let disposed = false;
    let opened: AppSyncClient | null = null;
    let lifecycleResume: SyncularBrowserLifecycleResumeController | null = null;

    void openAppClient()
      .then((nextClient) => {
        if (disposed) {
          void nextClient.close().catch(() => undefined);
          return;
        }
        opened = nextClient;
        lifecycleResume = installSyncularBrowserLifecycleResume(nextClient, {
          onResumeStart(context) {
            if (!disposed) {
              setLifecycleResume((current) => ({
                ...current,
                error: null,
                lastReason: context.reason,
                status: 'running',
              }));
            }
          },
          onResumeComplete(_result, context) {
            if (!disposed) {
              setLifecycleResume((current) => ({
                count: current.count + 1,
                error: null,
                lastReason: context.reason,
                status: 'complete',
              }));
            }
          },
          onResumeError(error, context) {
            if (!disposed) {
              setLifecycleResume((current) => ({
                ...current,
                error: errorMessage(error),
                lastReason: context.reason,
                status: 'failed',
              }));
            }
          },
        });
        setStarterTimeline((current) => ({
          ...current,
          databaseOpenMs: elapsedSince(appStartedAtMs),
        }));
        setClient(nextClient);
      })
      .catch((error) => {
        if (!disposed) setOpenError(errorMessage(error));
      });

    return () => {
      disposed = true;
      lifecycleResume?.destroy();
      if (opened) void opened.close().catch(() => undefined);
    };
  }, []);

  return (
    <main className="app-shell">
      <header className="topbar">
        <p className="eyebrow">Syncular</p>
        <h1>Local-first tasks</h1>
      </header>

      {openError ? <p className="error-line">{openError}</p> : null}

      <section className="client-pane" aria-label="Tasks">
        {client ? (
          <SyncProvider client={client}>
            <LifecycleResumeMarker lifecycleResume={lifecycleResume} />
            <TaskPane
              client={client}
              starterTimeline={starterTimeline}
              updateStarterTimeline={setStarterTimeline}
            />
          </SyncProvider>
        ) : (
          <p className="empty-state">Opening local database…</p>
        )}
      </section>
    </main>
  );
}

function LifecycleResumeMarker({
  lifecycleResume,
}: {
  lifecycleResume: LifecycleResumePreview;
}) {
  return (
    <span
      data-syncular-lifecycle-resume-count={lifecycleResume.count}
      data-syncular-lifecycle-resume-error={lifecycleResume.error ?? ''}
      data-syncular-lifecycle-resume-reason={lifecycleResume.lastReason ?? ''}
      data-syncular-lifecycle-resume-status={lifecycleResume.status}
      hidden
    />
  );
}

function TaskPane({
  client,
  starterTimeline,
  updateStarterTimeline,
}: {
  client: AppSyncClient;
  starterTimeline: StarterTimelinePreview;
  updateStarterTimeline: Dispatch<SetStateAction<StarterTimelinePreview>>;
}) {
  // Live query: re-renders whenever synced rows change, locally or remotely.
  const { data: tasks, error: queryError } = useSyncQuery(
    ({ selectFrom }) =>
      selectFrom('tasks')
        .selectAll()
        .orderBy('completed', 'asc')
        .orderBy('created_at', 'desc'),
    { tables: ['tasks'] }
  );
  const mutations = useMutations();
  const outbox = useOutboxStats();
  const status = useSyncStatus();
  const [health, setHealth] = useState<SyncularBrowserHealth | null>(null);
  const [schemaReadiness, setSchemaReadiness] =
    useState<SyncularSchemaReadinessResult | null>(null);
  const [supportBundle, setSupportBundle] =
    useState<SupportBundlePreview | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const bootstrapReady = status.lifecycle.bootstrap?.complete === true;
    const realtimeConnected = status.connection.realtime === 'connected';
    updateStarterTimeline((current) => {
      const nextBootstrapStatus = bootstrapReady ? 'ready' : 'pending';
      const nextRealtimeStatus = realtimeConnected ? 'connected' : 'pending';
      const nextBootstrapReadyMs =
        current.bootstrapReadyMs ??
        (bootstrapReady ? elapsedSince(appStartedAtMs) : null);
      const nextRealtimeConnectedMs =
        current.realtimeConnectedMs ??
        (realtimeConnected ? elapsedSince(appStartedAtMs) : null);
      if (
        current.bootstrapReadyMs === nextBootstrapReadyMs &&
        current.bootstrapStatus === nextBootstrapStatus &&
        current.realtimeConnectedMs === nextRealtimeConnectedMs &&
        current.realtimeStatus === nextRealtimeStatus
      ) {
        return current;
      }
      return {
        ...current,
        bootstrapReadyMs: nextBootstrapReadyMs,
        bootstrapStatus: nextBootstrapStatus,
        realtimeConnectedMs: nextRealtimeConnectedMs,
        realtimeStatus: nextRealtimeStatus,
      };
    });
  }, [
    status.connection.realtime,
    status.lifecycle.bootstrap?.complete,
    updateStarterTimeline,
  ]);

  useEffect(() => {
    let disposed = false;
    const refresh = () => {
      const healthStartedAtMs = performance.now();
      void getSyncularBrowserHealth(client)
        .then((nextHealth) => {
          if (!disposed) {
            setHealth(nextHealth);
            updateStarterTimeline((current) => ({
              ...current,
              healthRefreshMs: elapsedSince(healthStartedAtMs),
            }));
          }
        })
        .catch(() => {
          if (!disposed) {
            setHealth(null);
            updateStarterTimeline((current) => ({
              ...current,
              healthRefreshMs: elapsedSince(healthStartedAtMs),
            }));
          }
        });
      const schemaStartedAtMs = performance.now();
      void client
        .schemaReadiness()
        .then((nextReadiness) => {
          if (!disposed) {
            setSchemaReadiness(nextReadiness);
            updateStarterTimeline((current) => ({
              ...current,
              schemaReadinessMs: elapsedSince(schemaStartedAtMs),
            }));
          }
        })
        .catch(() => {
          if (!disposed) {
            setSchemaReadiness(null);
            updateStarterTimeline((current) => ({
              ...current,
              schemaReadinessMs: elapsedSince(schemaStartedAtMs),
            }));
          }
        });
      const supportBundleStartedAtMs = performance.now();
      void client
        .exportSupportBundle({
          deploymentPreflight: {
            requiredRuntimeFeatures: syncularGeneratedRequiredRuntimeFeatures,
            storage: 'indexedDb',
            checkRuntimeAssets: false,
            minimumQuotaBytes: 50 * 1024 * 1024,
          },
        })
        .then((bundle) => {
          if (!disposed) {
            setSupportBundle(summarizeSupportBundle(bundle));
            updateStarterTimeline((current) => ({
              ...current,
              supportBundleExportMs: elapsedSince(supportBundleStartedAtMs),
            }));
          }
        })
        .catch(() => {
          if (!disposed) {
            setSupportBundle(failedSupportBundlePreview());
            updateStarterTimeline((current) => ({
              ...current,
              supportBundleExportMs: elapsedSince(supportBundleStartedAtMs),
            }));
          }
        });
    };
    refresh();
    const unsubscribeLifecycle = client.on('lifecycleChanged', refresh);
    const unsubscribeBootstrap = client.on('bootstrapChanged', refresh);
    return () => {
      disposed = true;
      unsubscribeLifecycle();
      unsubscribeBootstrap();
    };
  }, [client, updateStarterTimeline]);

  const rows = tasks ?? [];
  const doneCount = rows.filter((task) => task.completed).length;
  const queued = (outbox?.pending ?? 0) + (outbox?.sending ?? 0);

  const addTask = (event: FormEvent) => {
    event.preventDefault();
    const title = inputRef.current?.value.trim();
    if (!title) return;
    const taskId = crypto.randomUUID();
    const visibilityStartedAtMs = performance.now();
    inputRef.current!.value = '';
    updateStarterTimeline((current) => ({
      ...current,
      localVisibilityErrorCode: null,
      localVisibilityMs: null,
      localVisibilityStatus: 'running',
    }));
    void mutations.tasks
      .insert({
        id: taskId,
        title,
        completed: 0,
        user_id: appActorId,
        created_at: Date.now(),
      })
      .then(() =>
        client.awaitTaskVisibility(
          ({ selectFrom }) =>
            selectFrom('tasks').select('id').where('id', '=', taskId).limit(1),
          { timeoutMs: 5_000 }
        )
      )
      .then(() => {
        updateStarterTimeline((current) => ({
          ...current,
          localVisibilityErrorCode: null,
          localVisibilityMs: elapsedSince(visibilityStartedAtMs),
          localVisibilityStatus: 'visible',
        }));
      })
      .catch((error) => {
        updateStarterTimeline((current) => ({
          ...current,
          localVisibilityErrorCode: syncularErrorCode(error),
          localVisibilityMs: elapsedSince(visibilityStartedAtMs),
          localVisibilityStatus: 'failed',
        }));
      });
  };

  return (
    <>
      <div className="pane-header">
        <h2>Tasks</h2>
        <StatusBadge state={paneStatus(status)} />
      </div>

      {health ? <HealthLine health={health} /> : null}
      {schemaReadiness ? (
        <SchemaLine schemaReadiness={schemaReadiness} />
      ) : null}
      {supportBundle ? (
        <SupportBundleLine supportBundle={supportBundle} />
      ) : null}
      <StarterTimelineMarker starterTimeline={starterTimeline} />

      <form className="add-row" onSubmit={addTask}>
        <input ref={inputRef} aria-label="New task" placeholder="New task" />
        <button type="submit" aria-label="Add task">
          +
        </button>
      </form>

      {mutations.$error ? (
        <p className="error-line">{mutations.$error.message}</p>
      ) : null}
      {queryError ? <p className="error-line">{queryError.message}</p> : null}
      {queued > 0 ? (
        <p className="offline-line">
          {queued} queued change{queued === 1 ? '' : 's'} waiting to sync.
        </p>
      ) : null}

      <div className="task-list">
        {rows.length === 0 ? (
          <p className="empty-state">
            No tasks yet. Add one above — it is written to the local database
            first and synced in the background.
          </p>
        ) : (
          rows.map((task) => (
            <TaskItem key={task.id} task={task} mutations={mutations} />
          ))
        )}
      </div>

      <p className="pane-footnote">
        {rows.length} task{rows.length === 1 ? '' : 's'} · {doneCount} done
      </p>
    </>
  );
}

function StarterTimelineMarker({
  starterTimeline,
}: {
  starterTimeline: StarterTimelinePreview;
}) {
  return (
    <span
      data-syncular-starter-bootstrap-ready-ms={
        starterTimeline.bootstrapReadyMs ?? ''
      }
      data-syncular-starter-bootstrap-status={starterTimeline.bootstrapStatus}
      data-syncular-starter-database-open-ms={
        starterTimeline.databaseOpenMs ?? ''
      }
      data-syncular-starter-health-refresh-ms={
        starterTimeline.healthRefreshMs ?? ''
      }
      data-syncular-starter-local-visibility-error-code={
        starterTimeline.localVisibilityErrorCode ?? ''
      }
      data-syncular-starter-local-visibility-ms={
        starterTimeline.localVisibilityMs ?? ''
      }
      data-syncular-starter-local-visibility-status={
        starterTimeline.localVisibilityStatus
      }
      data-syncular-starter-realtime-connected-ms={
        starterTimeline.realtimeConnectedMs ?? ''
      }
      data-syncular-starter-realtime-status={starterTimeline.realtimeStatus}
      data-syncular-starter-schema-readiness-ms={
        starterTimeline.schemaReadinessMs ?? ''
      }
      data-syncular-starter-support-bundle-export-ms={
        starterTimeline.supportBundleExportMs ?? ''
      }
      hidden
    />
  );
}

function TaskItem({
  task,
  mutations,
}: {
  task: Task;
  mutations: ReturnType<typeof useMutations>;
}) {
  const toggle = () => {
    void mutations.tasks
      .update(
        task.id,
        { completed: task.completed ? 0 : 1 },
        { baseVersion: task.server_version }
      )
      .catch(() => undefined);
  };

  const remove = () => {
    void mutations.tasks
      .delete(task.id, { baseVersion: task.server_version })
      .catch(() => undefined);
  };

  return (
    <div className="task-row">
      <button
        className="icon-button"
        type="button"
        aria-label={task.completed ? 'Mark task open' : 'Mark task done'}
        onClick={toggle}
      >
        {task.completed ? '✓' : '○'}
      </button>
      <span className={task.completed ? 'done' : undefined}>{task.title}</span>
      <button
        className="icon-button muted"
        type="button"
        aria-label="Delete task"
        onClick={remove}
      >
        ×
      </button>
    </div>
  );
}

type SupportBundlePreview = {
  status: SyncularSupportBundle['summary']['status'] | 'failed';
  redacted: boolean;
  includedSections: number;
  issueCount: number;
  requestIdCount: number;
  sectionErrorCount: number;
};

function summarizeSupportBundle(
  bundle: SyncularSupportBundle
): SupportBundlePreview {
  return {
    status: bundle.summary.status,
    redacted: bundle.redacted,
    includedSections: Object.values(bundle.sections).filter(
      (sectionStatus) => sectionStatus === 'included'
    ).length,
    issueCount: bundle.summary.issueCodes.length,
    requestIdCount: bundle.summary.requestIds.length,
    sectionErrorCount: bundle.sectionErrors.length,
  };
}

function failedSupportBundlePreview(): SupportBundlePreview {
  return {
    status: 'failed',
    redacted: false,
    includedSections: 0,
    issueCount: 1,
    requestIdCount: 0,
    sectionErrorCount: 1,
  };
}

function SupportBundleLine({
  supportBundle,
}: {
  supportBundle: SupportBundlePreview;
}) {
  const label =
    supportBundle.status === 'failed'
      ? 'support bundle failed'
      : `support bundle ${supportBundle.status} · ${supportBundle.includedSections} sections · redacted`;

  return (
    <p
      className={`health-line ${supportBundle.status}`}
      data-syncular-support-bundle-issue-count={supportBundle.issueCount}
      data-syncular-support-bundle-redacted={String(supportBundle.redacted)}
      data-syncular-support-bundle-request-id-count={
        supportBundle.requestIdCount
      }
      data-syncular-support-bundle-section-count={
        supportBundle.includedSections
      }
      data-syncular-support-bundle-section-error-count={
        supportBundle.sectionErrorCount
      }
      data-syncular-support-bundle-status={supportBundle.status}
    >
      {label}
    </p>
  );
}

function SchemaLine({
  schemaReadiness,
}: {
  schemaReadiness: SyncularSchemaReadinessResult;
}) {
  const label =
    schemaReadiness.status === 'ready'
      ? `schema v${schemaReadiness.generatedSchemaVersion ?? 'unknown'} ready`
      : `schema ${schemaReadiness.status}`;

  return <p className={`health-line ${schemaReadiness.status}`}>{label}</p>;
}

function HealthLine({ health }: { health: SyncularBrowserHealth }) {
  const storage = health.persistence.effectiveStorage ?? 'unknown';
  const storageLabel =
    health.persistence.durable === true
      ? `${storage} durable`
      : health.persistence.durable === false
        ? `${storage} memory`
        : 'storage pending';
  const subscriptions =
    health.subscriptions.total === 0
      ? 'no subscriptions'
      : `${health.subscriptions.ready}/${health.subscriptions.total} subscriptions`;

  return (
    <p className={`health-line ${health.status}`}>
      {storageLabel} · {subscriptions} · realtime {health.realtime.state}
    </p>
  );
}

type PaneStatus = 'syncing' | 'offline' | 'attention' | 'error' | 'ready';

function StatusBadge({ state }: { state: PaneStatus }) {
  const label =
    state === 'syncing'
      ? 'Syncing'
      : state === 'offline'
        ? 'Offline'
        : state === 'attention'
          ? 'Review'
          : state === 'error'
            ? 'Error'
            : 'Ready';

  return (
    <div className={`status-badge ${state}`}>
      <span className="status-dot" />
      <span>{label}</span>
    </div>
  );
}

function paneStatus(status: SyncularClientStatus): PaneStatus {
  const phase = status.lifecycle.phase;
  if (phase === 'syncing' || phase === 'recovering' || phase === 'connecting') {
    return 'syncing';
  }
  if (phase === 'offline') return 'offline';
  if (phase === 'authRequired') return 'error';
  if (status.requiresAction || phase === 'degraded') return 'attention';
  return 'ready';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function syncularErrorCode(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : error.name;
  }
  return typeof error;
}

function elapsedSince(startedAtMs: number): number {
  return Math.max(0, Math.round(performance.now() - startedAtMs));
}
