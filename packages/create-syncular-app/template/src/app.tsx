import {
  evaluateSyncularBrowserSupportPolicy,
  getSyncularBrowserDeploymentPreflight,
  getSyncularBrowserHealth,
  getSyncularBrowserSupportPolicyContextHint,
  installSyncularBrowserLifecycleResume,
  type SyncularBrowserDeploymentPreflight,
  type SyncularBrowserDeploymentPreflightNavigator,
  type SyncularBrowserHealth,
  type SyncularBrowserLifecyclePauseReason,
  type SyncularBrowserLifecycleResumeController,
  type SyncularBrowserLifecycleResumeLockState,
  type SyncularBrowserSupportPolicyEvaluation,
  type SyncularClientStatus,
  type SyncularDiagnosticEvent,
  type SyncularLocalRecoveryActionLockState,
  type SyncularSchemaReadinessResult,
  type SyncularSupportBundle,
} from '@syncular/client';
import { createSyncularReact } from '@syncular/client/react';
import type { Dispatch, FormEvent, SetStateAction } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type AppDb,
  type AppSyncClient,
  appActorId,
  currentStarterStorage,
  installAppClientSubscriptions,
  openAppClient,
  type StarterOpenPhase,
  syncularGeneratedRequiredRuntimeFeatures,
  syncularStarterRuntimeArtifacts,
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

type LocalRecoveryProofPreview = {
  actionKind: string | null;
  count: number;
  error: string | null;
  errorCode: string | null;
  lockName: string | null;
  lockRequired: boolean;
  lockState: SyncularLocalRecoveryActionLockState;
  lockTimeoutMs: number | null;
  status: 'idle' | 'running' | 'complete' | 'failed';
};

type StorageRecoveryProofPreview = {
  actionKinds: string[];
  availableBytes: number | null;
  clearBlobCacheCompleted: boolean;
  compactCompleted: boolean;
  count: number;
  error: string | null;
  errorCode: string | null;
  issueCodes: string[];
  issueCount: number;
  planActionCount: number;
  quotaBytes: number | null;
  quotaPressure: SyncularBrowserDeploymentPreflight['storage']['quotaPressure'];
  requestPersistenceGranted: boolean | null;
  requestPersistenceOffered: boolean;
  requestPersistenceSupported: boolean | null;
  source: 'synthetic' | 'browser-observed' | null;
  status: 'idle' | 'running' | 'complete' | 'failed';
  usageBytes: number | null;
  usageRatio: number | null;
};

type QuotaPressureProofPreview = {
  actionCount: number;
  availableBytes: number | null;
  count: number;
  error: string | null;
  errorCode: string | null;
  issueCodes: string[];
  issueCount: number;
  persistence: SyncularBrowserDeploymentPreflight['support']['persistence'];
  quotaBytes: number | null;
  quotaPressure: SyncularBrowserDeploymentPreflight['storage']['quotaPressure'];
  status: 'idle' | 'running' | 'complete' | 'failed';
  supportTier: SyncularBrowserDeploymentPreflight['support']['tier'];
  usageBytes: number | null;
  usageRatio: number | null;
};

type QuotaPressureProofDetail = {
  quotaBytes: number;
  usageBytes: number;
};

type WritePressureProofPreview = {
  durationMs: number | null;
  error: string | null;
  errorCode: string | null;
  requestedCount: number;
  runCount: number;
  status: 'idle' | 'running' | 'complete' | 'failed';
  titlePrefix: string | null;
  visibleCount: number;
};

type QuotaExhaustionWriteProofPreview = {
  attemptedBytes: number;
  availableBytes: number | null;
  count: number;
  durationMs: number | null;
  error: string | null;
  errorCode: string | null;
  quotaBytes: number | null;
  status: 'idle' | 'running' | 'complete' | 'failed';
  usageBytes: number | null;
  usageRatio: number | null;
  writeFailed: boolean;
};

type StarterOpenPreview = {
  diagnosticCode: string | null;
  diagnosticCount: number;
  diagnosticLevel: string | null;
  diagnosticSource: string | null;
  error: string | null;
  phase: StarterOpenPhase;
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
  serviceWorker: boolean | null;
  serviceWorkerControlled: boolean | null;
  serviceWorkerControllerScriptPath: string | null;
  serviceWorkerControllerState: string | null;
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

const initialLocalRecoveryProof: LocalRecoveryProofPreview = {
  actionKind: null,
  count: 0,
  error: null,
  errorCode: null,
  lockName: null,
  lockRequired: false,
  lockState: 'not-requested',
  lockTimeoutMs: null,
  status: 'idle',
};

const initialStorageRecoveryProof: StorageRecoveryProofPreview = {
  actionKinds: [],
  availableBytes: null,
  clearBlobCacheCompleted: false,
  compactCompleted: false,
  count: 0,
  error: null,
  errorCode: null,
  issueCodes: [],
  issueCount: 0,
  planActionCount: 0,
  quotaBytes: null,
  quotaPressure: 'unknown',
  requestPersistenceGranted: null,
  requestPersistenceOffered: false,
  requestPersistenceSupported: null,
  source: null,
  status: 'idle',
  usageBytes: null,
  usageRatio: null,
};

const initialQuotaPressureProof: QuotaPressureProofPreview = {
  actionCount: 0,
  availableBytes: null,
  count: 0,
  error: null,
  errorCode: null,
  issueCodes: [],
  issueCount: 0,
  persistence: 'unknown',
  quotaBytes: null,
  quotaPressure: 'unknown',
  status: 'idle',
  supportTier: 'unknown',
  usageBytes: null,
  usageRatio: null,
};

const initialWritePressureProof: WritePressureProofPreview = {
  durationMs: null,
  error: null,
  errorCode: null,
  requestedCount: 0,
  runCount: 0,
  status: 'idle',
  titlePrefix: null,
  visibleCount: 0,
};

const initialQuotaExhaustionWriteProof: QuotaExhaustionWriteProofPreview = {
  attemptedBytes: 0,
  availableBytes: null,
  count: 0,
  durationMs: null,
  error: null,
  errorCode: null,
  quotaBytes: null,
  status: 'idle',
  usageBytes: null,
  usageRatio: null,
  writeFailed: false,
};

const initialStarterOpen: StarterOpenPreview = {
  diagnosticCode: null,
  diagnosticCount: 0,
  diagnosticLevel: null,
  diagnosticSource: null,
  error: null,
  phase: 'idle',
};

const appStartedAtMs = performance.now();
const starterLocalRecoveryLockName =
  'syncular:create-syncular-app:local-recovery';
const starterLocalRecoveryLockTimeoutMs = 1_000;

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
  runtimeArtifacts: syncularStarterRuntimeArtifacts,
  storage: currentStarterStorage(),
  minimumAvailableBytes: 25 * 1024 * 1024,
  minimumQuotaBytes: 50 * 1024 * 1024,
} as const;

function yieldStarterFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame !== 'function') {
      setTimeout(resolve, 0);
      return;
    }
    requestAnimationFrame(() => setTimeout(resolve, 0));
  });
}

export function App() {
  const [client, setClient] = useState<AppSyncClient | null>(null);
  const [lifecycleResume, setLifecycleResume] =
    useState<LifecycleResumePreview>(initialLifecycleResume);
  const [openError, setOpenError] = useState<string | null>(null);
  const [starterOpen, setStarterOpen] =
    useState<StarterOpenPreview>(initialStarterOpen);
  const [starterTimeline, setStarterTimeline] =
    useState<StarterTimelinePreview>(initialStarterTimeline);
  const [taskPaneMounted, setTaskPaneMounted] = useState(false);

  const writeStarterOpenMarker = useCallback(
    (next: Partial<StarterOpenPreview>) => {
      const marker = document.querySelector<HTMLElement>(
        '[data-syncular-starter-open-phase]'
      );
      if (!marker) return;
      if (next.diagnosticCode !== undefined) {
        marker.setAttribute(
          'data-syncular-starter-open-diagnostic-code',
          next.diagnosticCode ?? ''
        );
      }
      if (next.diagnosticCount !== undefined) {
        marker.setAttribute(
          'data-syncular-starter-open-diagnostic-count',
          String(next.diagnosticCount)
        );
      }
      if (next.diagnosticLevel !== undefined) {
        marker.setAttribute(
          'data-syncular-starter-open-diagnostic-level',
          next.diagnosticLevel ?? ''
        );
      }
      if (next.diagnosticSource !== undefined) {
        marker.setAttribute(
          'data-syncular-starter-open-diagnostic-source',
          next.diagnosticSource ?? ''
        );
      }
      if (next.error !== undefined) {
        marker.setAttribute(
          'data-syncular-starter-open-error',
          next.error ?? ''
        );
      }
      if (next.phase !== undefined) {
        marker.setAttribute('data-syncular-starter-open-phase', next.phase);
      }
    },
    []
  );

  const reportStarterOpenPhase = useCallback(
    (phase: StarterOpenPhase) => {
      console.info('[syncular-starter]', 'open', phase);
      writeStarterOpenMarker({ error: null, phase });
      setStarterOpen((current) => ({ ...current, error: null, phase }));
    },
    [writeStarterOpenMarker]
  );

  const reportStarterOpenError = useCallback(
    (error: unknown) => {
      const message = errorMessage(error);
      setOpenError(message);
      writeStarterOpenMarker({ error: message });
      setStarterOpen((current) => ({ ...current, error: message }));
    },
    [writeStarterOpenMarker]
  );

  useEffect(() => {
    let disposed = false;
    let opened: AppSyncClient | null = null;
    let lifecycleResume: SyncularBrowserLifecycleResumeController | null = null;
    const reportPhase = (phase: StarterOpenPhase) => {
      if (!disposed) {
        reportStarterOpenPhase(phase);
      }
    };
    const reportDiagnostic = (event: SyncularDiagnosticEvent) => {
      console.info('[syncular-starter]', event.source, event.code);
      if (!disposed) {
        setStarterOpen((current) => {
          const next = {
            ...current,
            diagnosticCode: event.code,
            diagnosticCount: current.diagnosticCount + 1,
            diagnosticLevel: event.level,
            diagnosticSource: event.source,
          };
          writeStarterOpenMarker(next);
          return next;
        });
      }
    };

    void openAppClient({
      onDiagnostic: reportDiagnostic,
      onPhase: reportPhase,
    })
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
                ...current,
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
        setTaskPaneMounted(false);
        setClient(nextClient);
      })
      .catch((error) => {
        if (!disposed) {
          reportStarterOpenError(error);
        }
      });

    return () => {
      disposed = true;
      lifecycleResume?.destroy();
      if (opened) void opened.close().catch(() => undefined);
    };
  }, [reportStarterOpenError, reportStarterOpenPhase, writeStarterOpenMarker]);

  useEffect(() => {
    if (!client) return undefined;
    let disposed = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const frame = requestAnimationFrame(() => {
      timeout = setTimeout(() => {
        void (async () => {
          reportStarterOpenPhase('subscriptions');
          await installAppClientSubscriptions(client);
          if (disposed) return;
          reportStarterOpenPhase('sync');
          await client.start();
          if (disposed) return;
          reportStarterOpenPhase('taskpane');
          setTaskPaneMounted(true);
        })().catch((error) => {
          if (!disposed) reportStarterOpenError(error);
        });
      }, 0);
    });
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      if (timeout) clearTimeout(timeout);
    };
  }, [client, reportStarterOpenError, reportStarterOpenPhase]);

  return (
    <main className="app-shell">
      <header className="topbar">
        <p className="eyebrow">Syncular</p>
        <h1>Local-first tasks</h1>
      </header>
      <StarterOpenMarker starterOpen={starterOpen} />

      {openError ? <p className="error-line">{openError}</p> : null}

      <section className="client-pane" aria-label="Tasks">
        {client ? (
          <SyncProvider client={client}>
            <LifecycleResumeMarker lifecycleResume={lifecycleResume} />
            {taskPaneMounted ? (
              <TaskPane
                client={client}
                reportStarterOpenPhase={reportStarterOpenPhase}
                starterTimeline={starterTimeline}
                updateStarterTimeline={setStarterTimeline}
              />
            ) : (
              <StarterReadyPane starterTimeline={starterTimeline} />
            )}
          </SyncProvider>
        ) : (
          <p className="empty-state">Opening local database…</p>
        )}
      </section>
    </main>
  );
}

function StarterReadyPane({
  starterTimeline,
}: {
  starterTimeline: StarterTimelinePreview;
}) {
  return (
    <>
      <div className="pane-header">
        <h2>Tasks</h2>
        <StatusBadge state="loading" />
      </div>
      <StarterTimelineMarker starterTimeline={starterTimeline} />
      <p className="empty-state">Local database ready. Starting sync…</p>
    </>
  );
}

function StarterOpenMarker({
  starterOpen,
}: {
  starterOpen: StarterOpenPreview;
}) {
  return (
    <span
      data-syncular-starter-open-diagnostic-code={
        starterOpen.diagnosticCode ?? ''
      }
      data-syncular-starter-open-diagnostic-count={starterOpen.diagnosticCount}
      data-syncular-starter-open-diagnostic-level={
        starterOpen.diagnosticLevel ?? ''
      }
      data-syncular-starter-open-diagnostic-source={
        starterOpen.diagnosticSource ?? ''
      }
      data-syncular-starter-open-error={starterOpen.error ?? ''}
      data-syncular-starter-open-phase={starterOpen.phase}
      hidden
    />
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
  reportStarterOpenPhase,
  starterTimeline,
  updateStarterTimeline,
}: {
  client: AppSyncClient;
  reportStarterOpenPhase: (phase: StarterOpenPhase) => void;
  starterTimeline: StarterTimelinePreview;
  updateStarterTimeline: Dispatch<SetStateAction<StarterTimelinePreview>>;
}) {
  // Live query: re-renders whenever synced rows change, locally or remotely.
  const {
    data: tasks,
    error: queryError,
    refetch: refetchTasks,
  } = useSyncQuery(
    ({ selectFrom }) =>
      selectFrom('tasks')
        .selectAll()
        .orderBy('completed', 'asc')
        .orderBy('created_at', 'desc'),
    { refreshOnDataChange: false, tables: ['tasks'] }
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
  const [localRecoveryProof, setLocalRecoveryProof] =
    useState<LocalRecoveryProofPreview>(initialLocalRecoveryProof);
  const [storageRecoveryProof, setStorageRecoveryProof] =
    useState<StorageRecoveryProofPreview>(initialStorageRecoveryProof);
  const [quotaPressureProof, setQuotaPressureProof] =
    useState<QuotaPressureProofPreview>(initialQuotaPressureProof);
  const [writePressureProof, setWritePressureProof] =
    useState<WritePressureProofPreview>(initialWritePressureProof);
  const [quotaExhaustionWriteProof, setQuotaExhaustionWriteProof] =
    useState<QuotaExhaustionWriteProofPreview>(
      initialQuotaExhaustionWriteProof
    );
  const localRecoveryProofRunning = useRef(false);
  const storageRecoveryProofRunning = useRef(false);
  const quotaPressureProofRunning = useRef(false);
  const writePressureProofRunning = useRef(false);
  const quotaExhaustionWriteProofRunning = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    console.info('[syncular-starter]', 'taskpane', 'mounted');
    return client.on('rowsChanged', (event) => {
      if (event.changedTables.includes('tasks')) void refetchTasks();
    });
  }, [client, refetchTasks]);

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
    let refreshQueued = false;
    let refreshRunning = false;

    const runRefresh = async () => {
      reportStarterOpenPhase('diagnostics-health');
      await yieldStarterFrame();
      const healthStartedAtMs = performance.now();
      try {
        const nextHealth = await getSyncularBrowserHealth(client);
        if (!disposed) {
          setHealth(nextHealth);
          updateStarterTimeline((current) => ({
            ...current,
            healthRefreshMs: elapsedSince(healthStartedAtMs),
          }));
        }
      } catch {
        if (!disposed) {
          setHealth(null);
          updateStarterTimeline((current) => ({
            ...current,
            healthRefreshMs: elapsedSince(healthStartedAtMs),
          }));
        }
      }

      reportStarterOpenPhase('diagnostics-schema');
      await yieldStarterFrame();
      const schemaStartedAtMs = performance.now();
      try {
        const nextReadiness = await client.schemaReadiness();
        if (!disposed) {
          setSchemaReadiness(nextReadiness);
          updateStarterTimeline((current) => ({
            ...current,
            schemaReadinessMs: elapsedSince(schemaStartedAtMs),
          }));
        }
      } catch {
        if (!disposed) {
          setSchemaReadiness(null);
          updateStarterTimeline((current) => ({
            ...current,
            schemaReadinessMs: elapsedSince(schemaStartedAtMs),
          }));
        }
      }

      reportStarterOpenPhase('diagnostics-preflight');
      await yieldStarterFrame();
      const preflightStartedAtMs = performance.now();
      let preflight: SyncularBrowserDeploymentPreflight | null = null;
      try {
        preflight = await getSyncularBrowserDeploymentPreflight(
          starterDeploymentPreflightOptions
        );
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
                getSyncularBrowserSupportPolicyContextHint({
                  preflight,
                }).context,
                preflight
              )
            )
          );
        }
      } catch {
        if (!disposed) {
          setDeploymentPreflight(
            failedDeploymentPreflightPreview(elapsedSince(preflightStartedAtMs))
          );
          setBrowserSupportPolicy(
            summarizeBrowserSupportPolicy(
              evaluateSyncularBrowserSupportPolicy(
                getSyncularBrowserSupportPolicyContextHint().context,
                null
              )
            )
          );
        }
      }

      reportStarterOpenPhase('diagnostics-support-bundle');
      await yieldStarterFrame();
      const supportBundleStartedAtMs = performance.now();
      if (!preflight) {
        if (!disposed) {
          setSupportBundle(failedSupportBundlePreview());
          updateStarterTimeline((current) => ({
            ...current,
            supportBundleExportMs: elapsedSince(supportBundleStartedAtMs),
          }));
        }
        return;
      }

      try {
        const bundle = await client.exportSupportBundle({
          deploymentPreflight: preflight,
          includeLocalSupportBundle: false,
        });
        if (!disposed) {
          setSupportBundle(summarizeSupportBundle(bundle));
          updateStarterTimeline((current) => ({
            ...current,
            supportBundleExportMs: elapsedSince(supportBundleStartedAtMs),
          }));
        }
      } catch {
        if (!disposed) {
          setSupportBundle(failedSupportBundlePreview());
          updateStarterTimeline((current) => ({
            ...current,
            supportBundleExportMs: elapsedSince(supportBundleStartedAtMs),
          }));
        }
      }

      reportStarterOpenPhase('diagnostics-ready');
    };

    const refresh = () => {
      if (disposed) return;
      if (refreshRunning) {
        refreshQueued = true;
        return;
      }
      refreshRunning = true;
      void (async () => {
        try {
          do {
            refreshQueued = false;
            await runRefresh();
          } while (!disposed && refreshQueued);
        } finally {
          refreshRunning = false;
          if (!disposed && refreshQueued) refresh();
        }
      })();
    };

    refresh();
    const unsubscribeBootstrap = client.on('bootstrapChanged', refresh);
    const unsubscribeRows = client.on('rowsChanged', refresh);
    return () => {
      disposed = true;
      unsubscribeBootstrap();
      unsubscribeRows();
    };
  }, [client, reportStarterOpenPhase, updateStarterTimeline]);

  useEffect(() => {
    const runProof = async () => {
      if (localRecoveryProofRunning.current) return;
      localRecoveryProofRunning.current = true;
      setLocalRecoveryProof((current) => ({
        ...current,
        actionKind: 'export-support-bundle',
        error: null,
        errorCode: null,
        lockName: starterLocalRecoveryLockName,
        lockRequired: false,
        lockState: 'waiting',
        lockTimeoutMs: starterLocalRecoveryLockTimeoutMs,
        status: 'running',
      }));
      try {
        const plan = await client.localRecoveryPlan();
        const action = plan.actions.find(
          (candidate) => candidate.kind === 'export-support-bundle'
        );
        if (!action) {
          throw new Error(
            'Starter local recovery plan had no support bundle action'
          );
        }
        const result = await client.runLocalRecoveryAction(action, {
          lock: {
            name: starterLocalRecoveryLockName,
            timeoutMs: starterLocalRecoveryLockTimeoutMs,
          },
        });
        setLocalRecoveryProof((current) => ({
          actionKind: result.action,
          count: current.count + 1,
          error: null,
          errorCode: null,
          lockName:
            result.coordination.lockName ?? starterLocalRecoveryLockName,
          lockRequired: result.coordination.lockRequired,
          lockState: result.coordination.lockState,
          lockTimeoutMs:
            result.coordination.lockTimeoutMs ??
            starterLocalRecoveryLockTimeoutMs,
          status: 'complete',
        }));
      } catch (error) {
        setLocalRecoveryProof((current) => ({
          ...current,
          count: current.count + 1,
          error: errorMessage(error),
          errorCode: syncularErrorCode(error),
          lockName: starterLocalRecoveryLockName,
          lockRequired: false,
          lockState:
            syncularErrorCode(error) ===
            'syncular.local_recovery_web_locks_timeout'
              ? 'timed-out'
              : current.lockState,
          lockTimeoutMs: starterLocalRecoveryLockTimeoutMs,
          status: 'failed',
        }));
      } finally {
        localRecoveryProofRunning.current = false;
      }
    };
    const onProof = () => {
      void runProof();
    };
    window.addEventListener(
      'syncular-starter-run-local-recovery-proof',
      onProof
    );
    return () => {
      window.removeEventListener(
        'syncular-starter-run-local-recovery-proof',
        onProof
      );
    };
  }, [client]);

  useEffect(() => {
    const runProof = async (event: Event) => {
      if (storageRecoveryProofRunning.current) return;
      storageRecoveryProofRunning.current = true;
      setStorageRecoveryProof((current) => ({
        ...current,
        actionKinds: [],
        availableBytes: null,
        clearBlobCacheCompleted: false,
        compactCompleted: false,
        error: null,
        errorCode: null,
        issueCodes: [],
        issueCount: 0,
        planActionCount: 0,
        quotaBytes: null,
        quotaPressure: 'unknown',
        requestPersistenceGranted: null,
        requestPersistenceOffered: false,
        requestPersistenceSupported: null,
        source: null,
        status: 'running',
        usageBytes: null,
        usageRatio: null,
      }));
      try {
        const { preflight: deploymentPreflight, source } =
          await starterStorageRecoveryDeploymentPreflight(event);
        const plan = await client.localRecoveryPlan({ deploymentPreflight });
        const actionKinds = plan.actions.map((action) => action.kind);
        const issueCodes = deploymentPreflight.issues.map(
          (issue) => issue.code
        );
        const requestPersistence = plan.actions.find(
          (candidate) => candidate.kind === 'request-persistent-storage'
        );
        const compactStorage = plan.actions.find(
          (candidate) => candidate.kind === 'compact-storage'
        );
        const clearBlobCache = plan.actions.find(
          (candidate) => candidate.kind === 'clear-blob-cache'
        );
        if (!requestPersistence || !compactStorage) {
          throw new Error(
            `Starter storage recovery plan missed expected actions: ${actionKinds.join(', ')}`
          );
        }
        const persistenceResult = await client.runLocalRecoveryAction(
          requestPersistence,
          {
            navigator: {
              storage: {
                async persist() {
                  return true;
                },
              },
            },
          }
        );
        await client.runLocalRecoveryAction(compactStorage);
        if (clearBlobCache) {
          await client.runLocalRecoveryAction(clearBlobCache, {
            confirmationText: 'clear local blob cache',
          });
        }
        setStorageRecoveryProof((current) => ({
          actionKinds,
          availableBytes: deploymentPreflight.storage.availableBytes ?? null,
          clearBlobCacheCompleted: Boolean(clearBlobCache),
          compactCompleted: true,
          count: current.count + 1,
          error: null,
          errorCode: null,
          issueCodes,
          issueCount: deploymentPreflight.issues.length,
          planActionCount: plan.actions.length,
          quotaBytes: deploymentPreflight.storage.quotaBytes ?? null,
          quotaPressure: deploymentPreflight.storage.quotaPressure,
          requestPersistenceGranted:
            persistenceResult.action === 'request-persistent-storage'
              ? persistenceResult.granted
              : null,
          requestPersistenceOffered: true,
          requestPersistenceSupported:
            persistenceResult.action === 'request-persistent-storage'
              ? persistenceResult.supported
              : null,
          source,
          status: 'complete',
          usageBytes: deploymentPreflight.storage.usageBytes ?? null,
          usageRatio: deploymentPreflight.storage.usageRatio ?? null,
        }));
      } catch (error) {
        setStorageRecoveryProof((current) => ({
          ...current,
          count: current.count + 1,
          error: errorMessage(error),
          errorCode: syncularErrorCode(error),
          status: 'failed',
        }));
      } finally {
        storageRecoveryProofRunning.current = false;
      }
    };
    const onProof = (event: Event) => {
      void runProof(event);
    };
    window.addEventListener(
      'syncular-starter-run-storage-recovery-proof',
      onProof
    );
    return () => {
      window.removeEventListener(
        'syncular-starter-run-storage-recovery-proof',
        onProof
      );
    };
  }, [client]);

  useEffect(() => {
    const runProof = async (event: Event) => {
      if (quotaPressureProofRunning.current) return;
      quotaPressureProofRunning.current = true;
      setQuotaPressureProof((current) => ({
        ...current,
        error: null,
        errorCode: null,
        issueCodes: [],
        issueCount: 0,
        status: 'running',
      }));
      try {
        const detail = quotaPressureProofDetailFromEvent(event);
        const navigatorOverride = quotaPressureProofNavigatorOverride(detail);
        const preflight = await getSyncularBrowserDeploymentPreflight(
          navigatorOverride
            ? {
                ...starterDeploymentPreflightOptions,
                navigator: navigatorOverride,
              }
            : starterDeploymentPreflightOptions
        );
        const issueCodes = preflight.issues.map((issue) => issue.code);
        if (
          preflight.storage.quotaPressure !== 'high' ||
          !issueCodes.includes('browser.storage_pressure_high')
        ) {
          throw Object.assign(
            new Error(
              `Browser quota pressure was not observed: ${preflight.storage.quotaPressure}`
            ),
            { code: 'browser.storage_pressure_not_observed' }
          );
        }
        setQuotaPressureProof((current) => ({
          actionCount: preflight.support.recommendedActions.length,
          availableBytes: preflight.storage.availableBytes ?? null,
          count: current.count + 1,
          error: null,
          errorCode: null,
          issueCodes,
          issueCount: preflight.issues.length,
          persistence: preflight.support.persistence,
          quotaBytes: preflight.storage.quotaBytes ?? null,
          quotaPressure: preflight.storage.quotaPressure,
          status: 'complete',
          supportTier: preflight.support.tier,
          usageBytes: preflight.storage.usageBytes ?? null,
          usageRatio: preflight.storage.usageRatio ?? null,
        }));
      } catch (error) {
        setQuotaPressureProof((current) => ({
          ...current,
          count: current.count + 1,
          error: errorMessage(error),
          errorCode: syncularErrorCode(error),
          status: 'failed',
        }));
      } finally {
        quotaPressureProofRunning.current = false;
      }
    };
    const onProof = (event: Event) => {
      void runProof(event);
    };
    window.addEventListener(
      'syncular-starter-run-quota-pressure-proof',
      onProof
    );
    return () => {
      window.removeEventListener(
        'syncular-starter-run-quota-pressure-proof',
        onProof
      );
    };
  }, []);

  useEffect(() => {
    const runProof = async (requestedCount: number, titlePrefix: string) => {
      if (writePressureProofRunning.current) return;
      writePressureProofRunning.current = true;
      const count = Math.min(Math.max(Math.trunc(requestedCount), 1), 8);
      const prefix = titlePrefix.trim() || `write pressure ${Date.now()}`;
      const startedAtMs = performance.now();
      const entries = Array.from({ length: count }, (_, index) => ({
        id: crypto.randomUUID(),
        title: `${prefix} ${index + 1}`,
      }));
      setWritePressureProof((current) => ({
        ...current,
        durationMs: null,
        error: null,
        errorCode: null,
        requestedCount: count,
        status: 'running',
        titlePrefix: prefix,
        visibleCount: 0,
      }));
      try {
        await Promise.all(
          entries.map((entry, index) =>
            mutations.tasks.insert({
              id: entry.id,
              title: entry.title,
              completed: 0,
              user_id: appActorId,
              created_at: Date.now() + index,
            })
          )
        );
        const visibilityResults = await Promise.allSettled(
          entries.map((entry) =>
            client.awaitTaskVisibility(
              ({ selectFrom }) =>
                selectFrom('tasks')
                  .select('id')
                  .where('id', '=', entry.id)
                  .limit(1),
              { timeoutMs: 5_000 }
            )
          )
        );
        const visibleCount = visibilityResults.filter(
          (result) => result.status === 'fulfilled'
        ).length;
        if (visibleCount !== entries.length) {
          const firstFailure = visibilityResults.find(
            (result) => result.status === 'rejected'
          );
          throw firstFailure?.reason ?? new Error('Local visibility failed');
        }
        setWritePressureProof((current) => ({
          ...current,
          durationMs: elapsedSince(startedAtMs),
          error: null,
          errorCode: null,
          requestedCount: count,
          runCount: current.runCount + 1,
          status: 'complete',
          titlePrefix: prefix,
          visibleCount,
        }));
      } catch (error) {
        setWritePressureProof((current) => ({
          ...current,
          durationMs: elapsedSince(startedAtMs),
          error: errorMessage(error),
          errorCode: syncularErrorCode(error),
          requestedCount: count,
          runCount: current.runCount + 1,
          status: 'failed',
          titlePrefix: prefix,
        }));
      } finally {
        writePressureProofRunning.current = false;
      }
    };
    const onProof = (event: Event) => {
      const detail =
        event instanceof CustomEvent &&
        typeof event.detail === 'object' &&
        event.detail !== null
          ? (event.detail as {
              count?: unknown;
              titlePrefix?: unknown;
            })
          : {};
      const count =
        typeof detail.count === 'number' && Number.isFinite(detail.count)
          ? detail.count
          : 4;
      const titlePrefix =
        typeof detail.titlePrefix === 'string'
          ? detail.titlePrefix.slice(0, 80)
          : `write pressure ${Date.now()}`;
      void runProof(count, titlePrefix);
    };
    window.addEventListener(
      'syncular-starter-run-write-pressure-proof',
      onProof
    );
    return () => {
      window.removeEventListener(
        'syncular-starter-run-write-pressure-proof',
        onProof
      );
    };
  }, [client, mutations]);

  useEffect(() => {
    const runProof = async (event: Event) => {
      if (quotaExhaustionWriteProofRunning.current) return;
      quotaExhaustionWriteProofRunning.current = true;
      const detail = quotaExhaustionWriteProofDetailFromEvent(event);
      const attemptedBytes = detail?.attemptedBytes ?? 2 * 1024 * 1024;
      const startedAtMs = performance.now();
      setQuotaExhaustionWriteProof((current) => ({
        ...current,
        attemptedBytes,
        availableBytes: detail?.availableBytes ?? null,
        durationMs: null,
        error: null,
        errorCode: null,
        quotaBytes: detail?.quotaBytes ?? null,
        status: 'running',
        usageBytes: detail?.usageBytes ?? null,
        usageRatio: detail?.usageRatio ?? null,
        writeFailed: false,
      }));

      const idPrefix = `quota-exhaustion-${crypto.randomUUID()}-`;
      const rowId =
        idPrefix +
        'x'.repeat(Math.max(0, Math.trunc(attemptedBytes) - idPrefix.length));
      try {
        await mutations.tasks.insert({
          id: rowId,
          title: 'quota exhaustion write proof',
          completed: 0,
          user_id: appActorId,
          created_at: Date.now(),
        });
        try {
          await mutations.tasks.delete(rowId);
        } catch {
          // Best effort only: if a quota-exhausted write unexpectedly succeeds,
          // the proof should still report the unexpected success.
        }
        throw Object.assign(
          new Error('Quota-exhaustion generated write unexpectedly succeeded'),
          { code: 'browser.quota_exhaustion_write_succeeded' }
        );
      } catch (error) {
        const errorCode = syncularErrorCode(error);
        if (errorCode === 'browser.quota_exhaustion_write_succeeded') {
          setQuotaExhaustionWriteProof((current) => ({
            ...current,
            count: current.count + 1,
            durationMs: elapsedSince(startedAtMs),
            error: errorMessage(error),
            errorCode,
            status: 'failed',
            writeFailed: false,
          }));
          return;
        }

        setQuotaExhaustionWriteProof((current) => ({
          ...current,
          count: current.count + 1,
          durationMs: elapsedSince(startedAtMs),
          error: errorMessage(error),
          errorCode,
          status: 'complete',
          writeFailed: true,
        }));
      } finally {
        quotaExhaustionWriteProofRunning.current = false;
      }
    };
    const onProof = (event: Event) => {
      void runProof(event);
    };
    window.addEventListener(
      'syncular-starter-run-quota-exhaustion-write-proof',
      onProof
    );
    return () => {
      window.removeEventListener(
        'syncular-starter-run-quota-exhaustion-write-proof',
        onProof
      );
    };
  }, [mutations]);

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
      <LocalRecoveryProofMarker localRecoveryProof={localRecoveryProof} />
      <StorageRecoveryProofMarker storageRecoveryProof={storageRecoveryProof} />
      <QuotaPressureProofMarker quotaPressureProof={quotaPressureProof} />
      <WritePressureProofMarker writePressureProof={writePressureProof} />
      <QuotaExhaustionWriteProofMarker
        quotaExhaustionWriteProof={quotaExhaustionWriteProof}
      />
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

function LocalRecoveryProofMarker({
  localRecoveryProof,
}: {
  localRecoveryProof: LocalRecoveryProofPreview;
}) {
  return (
    <span
      data-syncular-local-recovery-proof-action-kind={
        localRecoveryProof.actionKind ?? ''
      }
      data-syncular-local-recovery-proof-count={localRecoveryProof.count}
      data-syncular-local-recovery-proof-error={localRecoveryProof.error ?? ''}
      data-syncular-local-recovery-proof-error-code={
        localRecoveryProof.errorCode ?? ''
      }
      data-syncular-local-recovery-proof-lock-name={
        localRecoveryProof.lockName ?? ''
      }
      data-syncular-local-recovery-proof-lock-required={String(
        localRecoveryProof.lockRequired
      )}
      data-syncular-local-recovery-proof-lock-state={
        localRecoveryProof.lockState
      }
      data-syncular-local-recovery-proof-lock-timeout-ms={
        localRecoveryProof.lockTimeoutMs ?? ''
      }
      data-syncular-local-recovery-proof-status={localRecoveryProof.status}
      hidden
    />
  );
}

function StorageRecoveryProofMarker({
  storageRecoveryProof,
}: {
  storageRecoveryProof: StorageRecoveryProofPreview;
}) {
  return (
    <span
      data-syncular-storage-recovery-proof-action-kinds={storageRecoveryProof.actionKinds.join(
        ','
      )}
      data-syncular-storage-recovery-proof-available-bytes={
        storageRecoveryProof.availableBytes ?? ''
      }
      data-syncular-storage-recovery-proof-clear-blob-cache-completed={String(
        storageRecoveryProof.clearBlobCacheCompleted
      )}
      data-syncular-storage-recovery-proof-compact-completed={String(
        storageRecoveryProof.compactCompleted
      )}
      data-syncular-storage-recovery-proof-count={storageRecoveryProof.count}
      data-syncular-storage-recovery-proof-error={
        storageRecoveryProof.error ?? ''
      }
      data-syncular-storage-recovery-proof-error-code={
        storageRecoveryProof.errorCode ?? ''
      }
      data-syncular-storage-recovery-proof-issue-codes={storageRecoveryProof.issueCodes.join(
        ','
      )}
      data-syncular-storage-recovery-proof-issue-count={
        storageRecoveryProof.issueCount
      }
      data-syncular-storage-recovery-proof-plan-action-count={
        storageRecoveryProof.planActionCount
      }
      data-syncular-storage-recovery-proof-quota-bytes={
        storageRecoveryProof.quotaBytes ?? ''
      }
      data-syncular-storage-recovery-proof-quota-pressure={
        storageRecoveryProof.quotaPressure
      }
      data-syncular-storage-recovery-proof-request-persistence-granted={
        storageRecoveryProof.requestPersistenceGranted === null
          ? ''
          : String(storageRecoveryProof.requestPersistenceGranted)
      }
      data-syncular-storage-recovery-proof-request-persistence-offered={String(
        storageRecoveryProof.requestPersistenceOffered
      )}
      data-syncular-storage-recovery-proof-request-persistence-supported={
        storageRecoveryProof.requestPersistenceSupported === null
          ? ''
          : String(storageRecoveryProof.requestPersistenceSupported)
      }
      data-syncular-storage-recovery-proof-source={
        storageRecoveryProof.source ?? ''
      }
      data-syncular-storage-recovery-proof-status={storageRecoveryProof.status}
      data-syncular-storage-recovery-proof-usage-bytes={
        storageRecoveryProof.usageBytes ?? ''
      }
      data-syncular-storage-recovery-proof-usage-ratio={
        storageRecoveryProof.usageRatio ?? ''
      }
      hidden
    />
  );
}

function QuotaPressureProofMarker({
  quotaPressureProof,
}: {
  quotaPressureProof: QuotaPressureProofPreview;
}) {
  return (
    <span
      data-syncular-quota-pressure-proof-action-count={
        quotaPressureProof.actionCount
      }
      data-syncular-quota-pressure-proof-available-bytes={
        quotaPressureProof.availableBytes ?? ''
      }
      data-syncular-quota-pressure-proof-count={quotaPressureProof.count}
      data-syncular-quota-pressure-proof-error={quotaPressureProof.error ?? ''}
      data-syncular-quota-pressure-proof-error-code={
        quotaPressureProof.errorCode ?? ''
      }
      data-syncular-quota-pressure-proof-issue-codes={quotaPressureProof.issueCodes.join(
        ','
      )}
      data-syncular-quota-pressure-proof-issue-count={
        quotaPressureProof.issueCount
      }
      data-syncular-quota-pressure-proof-persistence={
        quotaPressureProof.persistence
      }
      data-syncular-quota-pressure-proof-quota-bytes={
        quotaPressureProof.quotaBytes ?? ''
      }
      data-syncular-quota-pressure-proof-quota-pressure={
        quotaPressureProof.quotaPressure
      }
      data-syncular-quota-pressure-proof-status={quotaPressureProof.status}
      data-syncular-quota-pressure-proof-support-tier={
        quotaPressureProof.supportTier
      }
      data-syncular-quota-pressure-proof-usage-bytes={
        quotaPressureProof.usageBytes ?? ''
      }
      data-syncular-quota-pressure-proof-usage-ratio={
        quotaPressureProof.usageRatio ?? ''
      }
      hidden
    />
  );
}

function WritePressureProofMarker({
  writePressureProof,
}: {
  writePressureProof: WritePressureProofPreview;
}) {
  return (
    <span
      data-syncular-write-pressure-proof-duration-ms={
        writePressureProof.durationMs ?? ''
      }
      data-syncular-write-pressure-proof-error={writePressureProof.error ?? ''}
      data-syncular-write-pressure-proof-error-code={
        writePressureProof.errorCode ?? ''
      }
      data-syncular-write-pressure-proof-requested-count={
        writePressureProof.requestedCount
      }
      data-syncular-write-pressure-proof-run-count={writePressureProof.runCount}
      data-syncular-write-pressure-proof-status={writePressureProof.status}
      data-syncular-write-pressure-proof-title-prefix={
        writePressureProof.titlePrefix ?? ''
      }
      data-syncular-write-pressure-proof-visible-count={
        writePressureProof.visibleCount
      }
      hidden
    />
  );
}

function QuotaExhaustionWriteProofMarker({
  quotaExhaustionWriteProof,
}: {
  quotaExhaustionWriteProof: QuotaExhaustionWriteProofPreview;
}) {
  return (
    <span
      data-syncular-quota-exhaustion-write-proof-attempted-bytes={
        quotaExhaustionWriteProof.attemptedBytes
      }
      data-syncular-quota-exhaustion-write-proof-available-bytes={
        quotaExhaustionWriteProof.availableBytes ?? ''
      }
      data-syncular-quota-exhaustion-write-proof-count={
        quotaExhaustionWriteProof.count
      }
      data-syncular-quota-exhaustion-write-proof-duration-ms={
        quotaExhaustionWriteProof.durationMs ?? ''
      }
      data-syncular-quota-exhaustion-write-proof-error={
        quotaExhaustionWriteProof.error ?? ''
      }
      data-syncular-quota-exhaustion-write-proof-error-code={
        quotaExhaustionWriteProof.errorCode ?? ''
      }
      data-syncular-quota-exhaustion-write-proof-quota-bytes={
        quotaExhaustionWriteProof.quotaBytes ?? ''
      }
      data-syncular-quota-exhaustion-write-proof-status={
        quotaExhaustionWriteProof.status
      }
      data-syncular-quota-exhaustion-write-proof-usage-bytes={
        quotaExhaustionWriteProof.usageBytes ?? ''
      }
      data-syncular-quota-exhaustion-write-proof-usage-ratio={
        quotaExhaustionWriteProof.usageRatio ?? ''
      }
      data-syncular-quota-exhaustion-write-proof-write-failed={
        quotaExhaustionWriteProof.writeFailed
      }
      hidden
    />
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
      data-syncular-deployment-preflight-service-worker={
        deploymentPreflight.serviceWorker === null
          ? ''
          : String(deploymentPreflight.serviceWorker)
      }
      data-syncular-deployment-preflight-service-worker-controlled={
        deploymentPreflight.serviceWorkerControlled === null
          ? ''
          : String(deploymentPreflight.serviceWorkerControlled)
      }
      data-syncular-deployment-preflight-service-worker-controller-script-path={
        deploymentPreflight.serviceWorkerControllerScriptPath ?? ''
      }
      data-syncular-deployment-preflight-service-worker-controller-state={
        deploymentPreflight.serviceWorkerControllerState ?? ''
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
    serviceWorker: preflight.browser.serviceWorker ?? null,
    serviceWorkerControlled: preflight.browser.serviceWorkerControlled ?? null,
    serviceWorkerControllerScriptPath:
      preflight.browser.serviceWorkerControllerScriptPath ?? null,
    serviceWorkerControllerState:
      preflight.browser.serviceWorkerControllerState ?? null,
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
    serviceWorker: null,
    serviceWorkerControlled: null,
    serviceWorkerControllerScriptPath: null,
    serviceWorkerControllerState: null,
    status: 'failed',
    supportTier: 'unknown',
    usageRatio: null,
    usageBytes: null,
  };
}

function quotaPressureProofDetailFromEvent(
  event: Event
): QuotaPressureProofDetail | null {
  if (!(event instanceof CustomEvent)) return null;
  const detail: unknown = event.detail;
  if (detail == null || typeof detail !== 'object') return null;
  const record = detail as Record<string, unknown>;
  const quotaBytes = nonNegativeFiniteNumber(record.quotaBytes);
  const usageBytes = nonNegativeFiniteNumber(record.usageBytes);
  if (quotaBytes === null || usageBytes === null) return null;
  return { quotaBytes, usageBytes };
}

function nonNegativeFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function positiveFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function quotaExhaustionWriteProofDetailFromEvent(event: Event): {
  attemptedBytes: number;
  availableBytes: number | null;
  quotaBytes: number | null;
  usageBytes: number | null;
  usageRatio: number | null;
} | null {
  if (!(event instanceof CustomEvent)) return null;
  const detail: unknown = event.detail;
  if (detail == null || typeof detail !== 'object') return null;
  const record = detail as Record<string, unknown>;
  const attemptedBytes = positiveFiniteNumber(record.attemptedBytes);
  if (attemptedBytes === null) return null;
  const quotaBytes = nonNegativeFiniteNumber(record.quotaBytes);
  const usageBytes = nonNegativeFiniteNumber(record.usageBytes);
  const usageRatio = nonNegativeFiniteNumber(record.usageRatio);
  return {
    attemptedBytes: Math.min(Math.trunc(attemptedBytes), 8 * 1024 * 1024),
    availableBytes: nonNegativeFiniteNumber(record.availableBytes),
    quotaBytes,
    usageBytes,
    usageRatio: usageRatio !== null && usageRatio <= 1 ? usageRatio : null,
  };
}

function quotaPressureProofNavigatorOverride(
  detail: QuotaPressureProofDetail | null
): SyncularBrowserDeploymentPreflightNavigator | null {
  if (!detail) return null;
  const liveNavigator =
    typeof navigator === 'undefined'
      ? undefined
      : (navigator as SyncularBrowserDeploymentPreflightNavigator);
  const liveStorage = liveNavigator?.storage;
  const next: SyncularBrowserDeploymentPreflightNavigator = {};
  if (liveNavigator?.locks) next.locks = liveNavigator.locks;
  if (liveNavigator?.serviceWorker) {
    next.serviceWorker = liveNavigator.serviceWorker;
  }

  const storage: NonNullable<
    SyncularBrowserDeploymentPreflightNavigator['storage']
  > = {
    estimate: async () => ({
      quota: detail.quotaBytes,
      usage: detail.usageBytes,
    }),
  };
  const getDirectory = liveStorage?.getDirectory;
  if (typeof getDirectory === 'function') {
    storage.getDirectory = () => getDirectory.call(liveStorage);
  }
  const persist = liveStorage?.persist;
  if (typeof persist === 'function') {
    storage.persist = () => persist.call(liveStorage);
  }
  const persisted = liveStorage?.persisted;
  if (typeof persisted === 'function') {
    storage.persisted = () => persisted.call(liveStorage);
  }
  next.storage = storage;
  return next;
}

type StarterStorageRecoveryDeploymentPreflightProof = {
  preflight: SyncularBrowserDeploymentPreflight;
  source: NonNullable<StorageRecoveryProofPreview['source']>;
};

async function starterStorageRecoveryDeploymentPreflight(
  event: Event
): Promise<StarterStorageRecoveryDeploymentPreflightProof> {
  const detail = quotaPressureProofDetailFromEvent(event);
  const navigatorOverride = quotaPressureProofNavigatorOverride(detail);
  const live = await getSyncularBrowserDeploymentPreflight(
    navigatorOverride
      ? {
          ...starterDeploymentPreflightOptions,
          navigator: navigatorOverride,
        }
      : starterDeploymentPreflightOptions
  );
  const source: NonNullable<StorageRecoveryProofPreview['source']> = detail
    ? 'browser-observed'
    : 'synthetic';
  if (
    detail &&
    (live.storage.quotaPressure !== 'high' ||
      !live.issues.some(
        (issue) => issue.code === 'browser.storage_pressure_high'
      ))
  ) {
    throw Object.assign(
      new Error(
        `Browser-observed storage recovery proof did not see high quota pressure: ${live.storage.quotaPressure}`
      ),
      { code: 'browser.storage_pressure_not_observed' }
    );
  }
  const storageIssues: SyncularBrowserDeploymentPreflight['issues'] = [
    {
      code: 'browser.storage_persistence_not_granted',
      details: { persistRequestSupported: true },
      message:
        source === 'browser-observed'
          ? 'Browser-observed starter proof: persistent browser storage is requestable but not granted.'
          : 'Synthetic starter proof: persistent browser storage is requestable but not granted.',
      recommendedAction: 'requestPersistentStorage',
      severity: 'warning',
      target: 'storage',
    },
    ...(source === 'synthetic'
      ? ([
          {
            code: 'browser.storage_pressure_high',
            details: {
              quotaBytes: live.storage.quotaBytes ?? 100_000,
              usageBytes: live.storage.usageBytes ?? 92_000,
              usageRatio: 0.92,
            },
            message:
              'Synthetic starter proof: browser storage usage is close to quota.',
            recommendedAction: 'freeStorageQuota',
            severity: 'warning',
            target: 'storage',
          },
          {
            code: 'browser.storage_quota_low',
            details: {
              availableBytes: live.storage.availableBytes ?? 8_000,
              minimumAvailableBytes:
                live.storage.minimumAvailableBytes ??
                starterDeploymentPreflightOptions.minimumAvailableBytes,
              minimumQuotaBytes:
                live.storage.minimumQuotaBytes ??
                starterDeploymentPreflightOptions.minimumQuotaBytes,
              quotaBytes: live.storage.quotaBytes ?? 100_000,
            },
            message:
              'Synthetic starter proof: available browser storage is below the Syncular budget.',
            recommendedAction: 'freeStorageQuota',
            severity: 'warning',
            target: 'storage',
          },
        ] satisfies SyncularBrowserDeploymentPreflight['issues'])
      : []),
  ];
  const issueCodes = [
    ...new Set([
      ...live.support.issueCodes,
      ...live.issues.map((issue) => issue.code),
      ...storageIssues.map((issue) => issue.code),
    ]),
  ];
  const recommendedActions = [
    ...new Set<
      SyncularBrowserDeploymentPreflight['support']['recommendedActions'][number]
    >([
      ...live.support.recommendedActions,
      'requestPersistentStorage' as const,
      'freeStorageQuota' as const,
    ]),
  ];
  const storage =
    source === 'browser-observed'
      ? live.storage
      : {
          ...live.storage,
          availableBytes: live.storage.availableBytes ?? 8_000,
          quotaBytes: live.storage.quotaBytes ?? 100_000,
          quotaPressure: 'high' as const,
          usageBytes: live.storage.usageBytes ?? 92_000,
          usageRatio: Math.max(live.storage.usageRatio ?? 0, 0.92),
        };
  return {
    source,
    preflight: {
      ...live,
      issues: [...live.issues, ...storageIssues],
      ready: false,
      requiresAction: true,
      status: live.status === 'not-ready' ? 'not-ready' : 'warning',
      storage: {
        ...storage,
        persistenceSupported: true,
        persistRequestSupported: true,
        persisted: false,
      },
      support: {
        ...live.support,
        issueCodes,
        persistence: 'evictable',
        persistentOffline: false,
        productionReady: false,
        recommendedActions,
        summary:
          source === 'browser-observed'
            ? 'Browser-observed starter proof storage warning for local recovery action mapping.'
            : 'Synthetic starter proof storage warning for local recovery action mapping.',
        tier: live.support.tier === 'unsupported' ? 'unsupported' : 'unknown',
      },
    },
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
        ? 'memory storage'
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
