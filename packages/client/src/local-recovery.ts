import type {
  SyncularBrowserDeploymentPreflight,
  SyncularBrowserDeploymentPreflightIssueCode,
  SyncularBrowserDeploymentPreflightMultiTabMode,
} from './browser-deployment-preflight';
import type { SyncularClientStatus } from './client';
import type {
  SyncularBlobUploadQueueProcessOptions,
  SyncularDiagnosticSnapshot,
  SyncularLocalHealthFinding,
  SyncularLocalHealthRepairAction,
  SyncularLocalHealthRepairReport,
  SyncularLocalHealthReport,
  SyncularLocalSupportBundle,
  SyncularLocalSyncResetReport,
  SyncularStorageCompactionOptions,
  SyncularStorageCompactionReport,
  SyncularSyncRequestOptions,
  SyncularSyncResult,
} from './types';

export type SyncularLocalRecoveryStatus =
  | 'healthy'
  | 'maintenance-recommended'
  | 'action-required';

export type SyncularLocalRecoveryActionKind =
  | 'export-support-bundle'
  | 'resume-from-background'
  | 'request-persistent-storage'
  | 'retry-blob-uploads'
  | 'compact-storage'
  | 'clear-blob-cache'
  | 'force-rebootstrap'
  | 'clear-orphaned-state'
  | 'clear-orphaned-synced-rows'
  | 'reset-local-sync-state'
  | 'prepare-sign-out';

export type SyncularLocalRecoveryActionSeverity = 'info' | 'warning' | 'danger';

export type SyncularLocalRecoveryActionSource =
  | 'support'
  | 'lifecycle'
  | 'bootstrap'
  | 'scope'
  | 'outbox'
  | 'blob'
  | 'health'
  | 'storage';

export type SyncularLocalRecoveryActionBlockerCode =
  | 'browser.multi_tab_coordination_required'
  | 'local.unsynced_outbox_work_present';

export type SyncularLocalRecoveryActionBlockerMultiTabMode =
  | SyncularBrowserDeploymentPreflightMultiTabMode
  | 'unknown';

export type SyncularLocalRecoveryActionRecommendedAction =
  | 'coordinateBrowserTabs'
  | 'drainOutbox';

export type SyncularLocalRecoveryActionOutboxSafetyStatus =
  | 'empty'
  | 'has-unsynced-work'
  | 'unknown';

export interface SyncularLocalRecoveryActionOutboxSafety {
  status: SyncularLocalRecoveryActionOutboxSafetyStatus;
  pending: number | null;
  sending: number | null;
  failed: number | null;
  total: number | null;
}

export interface SyncularLocalRecoveryActionSafety {
  dataLossConsequences: string[];
  outbox: SyncularLocalRecoveryActionOutboxSafety;
}

export interface SyncularLocalRecoveryActionBlocker {
  code: SyncularLocalRecoveryActionBlockerCode;
  message: string;
  recommendedAction?: SyncularLocalRecoveryActionRecommendedAction;
  details?: Record<string, unknown>;
}

export interface SyncularLocalRecoveryAction {
  id: string;
  kind: SyncularLocalRecoveryActionKind;
  severity: SyncularLocalRecoveryActionSeverity;
  source: SyncularLocalRecoveryActionSource;
  title: string;
  description: string;
  reasonCodes: string[];
  destructive: boolean;
  requiresConfirmation: boolean;
  confirmationText?: string;
  safety?: SyncularLocalRecoveryActionSafety;
  subscriptionIds?: string[];
  tables?: string[];
  blockers?: SyncularLocalRecoveryActionBlocker[];
  clearSyncedRows?: boolean;
  clearBlobCache?: boolean;
  compactStorageOptions?: SyncularStorageCompactionOptions;
  blobUploadOptions?: SyncularBlobUploadQueueProcessOptions;
}

export interface SyncularLocalRecoveryPlan {
  generatedAt: number;
  status: SyncularLocalRecoveryStatus;
  requiresAction: boolean;
  health: SyncularLocalHealthReport;
  outbox: SyncularDiagnosticSnapshot['outboxStats'] | null;
  blobUploads: SyncularDiagnosticSnapshot['blobUploadStats'] | null;
  recentErrorCodes: string[];
  actions: SyncularLocalRecoveryAction[];
}

export interface SyncularLocalRecoveryPlanOptions {
  now?: () => number;
  /**
   * Adds routine maintenance actions even when local health is otherwise OK.
   * Keep this off for normal UI recovery prompts.
   */
  includeMaintenanceActions?: boolean;
  /**
   * Adds a guarded local sync-state reset action for sign-out or explicit
   * rebootstrap flows. The action is destructive and still refuses unsafe
   * runtime states such as non-empty outboxes.
   */
  includeResetAction?: boolean;
  resetSubscriptionIds?: readonly string[];
  resetClearSyncedRows?: boolean;
  /**
   * Adds a guarded sign-out cleanup action. The action is only offered when
   * the local outbox is empty; otherwise the plan offers sync recovery first
   * so apps do not silently discard unsynced local work.
   */
  includeSignOutAction?: boolean;
  signOutSubscriptionIds?: readonly string[];
  /**
   * Defaults to `true`; sign-out cleanup clears cached blob bytes after local
   * sync state and synced rows are reset.
   */
  signOutClearBlobCache?: boolean;
  compactStorageOptions?: SyncularStorageCompactionOptions;
  /**
   * Pass `preflight.lifecycle.multiTabMode` when the app requires destructive
   * local recovery actions to run only after browser tabs are coordinated.
   */
  multiTabMode?: SyncularBrowserDeploymentPreflightMultiTabMode;
  requireMultiTabCoordinationForDestructiveActions?: boolean;
  /**
   * Pass the current browser deployment preflight result so quota pressure,
   * evictable storage, and persistence-grant gaps become app-facing recovery
   * actions instead of diagnostics-only warnings.
   */
  deploymentPreflight?: SyncularBrowserDeploymentPreflight;
}

export type SyncularLocalRecoveryActionLockState =
  | 'not-requested'
  | 'waiting'
  | 'acquired'
  | 'timed-out'
  | 'unavailable';

export interface SyncularLocalRecoveryActionNavigator {
  locks?: {
    request?: <T>(
      name: string,
      options: { mode: 'exclusive'; signal?: AbortSignal },
      callback: () => T | Promise<T>
    ) => Promise<T>;
  };
  storage?: {
    persist?: () => Promise<boolean>;
  };
}

export interface SyncularLocalRecoveryActionLockOptions {
  /**
   * Web Locks name used to serialize local recovery work across browser tabs.
   * Use an app-specific name when several independent Syncular databases can
   * be open in the same origin.
   */
  name?: string;
  /**
   * When true, recovery rejects if the browser does not expose Web Locks
   * instead of falling back to an uncoordinated action.
   */
  required?: boolean;
  /**
   * Optional maximum time to wait for the browser Web Lock. When the timeout
   * expires, recovery rejects with
   * `SyncularLocalRecoveryActionLockTimeoutError` instead of sitting behind
   * another tab indefinitely.
   */
  timeoutMs?: number;
}

export interface SyncularLocalRecoveryActionCoordination {
  lockName?: string;
  lockRequired: boolean;
  lockState: SyncularLocalRecoveryActionLockState;
  lockTimeoutMs?: number;
}

export interface SyncularRunLocalRecoveryActionOptions {
  confirmationText?: string;
  syncOptions?: SyncularSyncRequestOptions;
  navigator?: SyncularLocalRecoveryActionNavigator;
  /**
   * Optional Web Locks coordination for browser recovery actions. Pair this
   * with `requireMultiTabCoordinationForDestructiveActions` in the recovery
   * plan when destructive actions should only run under a browser tab lock.
   */
  lock?: boolean | SyncularLocalRecoveryActionLockOptions;
}

export type SyncularLocalRecoveryActionResultBase =
  | {
      action: 'export-support-bundle';
      bundle: SyncularLocalSupportBundle;
    }
  | {
      action: 'resume-from-background';
      result: SyncularSyncResult;
    }
  | {
      action: 'request-persistent-storage';
      supported: boolean;
      granted: boolean | null;
    }
  | {
      action: 'retry-blob-uploads';
      result: { uploaded: number; failed: number };
    }
  | {
      action: 'compact-storage';
      report: SyncularStorageCompactionReport;
    }
  | {
      action: 'clear-blob-cache';
    }
  | {
      action:
        | 'force-rebootstrap'
        | 'clear-orphaned-state'
        | 'clear-orphaned-synced-rows';
      report: SyncularLocalHealthRepairReport;
    }
  | {
      action: 'reset-local-sync-state';
      report: SyncularLocalSyncResetReport;
    }
  | {
      action: 'prepare-sign-out';
      report: SyncularLocalSyncResetReport;
      clearedBlobCache: boolean;
    };

export type SyncularLocalRecoveryActionResult =
  SyncularLocalRecoveryActionResultBase & {
    coordination: SyncularLocalRecoveryActionCoordination;
  };

export interface SyncularLocalRecoveryClient {
  localHealthCheck(): Promise<SyncularLocalHealthReport>;
  diagnosticSnapshot(): Promise<SyncularDiagnosticSnapshot>;
  getStatus?(): SyncularClientStatus;
  exportLocalSupportBundle(): Promise<SyncularLocalSupportBundle>;
  resumeFromBackground(
    options?: SyncularSyncRequestOptions
  ): Promise<SyncularSyncResult>;
  processBlobUploadQueue(
    options?: SyncularBlobUploadQueueProcessOptions
  ): Promise<{ uploaded: number; failed: number }>;
  compactStorage(
    options?: SyncularStorageCompactionOptions
  ): Promise<SyncularStorageCompactionReport>;
  clearBlobCache(): Promise<void>;
  repairLocalHealth(request: {
    action: SyncularLocalHealthRepairAction;
    subscriptionIds?: readonly string[];
    tables?: readonly string[];
  }): Promise<SyncularLocalHealthRepairReport>;
  resetLocalSyncState(request?: {
    subscriptionIds?: readonly string[];
    clearSyncedRows?: boolean;
  }): Promise<SyncularLocalSyncResetReport>;
}

export class SyncularLocalRecoveryError extends Error {
  readonly code: 'syncular.local_recovery_confirmation_required';
  readonly action: SyncularLocalRecoveryAction;

  constructor(action: SyncularLocalRecoveryAction) {
    super(
      `Syncular local recovery action "${action.id}" requires confirmation text "${action.confirmationText}".`
    );
    this.name = 'SyncularLocalRecoveryError';
    this.code = 'syncular.local_recovery_confirmation_required';
    this.action = action;
  }
}

export class SyncularLocalRecoveryBlockedError extends Error {
  readonly code: 'syncular.local_recovery_action_blocked';
  readonly action: SyncularLocalRecoveryAction;
  readonly blockers: SyncularLocalRecoveryActionBlocker[];

  constructor(
    action: SyncularLocalRecoveryAction,
    blockers: readonly SyncularLocalRecoveryActionBlocker[]
  ) {
    super(
      `Syncular local recovery action "${action.id}" is blocked: ${blockers
        .map((blocker) => blocker.code)
        .join(', ')}.`
    );
    this.name = 'SyncularLocalRecoveryBlockedError';
    this.code = 'syncular.local_recovery_action_blocked';
    this.action = action;
    this.blockers = [...blockers];
  }
}

export class SyncularLocalRecoveryActionLockError extends Error {
  readonly code = 'syncular.local_recovery_web_locks_unavailable';
  readonly action: SyncularLocalRecoveryAction;
  readonly lockName: string;

  constructor(action: SyncularLocalRecoveryAction, lockName: string) {
    super(
      `Browser Web Locks are unavailable; cannot coordinate Syncular local recovery action "${action.id}" for ${lockName}.`
    );
    this.name = 'SyncularLocalRecoveryActionLockError';
    this.action = action;
    this.lockName = lockName;
  }
}

export class SyncularLocalRecoveryActionLockTimeoutError extends Error {
  readonly code = 'syncular.local_recovery_web_locks_timeout';
  readonly action: SyncularLocalRecoveryAction;
  readonly lockName: string;
  readonly timeoutMs: number;

  constructor(
    action: SyncularLocalRecoveryAction,
    lockName: string,
    timeoutMs: number
  ) {
    super(
      `Timed out waiting ${timeoutMs}ms for Syncular local recovery Web Lock ${lockName} while running action "${action.id}".`
    );
    this.name = 'SyncularLocalRecoveryActionLockTimeoutError';
    this.action = action;
    this.lockName = lockName;
    this.timeoutMs = timeoutMs;
  }
}

const DEFAULT_LOCAL_RECOVERY_LOCK_NAME = 'syncular:local-recovery';

type NormalizedLocalRecoveryLockOptions = {
  name: string;
  required: boolean;
  timeoutMs?: number;
};

export async function getSyncularLocalRecoveryPlan(
  client: SyncularLocalRecoveryClient,
  options: SyncularLocalRecoveryPlanOptions = {}
): Promise<SyncularLocalRecoveryPlan> {
  const [health, snapshot] = await Promise.all([
    client.localHealthCheck(),
    client.diagnosticSnapshot(),
  ]);
  const status = client.getStatus?.();
  const actions = [
    supportBundleAction(),
    ...actionsForErroredBootstrap(status, snapshot),
    ...actionsForRevokedScopes(snapshot),
    ...actionsForLifecycle(status, snapshot),
    ...actionsForOutbox(status, snapshot),
    ...actionsForBlobUploads(status, snapshot),
    ...actionsForStoragePreflight(options, snapshot),
    ...actionsForHealth(health),
    ...actionsForRequestedOptions(options, status, snapshot),
  ];
  const uniqueActions = applyRecoveryActionBlockers(
    applyRecoveryActionSafety(dedupeActions(actions), status, snapshot),
    options
  );
  const recoveryStatus = summarizeRecoveryStatus({
    health,
    status,
    snapshot,
    actions: uniqueActions,
  });

  return {
    generatedAt: options.now?.() ?? Date.now(),
    status: recoveryStatus,
    requiresAction: recoveryStatus === 'action-required',
    health,
    outbox: snapshot.outboxStats ?? status?.outbox ?? null,
    blobUploads:
      snapshot.blobUploadStats ?? status?.lifecycle.blobUploads ?? null,
    recentErrorCodes: snapshot.recentDiagnostics
      .filter((event) => event.level === 'error')
      .map((event) => event.code),
    actions: uniqueActions,
  };
}

export async function runSyncularLocalRecoveryAction(
  client: SyncularLocalRecoveryClient,
  action: SyncularLocalRecoveryAction,
  options: SyncularRunLocalRecoveryActionOptions = {}
): Promise<SyncularLocalRecoveryActionResult> {
  assertRecoveryActionNotBlocked(action);
  assertRecoveryActionConfirmed(action, options);

  const lockOptions = normalizeLocalRecoveryLockOptions(options.lock);
  const navigatorRef =
    options.navigator ??
    (
      globalThis as unknown as {
        navigator?: SyncularLocalRecoveryActionNavigator;
      }
    ).navigator;
  const runAction = async (
    coordination: SyncularLocalRecoveryActionCoordination
  ): Promise<SyncularLocalRecoveryActionResult> => {
    const result = await runLocalRecoveryActionWithoutCoordination(
      client,
      action,
      options
    );
    return { ...result, coordination };
  };

  if (!lockOptions) {
    return runAction(
      createLocalRecoveryCoordination({ lockOptions, actionLockState: null })
    );
  }

  const locks = navigatorRef?.locks;
  if (typeof locks?.request !== 'function') {
    if (lockOptions.required) {
      throw new SyncularLocalRecoveryActionLockError(action, lockOptions.name);
    }
    return runAction(
      createLocalRecoveryCoordination({
        lockOptions,
        actionLockState: 'unavailable',
      })
    );
  }

  let timeoutError: SyncularLocalRecoveryActionLockTimeoutError | null = null;
  let timedOut = false;
  const abortController =
    lockOptions.timeoutMs != null && typeof AbortController !== 'undefined'
      ? new AbortController()
      : null;
  const request = locks
    .request(
      lockOptions.name,
      {
        mode: 'exclusive',
        ...(abortController ? { signal: abortController.signal } : {}),
      },
      () => {
        if (timedOut) {
          throw (
            timeoutError ??
            new SyncularLocalRecoveryActionLockTimeoutError(
              action,
              lockOptions.name,
              lockOptions.timeoutMs ?? 0
            )
          );
        }
        return runAction(
          createLocalRecoveryCoordination({
            lockOptions,
            actionLockState: 'acquired',
          })
        );
      }
    )
    .catch((error) => {
      if (timeoutError) throw timeoutError;
      throw error;
    });

  if (lockOptions.timeoutMs == null) {
    return request;
  }

  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<SyncularLocalRecoveryActionResult>(
    (_, reject) => {
      timeoutId = setTimeout(() => {
        timedOut = true;
        timeoutError = new SyncularLocalRecoveryActionLockTimeoutError(
          action,
          lockOptions.name,
          lockOptions.timeoutMs ?? 0
        );
        abortController?.abort();
        reject(timeoutError);
      }, lockOptions.timeoutMs);
    }
  );

  return Promise.race([request, timeout]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });
}

async function runLocalRecoveryActionWithoutCoordination(
  client: SyncularLocalRecoveryClient,
  action: SyncularLocalRecoveryAction,
  options: SyncularRunLocalRecoveryActionOptions
): Promise<SyncularLocalRecoveryActionResultBase> {
  switch (action.kind) {
    case 'export-support-bundle':
      return {
        action: action.kind,
        bundle: await client.exportLocalSupportBundle(),
      };
    case 'resume-from-background':
      return {
        action: action.kind,
        result: await client.resumeFromBackground(options.syncOptions),
      };
    case 'request-persistent-storage':
      return requestPersistentBrowserStorage(options.navigator);
    case 'retry-blob-uploads':
      return {
        action: action.kind,
        result: await client.processBlobUploadQueue(
          action.blobUploadOptions ?? { retryNow: true }
        ),
      };
    case 'compact-storage':
      return {
        action: action.kind,
        report: await client.compactStorage(action.compactStorageOptions),
      };
    case 'clear-blob-cache':
      await client.clearBlobCache();
      return { action: action.kind };
    case 'force-rebootstrap':
    case 'clear-orphaned-state':
    case 'clear-orphaned-synced-rows':
      return {
        action: action.kind,
        report: await client.repairLocalHealth({
          action: repairActionForRecoveryKind(action.kind),
          subscriptionIds: action.subscriptionIds,
          tables: action.tables,
        }),
      };
    case 'reset-local-sync-state':
      return {
        action: action.kind,
        report: await client.resetLocalSyncState({
          subscriptionIds: action.subscriptionIds,
          clearSyncedRows: action.clearSyncedRows,
        }),
      };
    case 'prepare-sign-out': {
      const report = await client.resetLocalSyncState({
        subscriptionIds: action.subscriptionIds,
        clearSyncedRows: true,
      });
      if (action.clearBlobCache !== false) {
        await client.clearBlobCache();
      }
      return {
        action: action.kind,
        report,
        clearedBlobCache: action.clearBlobCache !== false,
      };
    }
  }
}

function normalizeLocalRecoveryLockOptions(
  lock: SyncularRunLocalRecoveryActionOptions['lock']
): NormalizedLocalRecoveryLockOptions | null {
  if (!lock) return null;
  if (lock === true) {
    return {
      name: DEFAULT_LOCAL_RECOVERY_LOCK_NAME,
      required: false,
    };
  }
  return {
    name: lock.name?.trim() || DEFAULT_LOCAL_RECOVERY_LOCK_NAME,
    required: lock.required === true,
    ...(normalizeLockTimeoutMs(lock.timeoutMs) != null
      ? { timeoutMs: normalizeLockTimeoutMs(lock.timeoutMs) }
      : {}),
  };
}

function createLocalRecoveryCoordination(args: {
  lockOptions: NormalizedLocalRecoveryLockOptions | null;
  actionLockState: SyncularLocalRecoveryActionLockState | null;
}): SyncularLocalRecoveryActionCoordination {
  return {
    lockRequired: args.lockOptions?.required ?? false,
    lockState:
      args.actionLockState ?? (args.lockOptions ? 'waiting' : 'not-requested'),
    ...(args.lockOptions ? { lockName: args.lockOptions.name } : {}),
    ...(args.lockOptions?.timeoutMs != null
      ? { lockTimeoutMs: args.lockOptions.timeoutMs }
      : {}),
  };
}

function normalizeLockTimeoutMs(timeoutMs: unknown): number | undefined {
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs)) {
    return undefined;
  }
  const normalized = Math.ceil(timeoutMs);
  return normalized > 0 ? normalized : undefined;
}

function assertRecoveryActionNotBlocked(
  action: SyncularLocalRecoveryAction
): void {
  if (!action.blockers || action.blockers.length === 0) return;
  throw new SyncularLocalRecoveryBlockedError(action, action.blockers);
}

function assertRecoveryActionConfirmed(
  action: SyncularLocalRecoveryAction,
  options: SyncularRunLocalRecoveryActionOptions
): void {
  if (!action.requiresConfirmation) return;
  if (options.confirmationText === action.confirmationText) return;
  throw new SyncularLocalRecoveryError(action);
}

function applyRecoveryActionBlockers(
  actions: readonly SyncularLocalRecoveryAction[],
  options: SyncularLocalRecoveryPlanOptions
): SyncularLocalRecoveryAction[] {
  if (!options.requireMultiTabCoordinationForDestructiveActions) {
    return [...actions];
  }
  const mode = options.multiTabMode ?? 'unknown';
  if (mode === 'coordinated') return [...actions];
  const blocker = multiTabCoordinationBlocker(mode);
  return actions.map((action) =>
    action.destructive
      ? {
          ...action,
          blockers: [...(action.blockers ?? []), blocker],
        }
      : action
  );
}

function applyRecoveryActionSafety(
  actions: readonly SyncularLocalRecoveryAction[],
  status: SyncularClientStatus | undefined,
  snapshot: SyncularDiagnosticSnapshot
): SyncularLocalRecoveryAction[] {
  const outbox = localRecoveryOutboxSafety(status, snapshot);
  return actions.map((action) => {
    if (!action.destructive) return action;
    const blockers = [...(action.blockers ?? [])];
    if (
      outbox.status === 'has-unsynced-work' &&
      destructiveActionRequiresEmptyOutbox(action)
    ) {
      blockers.push(unsyncedOutboxBlocker(outbox));
    }
    return {
      ...action,
      blockers: blockers.length > 0 ? blockers : undefined,
      safety: {
        dataLossConsequences: dataLossConsequencesForAction(action),
        outbox,
      },
    };
  });
}

function multiTabCoordinationBlocker(
  mode: SyncularLocalRecoveryActionBlockerMultiTabMode
): SyncularLocalRecoveryActionBlocker {
  return {
    code: 'browser.multi_tab_coordination_required',
    message:
      'This destructive local recovery action requires coordinated browser tabs. Close other app tabs or use a browser/runtime with BroadcastChannel and Web Locks before running it.',
    recommendedAction: 'coordinateBrowserTabs',
    details: { multiTabMode: mode },
  };
}

function unsyncedOutboxBlocker(
  outbox: SyncularLocalRecoveryActionOutboxSafety
): SyncularLocalRecoveryActionBlocker {
  return {
    code: 'local.unsynced_outbox_work_present',
    message:
      'This destructive local recovery action can clear synced local rows and is blocked while unsynced outbox work exists. Drain, retry, or resolve the outbox before running it.',
    recommendedAction: 'drainOutbox',
    details: {
      failed: outbox.failed,
      pending: outbox.pending,
      sending: outbox.sending,
      total: outbox.total,
    },
  };
}

function localRecoveryOutboxSafety(
  status: SyncularClientStatus | undefined,
  snapshot: SyncularDiagnosticSnapshot
): SyncularLocalRecoveryActionOutboxSafety {
  const outbox = snapshot.outboxStats ?? status?.outbox ?? null;
  if (!outbox) {
    return {
      failed: null,
      pending: null,
      sending: null,
      status: 'unknown',
      total: null,
    };
  }
  const pending = outbox.pending ?? 0;
  const sending = outbox.sending ?? 0;
  const failed = outbox.failed ?? 0;
  return {
    failed,
    pending,
    sending,
    status: pending + sending + failed > 0 ? 'has-unsynced-work' : 'empty',
    total: outbox.total ?? pending + sending + failed + (outbox.acked ?? 0),
  };
}

function destructiveActionRequiresEmptyOutbox(
  action: SyncularLocalRecoveryAction
): boolean {
  return (
    action.kind === 'prepare-sign-out' ||
    action.kind === 'clear-orphaned-synced-rows' ||
    (action.kind === 'reset-local-sync-state' &&
      action.clearSyncedRows === true)
  );
}

function dataLossConsequencesForAction(
  action: SyncularLocalRecoveryAction
): string[] {
  switch (action.kind) {
    case 'clear-blob-cache':
      return [
        'Deletes locally cached blob bytes. Synced metadata and remote blob objects are kept, and downloads re-fetch on demand.',
      ];
    case 'force-rebootstrap':
      return [
        'Deletes local bootstrap/subscription checkpoints for affected subscriptions. Server data remains authoritative and will be pulled again.',
      ];
    case 'clear-orphaned-state':
      return [
        'Deletes local subscription state and verified roots that no longer match configured subscriptions. Server data remains authoritative.',
      ];
    case 'clear-orphaned-synced-rows':
      return [
        'Deletes local synced app rows outside the currently configured subscription scopes. Local-only rows are not targeted, and unsynced outbox work must be drained first.',
      ];
    case 'reset-local-sync-state':
      return action.clearSyncedRows === true
        ? [
            'Deletes local sync/bootstrap checkpoints and selected synced app rows. Server data remains authoritative, and unsynced outbox work must be drained first.',
          ]
        : [
            'Deletes local sync/bootstrap checkpoints so subscriptions rebootstrap from server authority. Synced app rows are kept.',
          ];
    case 'prepare-sign-out':
      return action.clearBlobCache
        ? [
            'Deletes local sync/bootstrap state, synced app rows, and cached blob bytes for sign-out. Unsynced outbox work must be drained first.',
          ]
        : [
            'Deletes local sync/bootstrap state and synced app rows for sign-out. Unsynced outbox work must be drained first.',
          ];
    default:
      return [
        'Runs a destructive local recovery operation. Review confirmation text, blockers, and outbox state before continuing.',
      ];
  }
}

function supportBundleAction(): SyncularLocalRecoveryAction {
  return {
    id: 'support.export-local-bundle',
    kind: 'export-support-bundle',
    severity: 'info',
    source: 'support',
    title: 'Export local support bundle',
    description:
      'Collect redacted local health, schema, subscription, outbox, conflict, blob, and CRDT diagnostics for tests or support.',
    reasonCodes: ['local.support_bundle_available'],
    destructive: false,
    requiresConfirmation: false,
  };
}

function actionsForErroredBootstrap(
  status: SyncularClientStatus | undefined,
  snapshot: SyncularDiagnosticSnapshot
): SyncularLocalRecoveryAction[] {
  const reasonCodes = forceRebootstrapReasonCodes(status, snapshot);
  if (reasonCodes.length === 0) return [];
  const subscriptionIds = erroredBootstrapSubscriptionIds(snapshot);
  if (subscriptionIds.length === 0) return [];

  return [
    {
      id: 'bootstrap.force-rebootstrap-errored',
      kind: 'force-rebootstrap',
      severity: 'danger',
      source: 'bootstrap',
      title: 'Rebootstrap errored subscriptions',
      description:
        'Bootstrap reached an unrecoverable sync-resource error. Check server availability and schema state, then clear stored bootstrap state for the affected subscriptions so they can pull again.',
      reasonCodes,
      destructive: true,
      requiresConfirmation: true,
      confirmationText: 'rebootstrap errored subscriptions',
      subscriptionIds,
    },
  ];
}

function actionsForRevokedScopes(
  snapshot: SyncularDiagnosticSnapshot
): SyncularLocalRecoveryAction[] {
  const subscriptionIds = revokedSubscriptionIds(snapshot);
  if (subscriptionIds.length === 0) return [];

  return [
    {
      id: 'scope.rebootstrap-revoked',
      kind: 'force-rebootstrap',
      severity: 'danger',
      source: 'scope',
      title: 'Rebootstrap revoked subscriptions',
      description:
        'Subscription access was revoked. Check app permissions, then clear stored bootstrap state for the affected subscriptions so the next sync pulls the current server-authorized view.',
      reasonCodes: ['sync.scope_revoked'],
      destructive: true,
      requiresConfirmation: true,
      confirmationText: 'rebootstrap revoked subscriptions',
      subscriptionIds,
    },
  ];
}

function actionsForLifecycle(
  status: SyncularClientStatus | undefined,
  snapshot: SyncularDiagnosticSnapshot
): SyncularLocalRecoveryAction[] {
  const requiresAction =
    status?.requiresAction ?? status?.lifecycle.requiresAction ?? false;
  const lastErrorCode =
    status?.lifecycle.lastError?.code ?? snapshot.connection.lastError?.code;
  if (!requiresAction && !lastErrorCode) return [];

  return [
    {
      id: 'lifecycle.resume-from-background',
      kind: 'resume-from-background',
      severity: requiresAction ? 'warning' : 'info',
      source: 'lifecycle',
      title: 'Resume and retry sync',
      description:
        'Refresh lifecycle state, restart realtime recovery when configured, and run the normal sync recovery path.',
      reasonCodes: [
        ...(requiresAction ? ['lifecycle.requires_action'] : []),
        ...(lastErrorCode ? [lastErrorCode] : []),
      ],
      destructive: false,
      requiresConfirmation: false,
    },
  ];
}

function actionsForOutbox(
  status: SyncularClientStatus | undefined,
  snapshot: SyncularDiagnosticSnapshot
): SyncularLocalRecoveryAction[] {
  const outbox = snapshot.outboxStats ?? status?.outbox;
  if (!outbox || outbox.failed <= 0) return [];
  return [
    {
      id: 'outbox.resume-failed',
      kind: 'resume-from-background',
      severity: 'warning',
      source: 'outbox',
      title: 'Retry failed outbox work',
      description:
        'Run the normal resume/sync recovery path for failed local outbox commits.',
      reasonCodes: ['outbox.failed'],
      destructive: false,
      requiresConfirmation: false,
    },
  ];
}

function actionsForBlobUploads(
  status: SyncularClientStatus | undefined,
  snapshot: SyncularDiagnosticSnapshot
): SyncularLocalRecoveryAction[] {
  const uploads = snapshot.blobUploadStats ?? status?.lifecycle.blobUploads;
  if (!uploads || uploads.failed <= 0) return [];
  return [
    {
      id: 'blob.retry-failed-uploads',
      kind: 'retry-blob-uploads',
      severity: 'warning',
      source: 'blob',
      title: 'Retry failed blob uploads',
      description:
        'Retry failed blob upload queue entries without clearing local data.',
      reasonCodes: ['blob.uploads_failed'],
      destructive: false,
      requiresConfirmation: false,
      blobUploadOptions: { retryNow: true },
    },
  ];
}

function actionsForStoragePreflight(
  options: SyncularLocalRecoveryPlanOptions,
  snapshot: SyncularDiagnosticSnapshot
): SyncularLocalRecoveryAction[] {
  const preflight = options.deploymentPreflight;
  if (!preflight) return [];
  const storageReasonCodes = storagePreflightReasonCodes(preflight);
  if (storageReasonCodes.length === 0) return [];

  const actions: SyncularLocalRecoveryAction[] = [];
  const recommendedActions = new Set(preflight.support.recommendedActions);
  const storageIssues = new Set(storageReasonCodes);

  if (
    recommendedActions.has('requestPersistentStorage') &&
    preflight.storage.persistRequestSupported !== false
  ) {
    actions.push({
      id: 'storage.request-persistence',
      kind: 'request-persistent-storage',
      severity: 'warning',
      source: 'storage',
      title: 'Request persistent browser storage',
      description:
        'Ask the browser to protect Syncular offline data from routine storage eviction. The browser may still deny the grant, so keep the preflight result visible.',
      reasonCodes: storageReasonCodes.filter(isPersistenceStorageIssueCode),
      destructive: false,
      requiresConfirmation: false,
    });
  }

  if (
    recommendedActions.has('freeStorageQuota') ||
    storageIssues.has('browser.storage_quota_low') ||
    storageIssues.has('browser.storage_pressure_high')
  ) {
    const quotaReasonCodes = storageReasonCodes.filter(isQuotaStorageIssueCode);
    actions.push({
      id: 'storage.compact',
      kind: 'compact-storage',
      severity: 'warning',
      source: 'storage',
      title: 'Compact local storage for quota pressure',
      description:
        'Run bounded local cleanup for acked outbox commits, resolved conflicts, inactive sync state, tombstones, and blob cache before browser quota pressure turns into write failures.',
      reasonCodes: quotaReasonCodes,
      destructive: false,
      requiresConfirmation: false,
      compactStorageOptions: options.compactStorageOptions,
    });
    if (canClearBlobCache(snapshot)) {
      actions.push({
        id: 'blob.clear-cache',
        kind: 'clear-blob-cache',
        severity: 'warning',
        source: 'blob',
        title: 'Clear local blob cache for quota pressure',
        description:
          'Clear cached blob bytes to free browser storage. Synced metadata and remote blob objects are not deleted.',
        reasonCodes: quotaReasonCodes,
        destructive: true,
        requiresConfirmation: true,
        confirmationText: 'clear local blob cache',
      });
    }
  }

  return actions.filter((action) => action.reasonCodes.length > 0);
}

function actionsForHealth(
  health: SyncularLocalHealthReport
): SyncularLocalRecoveryAction[] {
  const groups = groupHealthFindingsByRepairAction(health.findings);
  const actions: SyncularLocalRecoveryAction[] = [];
  for (const [repairAction, findings] of groups) {
    const action = recoveryActionForHealthFindings(repairAction, findings);
    if (action) actions.push(action);
  }
  return actions;
}

function actionsForRequestedOptions(
  options: SyncularLocalRecoveryPlanOptions,
  status: SyncularClientStatus | undefined,
  snapshot: SyncularDiagnosticSnapshot
): SyncularLocalRecoveryAction[] {
  const actions: SyncularLocalRecoveryAction[] = [];
  const blobCacheClearAvailable = canClearBlobCache(snapshot);
  if (options.includeMaintenanceActions) {
    actions.push({
      id: 'storage.compact',
      kind: 'compact-storage',
      severity: 'info',
      source: 'storage',
      title: 'Compact local storage',
      description:
        'Run bounded local cleanup for acked outbox commits, resolved conflicts, inactive sync state, tombstones, and blob cache according to the supplied options.',
      reasonCodes: ['storage.maintenance_requested'],
      destructive: false,
      requiresConfirmation: false,
      compactStorageOptions: options.compactStorageOptions,
    });
    if (blobCacheClearAvailable) {
      actions.push({
        id: 'blob.clear-cache',
        kind: 'clear-blob-cache',
        severity: 'warning',
        source: 'blob',
        title: 'Clear local blob cache',
        description:
          'Clear cached blob bytes. Synced metadata and remote blob objects are not deleted.',
        reasonCodes: ['blob.cache_clear_requested'],
        destructive: true,
        requiresConfirmation: true,
        confirmationText: 'clear local blob cache',
      });
    }
  }
  if (options.includeResetAction) {
    actions.push({
      id: 'storage.reset-local-sync-state',
      kind: 'reset-local-sync-state',
      severity: 'danger',
      source: 'storage',
      title: 'Reset local sync state',
      description:
        'Forget local subscription/bootstrap state and optionally clear synced app rows so the client can rebootstrap from the server.',
      reasonCodes: ['local.sync_state_reset_requested'],
      destructive: true,
      requiresConfirmation: true,
      confirmationText: 'reset local sync state',
      subscriptionIds: [...(options.resetSubscriptionIds ?? [])],
      clearSyncedRows: options.resetClearSyncedRows === true,
    });
  }
  if (options.includeSignOutAction) {
    const unresolvedOutbox = unresolvedOutboxCount(status, snapshot);
    if (unresolvedOutbox > 0) {
      actions.push({
        id: 'sign-out.drain-outbox-first',
        kind: 'resume-from-background',
        severity: 'warning',
        source: 'outbox',
        title: 'Sync local work before sign-out cleanup',
        description:
          'Local sign-out cleanup is blocked while unsynced outbox work exists. Drain, retry, or resolve the queue before clearing synced local rows.',
        reasonCodes: ['sign_out.outbox_not_empty'],
        destructive: false,
        requiresConfirmation: false,
      });
    } else {
      const clearBlobCache =
        options.signOutClearBlobCache !== false && blobCacheClearAvailable;
      actions.push({
        id: 'storage.prepare-sign-out',
        kind: 'prepare-sign-out',
        severity: 'danger',
        source: 'storage',
        title: 'Prepare local data for sign-out',
        description: clearBlobCache
          ? 'Reset subscription/bootstrap state, clear synced app rows, and clear cached blob bytes so the next user reboots from server authority.'
          : 'Reset subscription/bootstrap state and clear synced app rows so the next user reboots from server authority.',
        reasonCodes: ['sign_out.clear_local_data_requested'],
        destructive: true,
        requiresConfirmation: true,
        confirmationText: 'prepare local sign-out',
        subscriptionIds: [...(options.signOutSubscriptionIds ?? [])],
        clearSyncedRows: true,
        clearBlobCache,
      });
    }
  }
  return actions;
}

function canClearBlobCache(snapshot: SyncularDiagnosticSnapshot): boolean {
  const features = snapshot.runtime.rust?.features;
  return !features || features.includes('blobs');
}

async function requestPersistentBrowserStorage(
  navigatorRef?: SyncularLocalRecoveryActionNavigator
): Promise<
  Extract<
    SyncularLocalRecoveryActionResultBase,
    { action: 'request-persistent-storage' }
  >
> {
  const resolvedNavigator =
    navigatorRef ??
    (
      globalThis as unknown as {
        navigator?: SyncularLocalRecoveryActionNavigator;
      }
    ).navigator;
  const persist = resolvedNavigator?.storage?.persist;
  if (typeof persist !== 'function') {
    return {
      action: 'request-persistent-storage',
      supported: false,
      granted: null,
    };
  }
  return {
    action: 'request-persistent-storage',
    supported: true,
    granted: await persist(),
  };
}

function unresolvedOutboxCount(
  status: SyncularClientStatus | undefined,
  snapshot: SyncularDiagnosticSnapshot
): number {
  const outbox = snapshot.outboxStats ?? status?.outbox;
  if (!outbox) return 0;
  return outbox.pending + outbox.sending + outbox.failed;
}

function storagePreflightReasonCodes(
  preflight: SyncularBrowserDeploymentPreflight
): SyncularBrowserDeploymentPreflightIssueCode[] {
  return [
    ...new Set(
      preflight.issues
        .filter((issue) => issue.target === 'storage')
        .map((issue) => issue.code)
        .filter(isStoragePreflightIssueCode)
    ),
  ].sort();
}

function isStoragePreflightIssueCode(
  code: SyncularBrowserDeploymentPreflightIssueCode
): code is SyncularBrowserDeploymentPreflightIssueCode {
  return (
    isPersistenceStorageIssueCode(code) ||
    isQuotaStorageIssueCode(code) ||
    code === 'browser.indexeddb_unavailable' ||
    code === 'browser.opfs_unavailable'
  );
}

function isPersistenceStorageIssueCode(
  code: SyncularBrowserDeploymentPreflightIssueCode
): boolean {
  return (
    code === 'browser.storage_persistence_not_granted' ||
    code === 'browser.storage_persistence_unavailable'
  );
}

function isQuotaStorageIssueCode(
  code: SyncularBrowserDeploymentPreflightIssueCode
): boolean {
  return (
    code === 'browser.storage_quota_low' ||
    code === 'browser.storage_pressure_high'
  );
}

function revokedSubscriptionIds(
  snapshot: SyncularDiagnosticSnapshot
): string[] {
  const ids: string[] = [];
  for (const subscription of snapshot.subscriptions) {
    if (subscription.status === 'revoked') ids.push(subscription.id);
  }
  for (const subscription of snapshot.bootstrap?.subscriptions ?? []) {
    if (subscription.status === 'revoked') ids.push(subscription.id);
  }
  for (const event of snapshot.recentDiagnostics) {
    if (event.code !== 'sync.scope_revoked') continue;
    if (event.subscriptionId) ids.push(event.subscriptionId);
    const eventIds = event.details?.revokedSubscriptionIds;
    if (Array.isArray(eventIds)) {
      ids.push(
        ...eventIds.filter(
          (subscriptionId) => typeof subscriptionId === 'string'
        )
      );
    }
  }
  return uniqueStrings(ids);
}

function erroredBootstrapSubscriptionIds(
  snapshot: SyncularDiagnosticSnapshot
): string[] {
  return uniqueStrings([
    ...snapshot.subscriptions
      .filter((subscription) => subscription.phase === 'error')
      .map((subscription) => subscription.id),
    ...(snapshot.bootstrap?.subscriptions ?? [])
      .filter((subscription) => subscription.phase === 'error')
      .map((subscription) => subscription.id),
  ]);
}

function forceRebootstrapReasonCodes(
  status: SyncularClientStatus | undefined,
  snapshot: SyncularDiagnosticSnapshot
): string[] {
  const codes = [
    status?.lifecycle.lastError?.code,
    snapshot.connection.lastError?.code,
    ...snapshot.recentDiagnostics.map((event) => event.code),
  ];
  return uniqueStrings(codes.filter(isForceRebootstrapErrorCode));
}

function isForceRebootstrapErrorCode(code: unknown): code is string {
  return code === 'sync.integrity_rejected' || code === 'sync.not_found';
}

function groupHealthFindingsByRepairAction(
  findings: readonly SyncularLocalHealthFinding[]
): Map<SyncularLocalHealthRepairAction, SyncularLocalHealthFinding[]> {
  const groups = new Map<
    SyncularLocalHealthRepairAction,
    SyncularLocalHealthFinding[]
  >();
  for (const finding of findings) {
    const action = finding.repairAction ?? 'manualInspection';
    const items = groups.get(action) ?? [];
    items.push(finding);
    groups.set(action, items);
  }
  return groups;
}

function recoveryActionForHealthFindings(
  repairAction: SyncularLocalHealthRepairAction,
  findings: readonly SyncularLocalHealthFinding[]
): SyncularLocalRecoveryAction | undefined {
  const reasonCodes = [...new Set(findings.map((finding) => finding.code))];
  const subscriptionIds = uniqueStrings(
    findings.flatMap((finding) =>
      finding.subscriptionId ? [finding.subscriptionId] : []
    )
  );
  const tables = uniqueStrings(
    findings.flatMap((finding) => (finding.table ? [finding.table] : []))
  );

  switch (repairAction) {
    case 'forceRebootstrap':
      return {
        id: 'health.force-rebootstrap',
        kind: 'force-rebootstrap',
        severity: 'danger',
        source: 'health',
        title: 'Force subscription rebootstrap',
        description:
          'Clear stored bootstrap state for affected subscriptions so they can be pulled from the server again.',
        reasonCodes,
        destructive: true,
        requiresConfirmation: true,
        confirmationText: 'force local rebootstrap',
        subscriptionIds,
      };
    case 'clearOrphanedState':
      return {
        id: 'health.clear-orphaned-state',
        kind: 'clear-orphaned-state',
        severity: 'warning',
        source: 'health',
        title: 'Clear orphaned sync state',
        description:
          'Remove stored subscription state and verified roots that no longer belong to configured subscriptions.',
        reasonCodes,
        destructive: true,
        requiresConfirmation: true,
        confirmationText: 'clear orphaned sync state',
        subscriptionIds,
      };
    case 'clearOrphanedSyncedRows':
      return {
        id: 'health.clear-orphaned-synced-rows',
        kind: 'clear-orphaned-synced-rows',
        severity: 'danger',
        source: 'health',
        title: 'Clear orphaned synced rows',
        description:
          'Delete synced app rows that are outside the currently configured subscription scopes. Local-only rows are not targeted.',
        reasonCodes,
        destructive: true,
        requiresConfirmation: true,
        confirmationText: 'clear orphaned synced rows',
        tables,
      };
    case 'manualInspection':
      return undefined;
  }
}

function repairActionForRecoveryKind(
  kind:
    | 'force-rebootstrap'
    | 'clear-orphaned-state'
    | 'clear-orphaned-synced-rows'
): SyncularLocalHealthRepairAction {
  switch (kind) {
    case 'force-rebootstrap':
      return 'forceRebootstrap';
    case 'clear-orphaned-state':
      return 'clearOrphanedState';
    case 'clear-orphaned-synced-rows':
      return 'clearOrphanedSyncedRows';
  }
}

function summarizeRecoveryStatus(args: {
  health: SyncularLocalHealthReport;
  status: SyncularClientStatus | undefined;
  snapshot: SyncularDiagnosticSnapshot;
  actions: readonly SyncularLocalRecoveryAction[];
}): SyncularLocalRecoveryStatus {
  const { health, status, snapshot, actions } = args;
  if (
    !health.ok ||
    status?.requiresAction ||
    status?.lifecycle.requiresAction ||
    snapshot.connection.lastError ||
    actions.some((action) => action.severity === 'danger')
  ) {
    return 'action-required';
  }
  if (
    actions.some((action) => action.severity === 'warning') ||
    (snapshot.outboxStats?.failed ?? status?.outbox?.failed ?? 0) > 0 ||
    (snapshot.blobUploadStats?.failed ??
      status?.lifecycle.blobUploads?.failed ??
      0) > 0
  ) {
    return 'maintenance-recommended';
  }
  return 'healthy';
}

function dedupeActions(
  actions: readonly SyncularLocalRecoveryAction[]
): SyncularLocalRecoveryAction[] {
  const seen = new Set<string>();
  const result: SyncularLocalRecoveryAction[] = [];
  for (const action of actions) {
    if (seen.has(action.id)) continue;
    seen.add(action.id);
    result.push(action);
  }
  return result;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}
