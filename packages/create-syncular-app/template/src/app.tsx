import {
  evaluateSyncularBrowserSupportPolicy,
  getSyncularBrowserDeploymentPreflight,
  getSyncularBrowserHealth,
  installSyncularBrowserLifecycleResume,
  type SyncularBrowserDeploymentPreflight,
  type SyncularBrowserHealth,
  type SyncularBrowserLifecyclePauseReason,
  type SyncularBrowserLifecycleResumeController,
  type SyncularBrowserLifecycleResumeLockState,
  type SyncularBrowserSupportPolicyEvaluation,
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
  lastPauseReason: SyncularBrowserLifecyclePauseReason | null;
  lastReason: string | null;
  lockName: string | null;
  lockRequired: boolean;
  lockState: SyncularBrowserLifecycleResumeLockState;
  lockTimeoutMs: number | null;
  pagehidePersisted: boolean | null;
  pauseCount: number;
  status: 'idle' | 'running' | 'complete' | 'failed';
  shutdownSignalCount: number;
  visibilityState: string | null;
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

type DeploymentPreflightPreview = {
  actionCount: number;
  availableBytes: number | null;
  issueCount: number;
  minimumAvailableBytes: number | null;
  minimumQuotaBytes: number | null;
  persistence: SyncularBrowserDeploymentPreflight['support']['persistence'];
  persisted: boolean | null;
  preflightMs: number;
  quotaPressure: SyncularBrowserDeploymentPreflight['storage']['quotaPressure'];
  quotaBytes: number | null;
  status: SyncularBrowserDeploymentPreflight['status'] | 'failed';
  supportTier: SyncularBrowserDeploymentPreflight['support']['tier'];
  usageRatio: number | null;
  usageBytes: number | null;
};

type BrowserSupportPolicyPreview = {
  actionCount: number;
  context: SyncularBrowserSupportPolicyEvaluation['context'];
  expectedPersistence: SyncularBrowserSupportPolicyEvaluation['expectedPersistence'];
  expectedSupportTier: SyncularBrowserSupportPolicyEvaluation['expectedSupportTier'];
  issueCount: number;
  knownRisks: readonly string[];
  nextSteps: readonly string[];
  observedPersistence: SyncularBrowserSupportPolicyEvaluation['observedPersistence'];
  observedSupportTier: SyncularBrowserSupportPolicyEvaluation['observedSupportTier'];
  policy: SyncularBrowserSupportPolicyEvaluation['policy'];
  preflightRequired: boolean;
  reasonCodes: readonly string[];
  requiredEvidence: readonly string[];
  status: SyncularBrowserSupportPolicyEvaluation['status'];
};

const initialLifecycleResume: LifecycleResumePreview = {
  count: 0,
  error: null,
  lastPauseReason: null,
  lastReason: null,
  lockName: null,
  lockRequired: false,
  lockState: 'not-requested',
  lockTimeoutMs: null,
  pagehidePersisted: null,
  pauseCount: 0,
  status: 'idle',
  shutdownSignalCount: 0,
  visibilityState: null,
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

const starterDeploymentPreflightOptions = {
  requiredRuntimeFeatures: syncularGeneratedRequiredRuntimeFeatures,
  storage: 'indexedDb',
  checkRuntimeAssets: false,
  minimumAvailableBytes: 25 * 1024 * 1024,
  minimumQuotaBytes: 50 * 1024 * 1024,
} as const;

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
          lock: {
            name: 'syncular:create-syncular-app:lifecycle-resume',
            timeoutMs: 10_000,
          },
          onResumeStart(context) {
            if (!disposed) {
              setLifecycleResume((current) => ({
                ...current,
                error: null,
                lastReason: context.reason,
                lockName: context.lockName ?? null,
                lockRequired: context.lockRequired,
                lockState: context.lockState,
                lockTimeoutMs: context.lockTimeoutMs ?? null,
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
                lockName: context.lockName ?? null,
                lockRequired: context.lockRequired,
                lockState: context.lockState,
                lockTimeoutMs: context.lockTimeoutMs ?? null,
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
                lockName: context.lockName ?? null,
                lockRequired: context.lockRequired,
                lockState: context.lockState,
                lockTimeoutMs: context.lockTimeoutMs ?? null,
                status: 'failed',
              }));
            }
          },
          onPause(context) {
            if (!disposed) {
              setLifecycleResume((current) => ({
                ...current,
                lastPauseReason: context.reason,
                pagehidePersisted:
                  context.reason === 'pagehide'
                    ? context.persisted === true
                    : current.pagehidePersisted,
                pauseCount: current.pauseCount + 1,
                shutdownSignalCount:
                  current.shutdownSignalCount +
                  (context.reason === 'beforeunload' ? 1 : 0),
                visibilityState: context.visibilityState,
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
      data-syncular-lifecycle-resume-lock-name={lifecycleResume.lockName ?? ''}
      data-syncular-lifecycle-resume-lock-required={String(
        lifecycleResume.lockRequired
      )}
      data-syncular-lifecycle-resume-lock-state={lifecycleResume.lockState}
      data-syncular-lifecycle-resume-lock-timeout-ms={
        lifecycleResume.lockTimeoutMs ?? ''
      }
      data-syncular-lifecycle-pause-count={lifecycleResume.pauseCount}
      data-syncular-lifecycle-pause-pagehide-persisted={
        lifecycleResume.pagehidePersisted === null
          ? ''
          : String(lifecycleResume.pagehidePersisted)
      }
      data-syncular-lifecycle-pause-reason={
        lifecycleResume.lastPauseReason ?? ''
      }
      data-syncular-lifecycle-pause-shutdown-signal-count={
        lifecycleResume.shutdownSignalCount
      }
      data-syncular-lifecycle-pause-visibility-state={
        lifecycleResume.visibilityState ?? ''
      }
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
  const [deploymentPreflight, setDeploymentPreflight] =
    useState<DeploymentPreflightPreview | null>(null);
  const [browserSupportPolicy, setBrowserSupportPolicy] =
    useState<BrowserSupportPolicyPreview | null>(null);
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
      const preflightStartedAtMs = performance.now();
      void getSyncularBrowserDeploymentPreflight(
        starterDeploymentPreflightOptions
      )
        .then((preflight) => {
          if (!disposed) {
            setDeploymentPreflight(
              summarizeDeploymentPreflight(
                preflight,
                elapsedSince(preflightStartedAtMs)
              )
            );
            setBrowserSupportPolicy(
              summarizeBrowserSupportPolicy(
                evaluateSyncularBrowserSupportPolicy(
                  'chromium-secure-page',
                  preflight
                )
              )
            );
          }
          return client.exportSupportBundle({
            deploymentPreflight: preflight,
          });
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
            setDeploymentPreflight(
              failedDeploymentPreflightPreview(
                elapsedSince(preflightStartedAtMs)
              )
            );
            setBrowserSupportPolicy(
              summarizeBrowserSupportPolicy(
                evaluateSyncularBrowserSupportPolicy(
                  'chromium-secure-page',
                  null
                )
              )
            );
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
    const unsubscribeRows = client.on('rowsChanged', refresh);
    return () => {
      disposed = true;
      unsubscribeLifecycle();
      unsubscribeBootstrap();
      unsubscribeRows();
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
      {deploymentPreflight ? (
        <DeploymentPreflightMarker deploymentPreflight={deploymentPreflight} />
      ) : null}
      {browserSupportPolicy ? (
        <BrowserSupportPolicyMarker
          browserSupportPolicy={browserSupportPolicy}
        />
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

function DeploymentPreflightMarker({
  deploymentPreflight,
}: {
  deploymentPreflight: DeploymentPreflightPreview;
}) {
  return (
    <span
      data-syncular-deployment-preflight-action-count={
        deploymentPreflight.actionCount
      }
      data-syncular-deployment-preflight-available-bytes={
        deploymentPreflight.availableBytes ?? ''
      }
      data-syncular-deployment-preflight-issue-count={
        deploymentPreflight.issueCount
      }
      data-syncular-deployment-preflight-minimum-available-bytes={
        deploymentPreflight.minimumAvailableBytes ?? ''
      }
      data-syncular-deployment-preflight-minimum-quota-bytes={
        deploymentPreflight.minimumQuotaBytes ?? ''
      }
      data-syncular-deployment-preflight-persistence={
        deploymentPreflight.persistence
      }
      data-syncular-deployment-preflight-persisted={
        deploymentPreflight.persisted === null
          ? ''
          : String(deploymentPreflight.persisted)
      }
      data-syncular-deployment-preflight-preflight-ms={
        deploymentPreflight.preflightMs
      }
      data-syncular-deployment-preflight-quota-pressure={
        deploymentPreflight.quotaPressure
      }
      data-syncular-deployment-preflight-quota-bytes={
        deploymentPreflight.quotaBytes ?? ''
      }
      data-syncular-deployment-preflight-status={deploymentPreflight.status}
      data-syncular-deployment-preflight-support-tier={
        deploymentPreflight.supportTier
      }
      data-syncular-deployment-preflight-usage-bytes={
        deploymentPreflight.usageBytes ?? ''
      }
      data-syncular-deployment-preflight-usage-ratio={
        deploymentPreflight.usageRatio ?? ''
      }
      hidden
    />
  );
}

type SupportBundlePreview = {
  status: SyncularSupportBundle['summary']['status'] | 'failed';
  redacted: boolean;
  blobEventCount: number;
  cursorCount: number;
  includedSections: number;
  issueCount: number;
  latestBlobCode: string | null;
  latestLocalApplyCode: string | null;
  latestRealtimeCode: string | null;
  latestSyncCode: string | null;
  localApplyEventCount: number;
  realtimeEventCount: number;
  requestIdCount: number;
  sectionErrorCount: number;
  syncAttemptIdCount: number;
  syncEventCount: number;
  timelineEventCount: number;
};

function summarizeDeploymentPreflight(
  preflight: SyncularBrowserDeploymentPreflight,
  preflightMs: number
): DeploymentPreflightPreview {
  return {
    actionCount: preflight.support.recommendedActions.length,
    availableBytes: preflight.storage.availableBytes ?? null,
    issueCount: preflight.issues.length,
    minimumAvailableBytes: preflight.storage.minimumAvailableBytes ?? null,
    minimumQuotaBytes: preflight.storage.minimumQuotaBytes ?? null,
    persistence: preflight.support.persistence,
    persisted: preflight.storage.persisted ?? null,
    preflightMs,
    quotaPressure: preflight.storage.quotaPressure,
    quotaBytes: preflight.storage.quotaBytes ?? null,
    status: preflight.status,
    supportTier: preflight.support.tier,
    usageRatio: preflight.storage.usageRatio ?? null,
    usageBytes: preflight.storage.usageBytes ?? null,
  };
}

function failedDeploymentPreflightPreview(
  preflightMs: number
): DeploymentPreflightPreview {
  return {
    actionCount: 1,
    availableBytes: null,
    issueCount: 1,
    minimumAvailableBytes:
      starterDeploymentPreflightOptions.minimumAvailableBytes,
    minimumQuotaBytes: starterDeploymentPreflightOptions.minimumQuotaBytes,
    persistence: 'unknown',
    persisted: null,
    preflightMs,
    quotaPressure: 'unknown',
    quotaBytes: null,
    status: 'failed',
    supportTier: 'unknown',
    usageRatio: null,
    usageBytes: null,
  };
}

function summarizeBrowserSupportPolicy(
  evaluation: SyncularBrowserSupportPolicyEvaluation
): BrowserSupportPolicyPreview {
  return {
    actionCount: evaluation.recommendedActions.length,
    context: evaluation.context,
    expectedPersistence: evaluation.expectedPersistence,
    expectedSupportTier: evaluation.expectedSupportTier,
    issueCount: evaluation.issueCodes.length,
    knownRisks: evaluation.knownRisks,
    nextSteps: evaluation.nextSteps,
    observedPersistence: evaluation.observedPersistence,
    observedSupportTier: evaluation.observedSupportTier,
    policy: evaluation.policy,
    preflightRequired: evaluation.preflightRequired,
    reasonCodes: evaluation.reasonCodes,
    requiredEvidence: evaluation.requiredEvidence,
    status: evaluation.status,
  };
}

function BrowserSupportPolicyMarker({
  browserSupportPolicy,
}: {
  browserSupportPolicy: BrowserSupportPolicyPreview;
}) {
  return (
    <span
      data-syncular-browser-support-policy-action-count={
        browserSupportPolicy.actionCount
      }
      data-syncular-browser-support-policy-context={
        browserSupportPolicy.context
      }
      data-syncular-browser-support-policy-expected-persistence={
        browserSupportPolicy.expectedPersistence
      }
      data-syncular-browser-support-policy-expected-support-tier={
        browserSupportPolicy.expectedSupportTier
      }
      data-syncular-browser-support-policy-issue-count={
        browserSupportPolicy.issueCount
      }
      data-syncular-browser-support-policy-known-risks={JSON.stringify(
        browserSupportPolicy.knownRisks
      )}
      data-syncular-browser-support-policy-known-risk-count={
        browserSupportPolicy.knownRisks.length
      }
      data-syncular-browser-support-policy-next-step-count={
        browserSupportPolicy.nextSteps.length
      }
      data-syncular-browser-support-policy-next-steps={JSON.stringify(
        browserSupportPolicy.nextSteps
      )}
      data-syncular-browser-support-policy-observed-persistence={
        browserSupportPolicy.observedPersistence ?? ''
      }
      data-syncular-browser-support-policy-observed-support-tier={
        browserSupportPolicy.observedSupportTier ?? ''
      }
      data-syncular-browser-support-policy-preflight-required={String(
        browserSupportPolicy.preflightRequired
      )}
      data-syncular-browser-support-policy-policy={browserSupportPolicy.policy}
      data-syncular-browser-support-policy-reason-codes={browserSupportPolicy.reasonCodes.join(
        ','
      )}
      data-syncular-browser-support-policy-reason-count={
        browserSupportPolicy.reasonCodes.length
      }
      data-syncular-browser-support-policy-required-evidence={JSON.stringify(
        browserSupportPolicy.requiredEvidence
      )}
      data-syncular-browser-support-policy-required-evidence-count={
        browserSupportPolicy.requiredEvidence.length
      }
      data-syncular-browser-support-policy-status={browserSupportPolicy.status}
      hidden
    />
  );
}

function summarizeSupportBundle(
  bundle: SyncularSupportBundle
): SupportBundlePreview {
  const timelineEvents = bundle.runtimeTimeline?.events ?? [];
  return {
    status: bundle.summary.status,
    redacted: bundle.redacted,
    blobEventCount: countTimelinePhase(timelineEvents, 'blob'),
    cursorCount: timelineEvents.filter((event) => event.cursor != null).length,
    includedSections: Object.values(bundle.sections).filter(
      (sectionStatus) => sectionStatus === 'included'
    ).length,
    issueCount: bundle.summary.issueCodes.length,
    latestBlobCode: latestTimelineCode(timelineEvents, 'blob'),
    latestLocalApplyCode: latestTimelineCode(timelineEvents, 'local-apply'),
    latestRealtimeCode: latestTimelineCode(timelineEvents, 'realtime'),
    latestSyncCode: latestTimelineCode(timelineEvents, 'sync'),
    localApplyEventCount: countTimelinePhase(timelineEvents, 'local-apply'),
    realtimeEventCount: countTimelinePhase(timelineEvents, 'realtime'),
    requestIdCount: bundle.summary.requestIds.length,
    sectionErrorCount: bundle.sectionErrors.length,
    syncAttemptIdCount: bundle.summary.syncAttemptIds.length,
    syncEventCount: countTimelinePhase(timelineEvents, 'sync'),
    timelineEventCount: timelineEvents.length,
  };
}

function failedSupportBundlePreview(): SupportBundlePreview {
  return {
    status: 'failed',
    redacted: false,
    blobEventCount: 0,
    cursorCount: 0,
    includedSections: 0,
    issueCount: 1,
    latestBlobCode: null,
    latestLocalApplyCode: null,
    latestRealtimeCode: null,
    latestSyncCode: null,
    localApplyEventCount: 0,
    realtimeEventCount: 0,
    requestIdCount: 0,
    sectionErrorCount: 1,
    syncAttemptIdCount: 0,
    syncEventCount: 0,
    timelineEventCount: 0,
  };
}

function countTimelinePhase(
  events: NonNullable<SyncularSupportBundle['runtimeTimeline']>['events'],
  phase: string
): number {
  return events.filter((event) => event.phase === phase).length;
}

function latestTimelineCode(
  events: NonNullable<SyncularSupportBundle['runtimeTimeline']>['events'],
  phase: string
): string | null {
  return events.findLast((event) => event.phase === phase)?.code ?? null;
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
      data-syncular-support-bundle-blob-event-count={
        supportBundle.blobEventCount
      }
      data-syncular-support-bundle-cursor-count={supportBundle.cursorCount}
      data-syncular-support-bundle-issue-count={supportBundle.issueCount}
      data-syncular-support-bundle-latest-blob-code={
        supportBundle.latestBlobCode ?? ''
      }
      data-syncular-support-bundle-latest-local-apply-code={
        supportBundle.latestLocalApplyCode ?? ''
      }
      data-syncular-support-bundle-latest-realtime-code={
        supportBundle.latestRealtimeCode ?? ''
      }
      data-syncular-support-bundle-latest-sync-code={
        supportBundle.latestSyncCode ?? ''
      }
      data-syncular-support-bundle-local-apply-event-count={
        supportBundle.localApplyEventCount
      }
      data-syncular-support-bundle-redacted={String(supportBundle.redacted)}
      data-syncular-support-bundle-realtime-event-count={
        supportBundle.realtimeEventCount
      }
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
      data-syncular-support-bundle-sync-attempt-id-count={
        supportBundle.syncAttemptIdCount
      }
      data-syncular-support-bundle-sync-event-count={
        supportBundle.syncEventCount
      }
      data-syncular-support-bundle-timeline-event-count={
        supportBundle.timelineEventCount
      }
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
