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
  | 'outbox'
  | 'blob'
  | 'health'
  | 'storage';

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
  subscriptionIds?: string[];
  tables?: string[];
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
}

export interface SyncularRunLocalRecoveryActionOptions {
  confirmationText?: string;
  syncOptions?: SyncularSyncRequestOptions;
}

export type SyncularLocalRecoveryActionResult =
  | {
      action: 'export-support-bundle';
      bundle: SyncularLocalSupportBundle;
    }
  | {
      action: 'resume-from-background';
      result: SyncularSyncResult;
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
    ...actionsForLifecycle(status, snapshot),
    ...actionsForOutbox(status, snapshot),
    ...actionsForBlobUploads(status, snapshot),
    ...actionsForHealth(health),
    ...actionsForRequestedOptions(options, status, snapshot),
  ];
  const uniqueActions = dedupeActions(actions);
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
  assertRecoveryActionConfirmed(action, options);

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

function assertRecoveryActionConfirmed(
  action: SyncularLocalRecoveryAction,
  options: SyncularRunLocalRecoveryActionOptions
): void {
  if (!action.requiresConfirmation) return;
  if (options.confirmationText === action.confirmationText) return;
  throw new SyncularLocalRecoveryError(action);
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
      actions.push({
        id: 'storage.prepare-sign-out',
        kind: 'prepare-sign-out',
        severity: 'danger',
        source: 'storage',
        title: 'Prepare local data for sign-out',
        description:
          'Reset subscription/bootstrap state, clear synced app rows, and clear cached blob bytes so the next user reboots from server authority.',
        reasonCodes: ['sign_out.clear_local_data_requested'],
        destructive: true,
        requiresConfirmation: true,
        confirmationText: 'prepare local sign-out',
        subscriptionIds: [...(options.signOutSubscriptionIds ?? [])],
        clearSyncedRows: true,
        clearBlobCache: options.signOutClearBlobCache !== false,
      });
    }
  }
  return actions;
}

function unresolvedOutboxCount(
  status: SyncularClientStatus | undefined,
  snapshot: SyncularDiagnosticSnapshot
): number {
  const outbox = snapshot.outboxStats ?? status?.outbox;
  if (!outbox) return 0;
  return outbox.pending + outbox.sending + outbox.failed;
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
