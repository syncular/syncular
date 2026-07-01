import { Link } from '@tanstack/react-router';
import { Activity, Database, RefreshCw } from 'lucide-react';
import { useMemo } from 'react';
import {
  useClientDiagnosticHistory,
  useClientDiagnostics,
  useClients,
  usePartitionContext,
  usePreferences,
  useStats,
  useTimeline,
} from '../hooks';
import type {
  ConsoleClientDiagnosticRecord,
  ConsoleTimelineItem,
} from '../lib/types';
import {
  Badge,
  Button,
  EmptyState,
  PanelShell,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../ui';

interface ClientDetailsProps {
  clientId: string;
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return '--';
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Date(timestamp).toLocaleString();
}

function formatScopes(scopes: Record<string, unknown> | null | undefined) {
  const keys = Object.keys(scopes ?? {}).sort();
  return keys.length > 0 ? keys : ['none observed'];
}

function stringField(
  record: Record<string, unknown> | null | undefined,
  key: string,
  fallback = '--'
): string {
  const value = record?.[key];
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return fallback;
}

function numberField(
  record: Record<string, unknown> | null | undefined,
  key: string
): number | null {
  const value = record?.[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function objectField(
  record: Record<string, unknown> | null | undefined,
  key: string
): Record<string, unknown> | null {
  const value = record?.[key];
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function hasAnyField(
  record: Record<string, unknown> | null | undefined,
  fields: string[]
): boolean {
  return fields.some((field) => {
    const value = record?.[field];
    return value !== null && value !== undefined && value !== '';
  });
}

function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '--';
  }
  return value.toLocaleString();
}

function formatDurationMs(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '--';
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)}ms`;
}

function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '--';
  }
  const percent = value <= 1 ? value * 100 : value;
  return `${percent.toFixed(percent >= 10 ? 1 : 2)}%`;
}

function formatBytes(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '--';
  }
  if (value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let unitIndex = 0;
  let size = value;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function timelineEntryKey(item: ConsoleTimelineItem): string {
  if (item.commit) {
    return `commit:${item.commit.federatedCommitId ?? item.commit.commitSeq}`;
  }
  if (item.event) {
    return `event:${item.event.federatedEventId ?? item.event.eventId}`;
  }
  return `${item.type}:${item.timestamp}`;
}

function timelineEntryLabel(item: ConsoleTimelineItem): string {
  if (item.commit) return `commit #${item.commit.commitSeq}`;
  if (item.event) return `event #${item.event.eventId}`;
  return item.type;
}

function timelineEntryHref(item: ConsoleTimelineItem): string | null {
  if (item.commit) {
    return `/investigate/commit/${encodeURIComponent(String(item.commit.federatedCommitId ?? item.commit.commitSeq))}`;
  }
  if (item.event) {
    return `/investigate/event/${encodeURIComponent(String(item.event.federatedEventId ?? item.event.eventId))}`;
  }
  return null;
}

export function ClientDetails({ clientId }: ClientDetailsProps) {
  const { preferences } = usePreferences();
  const { partitionId } = usePartitionContext();
  const refreshIntervalMs = preferences.refreshInterval * 1000;

  const {
    data: stats,
    isLoading: statsLoading,
    refetch: refetchStats,
  } = useStats({
    refetchIntervalMs: refreshIntervalMs,
    partitionId,
  });
  const {
    data: clients,
    isLoading: clientsLoading,
    error: clientsError,
    refetch: refetchClients,
  } = useClients(
    {
      limit: 100,
      offset: 0,
      partitionId,
    },
    { refetchIntervalMs: refreshIntervalMs }
  );
  const {
    data: timeline,
    isLoading: timelineLoading,
    refetch: refetchTimeline,
  } = useTimeline(
    {
      limit: 25,
      offset: 0,
      partitionId,
      clientId,
      view: 'all',
    },
    { refetchIntervalMs: refreshIntervalMs }
  );
  const {
    data: diagnosticData,
    isLoading: diagnosticsLoading,
    refetch: refetchDiagnostics,
  } = useClientDiagnostics(
    {
      limit: 1,
      offset: 0,
      partitionId,
      clientId,
    },
    { refetchIntervalMs: refreshIntervalMs }
  );
  const {
    data: diagnosticHistoryData,
    isLoading: diagnosticHistoryLoading,
    refetch: refetchDiagnosticHistory,
  } = useClientDiagnosticHistory(
    clientId,
    {
      limit: 8,
      offset: 0,
      partitionId,
    },
    { refetchIntervalMs: refreshIntervalMs }
  );

  const client = useMemo(
    () =>
      clients?.items.find(
        (item) =>
          item.clientId === clientId || item.federatedClientId === clientId
      ),
    [clientId, clients?.items]
  );
  const headSeq = stats?.maxCommitSeq ?? 0;
  const lag = client ? Math.max(0, headSeq - client.cursor) : 0;
  const scopeKeys = formatScopes(client?.effectiveScopes);
  const recentItems = timeline?.items ?? [];
  const diagnostics = diagnosticData?.items[0] ?? null;
  const diagnosticHistory = diagnosticHistoryData?.items ?? [];

  const refetchAll = () => {
    void refetchStats();
    void refetchClients();
    void refetchTimeline();
    void refetchDiagnostics();
    void refetchDiagnosticHistory();
  };

  if (clientsLoading || statsLoading) {
    return (
      <div className="flex items-center justify-center h-[240px]">
        <Spinner size="lg" />
      </div>
    );
  }

  if (clientsError) {
    return (
      <div className="flex items-center justify-center h-[240px]">
        <p className="text-danger">
          Failed to load client fleet: {clientsError.message}
        </p>
      </div>
    );
  }

  if (!client) {
    return (
      <div className="px-5 py-5">
        <PanelShell
          title="Client"
          description="No cursor row currently exists for this client in the selected partition."
          actions={
            <Link to="/fleet">
              <Button variant="secondary" size="sm">
                Back to Fleet
              </Button>
            </Link>
          }
        >
          <EmptyState message={clientId} />
        </PanelShell>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5 px-5 py-5">
      <PanelShell
        title="Client Drilldown"
        description="Server-observed sync state joined with the latest redacted Rust runtime snapshot reported by this client."
        actions={
          <>
            <Button variant="secondary" size="sm" onClick={refetchAll}>
              <RefreshCw className="h-3 w-3" />
              Refresh
            </Button>
            <Link to="/fleet">
              <Button variant="default" size="sm">
                Fleet
              </Button>
            </Link>
          </>
        }
      >
        <div className="grid grid-cols-1 lg:grid-cols-[1.2fr_0.8fr] gap-4">
          <div className="min-w-0">
            <p className="font-mono text-[10px] text-neutral-500 uppercase tracking-widest">
              Client id
            </p>
            <p className="mt-1 font-mono text-sm text-white break-all">
              {client.clientId}
            </p>
            {client.federatedClientId ? (
              <p className="mt-1 font-mono text-[10px] text-neutral-500 break-all">
                federated: {client.federatedClientId}
              </p>
            ) : null}

            <div className="mt-4 flex flex-wrap gap-2">
              <Badge
                variant={
                  client.activityState === 'active'
                    ? 'healthy'
                    : client.activityState === 'idle'
                      ? 'syncing'
                      : 'offline'
                }
              >
                {client.activityState}
              </Badge>
              <Badge
                variant={
                  client.connectionMode === 'realtime' ? 'flow' : 'ghost'
                }
              >
                {client.connectionMode}
              </Badge>
              <Badge variant="ghost">{client.connectionPath}</Badge>
              {client.isRealtimeConnected ? (
                <Badge variant="flow">
                  {client.realtimeConnectionCount} websocket
                </Badge>
              ) : null}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Metric label="Actor" value={client.actorId || '--'} />
            <Metric label="Cursor" value={`#${client.cursor}`} />
            <Metric label="Head" value={`#${headSeq}`} />
            <Metric label="Lag" value={String(lag)} intent={lag > 0} />
            <Metric
              label="Last request"
              value={client.lastRequestType ?? '--'}
              detail={client.lastRequestOutcome ?? undefined}
            />
            <Metric
              label="Last seen"
              value={formatDateTime(client.updatedAt)}
              detail={formatDateTime(client.lastRequestAt)}
            />
          </div>
        </div>
      </PanelShell>

      <ClientRuntimeDiagnostics
        diagnostics={diagnostics}
        history={diagnosticHistory}
        historyLoading={diagnosticHistoryLoading}
        isLoading={diagnosticsLoading}
      />

      <div className="grid grid-cols-1 xl:grid-cols-[0.75fr_1.25fr] gap-5">
        <PanelShell
          title="Scope Coverage"
          description="Effective scope keys last recorded by server-side pull."
        >
          <div className="flex flex-wrap gap-2">
            {scopeKeys.map((scopeKey) => (
              <Badge key={scopeKey} variant="ghost">
                {scopeKey}
              </Badge>
            ))}
          </div>
        </PanelShell>

        <PanelShell
          title="Recent Client Timeline"
          description="Push, pull, and commit evidence filtered by client id."
          actions={
            timelineLoading ? (
              <span className="inline-flex items-center gap-1 font-mono text-[10px] text-neutral-500">
                <Spinner size="sm" />
                Loading
              </span>
            ) : null
          }
        >
          {recentItems.length === 0 ? (
            <EmptyState message="No recent events for this client" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[150px]">When</TableHead>
                  <TableHead className="w-[110px]">Type</TableHead>
                  <TableHead className="w-[130px]">Outcome</TableHead>
                  <TableHead className="flex-1">Correlation</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recentItems.map((item) => {
                  const event = item.event;
                  const commit = item.commit;
                  const href = timelineEntryHref(item);
                  return (
                    <TableRow key={timelineEntryKey(item)}>
                      <TableCell className="w-[150px]">
                        <span className="font-mono text-[10px] text-neutral-400">
                          {formatDateTime(item.timestamp)}
                        </span>
                      </TableCell>
                      <TableCell className="w-[110px]">
                        {href ? (
                          <Link
                            to={href}
                            className="font-mono text-[10px] text-flow hover:text-white"
                          >
                            {timelineEntryLabel(item)}
                          </Link>
                        ) : (
                          <span className="font-mono text-[10px] text-neutral-400">
                            {timelineEntryLabel(item)}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="w-[130px]">
                        <Badge
                          variant={
                            event?.outcome === 'error' ||
                            event?.outcome === 'rejected'
                              ? 'destructive'
                              : 'ghost'
                          }
                        >
                          {event?.outcome ?? 'commit'}
                        </Badge>
                      </TableCell>
                      <TableCell className="flex-1">
                        <div className="flex flex-col gap-1 font-mono text-[10px] text-neutral-500">
                          {event?.traceId ? (
                            <span className="break-all">
                              trace {event.traceId}
                            </span>
                          ) : null}
                          {event?.requestId ? (
                            <span className="break-all">
                              request {event.requestId}
                            </span>
                          ) : null}
                          {commit?.clientCommitId ? (
                            <span className="break-all">
                              client commit {commit.clientCommitId}
                            </span>
                          ) : null}
                          {!event?.traceId &&
                          !event?.requestId &&
                          !commit?.clientCommitId ? (
                            <span>--</span>
                          ) : null}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </PanelShell>
      </div>
    </div>
  );
}

function ClientRuntimeDiagnostics({
  diagnostics,
  history,
  historyLoading,
  isLoading,
}: {
  diagnostics: ConsoleClientDiagnosticRecord | null;
  history: ConsoleClientDiagnosticRecord[];
  historyLoading: boolean;
  isLoading: boolean;
}) {
  if (isLoading && !diagnostics) {
    return (
      <PanelShell
        title="Rust Runtime Snapshot"
        description="Waiting for the latest redacted diagnostic snapshot."
      >
        <div className="flex items-center justify-center h-[120px]">
          <Spinner size="sm" />
        </div>
      </PanelShell>
    );
  }

  if (!diagnostics) {
    return (
      <PanelShell
        title="Rust Runtime Snapshot"
        description="No redacted client diagnostic snapshot has been reported for this client yet."
      >
        <EmptyState message="Runtime diagnostics unavailable" />
      </PanelShell>
    );
  }

  const lifecycle = diagnostics.lifecycle;
  const connection = diagnostics.connection;
  const bootstrap = diagnostics.bootstrap;
  const transport = diagnostics.transportStats;
  const runtime = diagnostics.runtime;
  const rust = runtime?.rust;
  const storageFallback = runtime?.storageFallback;
  const storageLabel = storageFallback
    ? `${storageFallback.from ?? '?'} -> ${storageFallback.to ?? '?'}`
    : (runtime?.storage ?? '--');
  const latestTiming =
    diagnostics.recentSyncTimings[diagnostics.recentSyncTimings.length - 1] ??
    objectField(diagnostics.timingSummary, 'latest');
  const hasBrowserAssetSummary = hasAnyField(transport, [
    'assetCount',
    'totalAssetBytes',
    'browserSupportPolicyMarkerInAssets',
    'deploymentPreflightMarkerInAssets',
    'lifecycleResumeMarkerInAssets',
    'starterTimelineMarkerInAssets',
    'supportBundleMarkerInAssets',
  ]);
  const hasBrowserSupportPolicySummary = hasAnyField(transport, [
    'browserSupportPolicy',
    'browserSupportPolicyStatus',
    'browserSupportPolicyContext',
    'browserSupportPolicyExpectedSupportTier',
    'browserSupportPolicyObservedSupportTier',
    'browserSupportPolicyExpectedPersistence',
    'browserSupportPolicyObservedPersistence',
    'browserSupportPolicyPreflightRequired',
    'browserSupportPolicyReasonCount',
    'browserSupportPolicyFirstReason',
    'browserSupportPolicyRequiredEvidenceCount',
    'browserSupportPolicyFirstRequiredEvidence',
    'browserSupportPolicyKnownRiskCount',
    'browserSupportPolicyFirstKnownRisk',
    'browserSupportPolicyNextStepCount',
    'browserSupportPolicyFirstNextStep',
  ]);
  const hasBrowserDeploymentSummary = hasAnyField(transport, [
    'deploymentPreflightStatus',
    'deploymentPreflightSupportTier',
    'deploymentPreflightPersistence',
    'deploymentPreflightQuotaPressure',
    'deploymentPreflightAvailableBytes',
    'deploymentPreflightQuotaBytes',
    'deploymentPreflightUsageBytes',
    'deploymentPreflightUsageRatio',
    'serviceWorker',
    'serviceWorkerControlled',
    'serviceWorkerControllerState',
    'serviceWorkerControllerScriptPath',
  ]);
  const hasBrowserLifecycleSummary = hasAnyField(latestTiming, [
    'lifecycleResumeCount',
    'lifecycleResumeStatus',
    'lifecycleResumeReason',
    'lifecycleResumeLockName',
    'lifecycleResumeLockRequired',
    'lifecycleResumeLockState',
    'lifecycleResumeLockTimeoutMs',
    'lifecyclePauseCount',
    'lifecyclePauseReason',
    'lifecyclePauseVisibilityState',
    'lifecycleShutdownSignalCount',
  ]);
  const cloudflareBlobMetrics =
    objectField(latestTiming, 'blobMetrics') ?? diagnostics.blobUploadStats;
  const hasCloudflareRuntimeSummary = hasAnyField(transport, [
    'route',
    'port',
    'syncRouteBase',
    'blobRouteBase',
    'webSocketRoute',
    'outputExcerptLength',
    'blobMetricsAttempted',
    'blobContentBytes',
    'blobDownloadBytes',
    'blobPartitionedDownloadBytes',
  ]);
  const hasCloudflareBlobSummary =
    hasAnyField(transport, [
      'blobMetricsAttempted',
      'blobContentBytes',
      'blobDownloadBytes',
      'blobPartitionedDownloadBytes',
    ]) ||
    hasAnyField(cloudflareBlobMetrics, [
      'attempted',
      'contentBytes',
      'downloadBytes',
      'partitionedDownloadBytes',
      'uploadInitMs',
      'uploadBytesMs',
      'completeUploadMs',
      'downloadUrlMs',
      'downloadBytesMs',
      'partitionedDownloadUrlMs',
      'partitionedDownloadBytesMs',
      'totalMs',
    ]);
  const hasBlobUploadQueue = hasAnyField(diagnostics.blobUploadStats, [
    'pending',
    'uploading',
    'failed',
  ]);
  const recentDiagnostics = [...diagnostics.recentDiagnostics]
    .slice(-8)
    .reverse();

  return (
    <div className="grid grid-cols-1 2xl:grid-cols-[1.1fr_0.9fr] gap-5">
      <PanelShell
        title="Rust Runtime Snapshot"
        description={`Reported ${formatDateTime(diagnostics.reportedAt)}; received ${formatDateTime(diagnostics.receivedAt)}.`}
      >
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Metric
            label="Freshness"
            value={diagnostics.freshnessState}
            detail={formatDateTime(diagnostics.receivedAt)}
            intent={diagnostics.freshnessState === 'stale'}
          />
          <Metric
            label="Health"
            value={diagnostics.healthMaxSeverity ?? '--'}
            detail={
              diagnostics.diagnosticCodesSummary[0]?.code ??
              'no diagnostic codes'
            }
            intent={diagnostics.healthMaxSeverity === 'error'}
          />
          <Metric
            label="Lifecycle"
            value={stringField(lifecycle, 'phase')}
            detail={
              stringField(lifecycle, 'requiresAction', 'false') === 'true'
                ? 'requires action'
                : undefined
            }
            intent={
              stringField(lifecycle, 'requiresAction', 'false') === 'true'
            }
          />
          <Metric
            label="Realtime"
            value={stringField(lifecycle, 'realtime')}
            detail={stringField(connection, 'realtime')}
          />
          <Metric
            label="Pending"
            value={formatNumber(numberField(connection, 'pendingRequests'))}
          />
          <Metric label="Storage" value={storageLabel} />
          <Metric
            label="Package"
            value={runtime?.packageName ?? '--'}
            detail={runtime?.packageVersion}
          />
          <Metric
            label="Rust Crate"
            value={rust?.crateName ?? '--'}
            detail={rust?.crateVersion}
          />
          <Metric
            label="Schema"
            value={
              rust?.schemaVersion !== undefined
                ? `v${rust.schemaVersion}`
                : '--'
            }
          />
          <Metric
            label="Features"
            value={formatNumber(rust?.features?.length ?? null)}
            detail={rust?.features?.slice(0, 2).join(', ')}
          />
        </div>

        <div className="mt-4 grid grid-cols-1 lg:grid-cols-3 gap-3">
          <QueuePanel
            icon={<Activity className="h-3.5 w-3.5" />}
            title="Outbox"
            stats={diagnostics.outboxStats}
            fields={['pending', 'sending', 'failed', 'acked']}
          />
          <QueuePanel
            icon={<Database className="h-3.5 w-3.5" />}
            title="Conflicts"
            stats={diagnostics.conflictStats}
            fields={['unresolved', 'resolved', 'total']}
          />
          {hasBlobUploadQueue || !hasCloudflareRuntimeSummary ? (
            <QueuePanel
              icon={<Database className="h-3.5 w-3.5" />}
              title="Blob Uploads"
              stats={diagnostics.blobUploadStats}
              fields={['pending', 'uploading', 'failed']}
            />
          ) : null}
        </div>
      </PanelShell>

      <PanelShell
        title="Transport And Bootstrap"
        description="Rust-side request, artifact, chunk, and apply timing counters."
      >
        <div className="grid grid-cols-2 gap-3">
          <Metric
            label="Progress"
            value={
              numberField(bootstrap, 'progressPercent') !== null
                ? `${numberField(bootstrap, 'progressPercent')}%`
                : '--'
            }
            detail={
              stringField(bootstrap, 'complete', 'false') === 'true'
                ? 'complete'
                : undefined
            }
          />
          <Metric
            label="Requests"
            value={formatNumber(numberField(transport, 'requestCount'))}
          />
          <Metric
            label="Request Bytes"
            value={formatBytes(numberField(transport, 'requestBytes'))}
          />
          <Metric
            label="Response Bytes"
            value={formatBytes(numberField(transport, 'responseBytes'))}
          />
          <Metric
            label="Artifacts"
            value={formatNumber(
              numberField(transport, 'snapshotArtifactCount')
            )}
            detail={formatBytes(
              numberField(transport, 'snapshotArtifactBytes')
            )}
          />
          <Metric
            label="Chunks"
            value={formatNumber(numberField(transport, 'snapshotChunkCount'))}
            detail={`${formatNumber(numberField(transport, 'snapshotChunkRowCount'))} rows`}
          />
          <Metric
            label="Last Sync"
            value={formatDurationMs(numberField(latestTiming, 'totalMs'))}
            detail={`apply ${formatDurationMs(numberField(latestTiming, 'pullApplyMs'))}`}
          />
          <Metric
            label="Artifact Apply"
            value={formatDurationMs(
              numberField(latestTiming, 'snapshotArtifactApplyMs')
            )}
            detail={`${formatNumber(numberField(latestTiming, 'snapshotArtifactCheckpointCount'))} checkpoints`}
          />
        </div>

        {hasBrowserAssetSummary ? (
          <div className="mt-4">
            <p className="font-mono text-[10px] text-neutral-500 uppercase tracking-wide">
              Browser Preview Assets
            </p>
            <div className="mt-2 grid grid-cols-2 gap-3">
              <Metric
                label="Assets"
                value={formatNumber(numberField(transport, 'assetCount'))}
                detail={`${formatNumber(numberField(transport, 'jsAssetCount'))} js / ${formatNumber(numberField(transport, 'cssAssetCount'))} css`}
              />
              <Metric
                label="Asset Bytes"
                value={formatBytes(numberField(transport, 'totalAssetBytes'))}
                detail={`${formatBytes(numberField(transport, 'jsAssetBytes'))} js`}
              />
              <Metric
                label="Preflight Marker"
                value={stringField(
                  transport,
                  'deploymentPreflightMarkerInAssets'
                )}
                detail={`support ${stringField(transport, 'browserSupportPolicyMarkerInAssets')}`}
              />
              <Metric
                label="Runtime Markers"
                value={`timeline ${stringField(transport, 'starterTimelineMarkerInAssets')}`}
                detail={`bundle ${stringField(transport, 'supportBundleMarkerInAssets')}`}
              />
            </div>
          </div>
        ) : null}

        {hasBrowserSupportPolicySummary ? (
          <div className="mt-4">
            <p className="font-mono text-[10px] text-neutral-500 uppercase tracking-wide">
              Browser Support Policy
            </p>
            <div className="mt-2 grid grid-cols-2 gap-3">
              <Metric
                label="Policy"
                value={stringField(transport, 'browserSupportPolicyStatus')}
                detail={stringField(transport, 'browserSupportPolicy')}
                intent={
                  stringField(transport, 'browserSupportPolicyStatus') !== 'met'
                }
              />
              <Metric
                label="Context"
                value={stringField(transport, 'browserSupportPolicyContext')}
                detail={`preflight ${stringField(transport, 'browserSupportPolicyPreflightRequired')}`}
              />
              <Metric
                label="Support Tier"
                value={stringField(
                  transport,
                  'browserSupportPolicyObservedSupportTier'
                )}
                detail={`expected ${stringField(transport, 'browserSupportPolicyExpectedSupportTier')}`}
              />
              <Metric
                label="Persistence"
                value={stringField(
                  transport,
                  'browserSupportPolicyObservedPersistence'
                )}
                detail={`expected ${stringField(transport, 'browserSupportPolicyExpectedPersistence')}`}
                intent={
                  stringField(
                    transport,
                    'browserSupportPolicyObservedPersistence'
                  ) === 'memory'
                }
              />
              <Metric
                label="Reason"
                value={stringField(
                  transport,
                  'browserSupportPolicyFirstReason'
                )}
                detail={`${formatNumber(numberField(transport, 'browserSupportPolicyReasonCount'))} codes`}
              />
              <Metric
                label="Required Evidence"
                value={stringField(
                  transport,
                  'browserSupportPolicyFirstRequiredEvidence'
                )}
                detail={`${formatNumber(numberField(transport, 'browserSupportPolicyRequiredEvidenceCount'))} items`}
              />
              <Metric
                label="Known Risk"
                value={stringField(
                  transport,
                  'browserSupportPolicyFirstKnownRisk'
                )}
                detail={`${formatNumber(numberField(transport, 'browserSupportPolicyKnownRiskCount'))} items`}
              />
              <Metric
                label="Next Step"
                value={stringField(
                  transport,
                  'browserSupportPolicyFirstNextStep'
                )}
                detail={`${formatNumber(numberField(transport, 'browserSupportPolicyNextStepCount'))} items`}
              />
            </div>
          </div>
        ) : null}

        {hasBrowserDeploymentSummary ? (
          <div className="mt-4">
            <p className="font-mono text-[10px] text-neutral-500 uppercase tracking-wide">
              Browser Deployment Preflight
            </p>
            <div className="mt-2 grid grid-cols-2 gap-3">
              <Metric
                label="Preflight"
                value={stringField(transport, 'deploymentPreflightStatus')}
                detail={stringField(
                  transport,
                  'deploymentPreflightSupportTier'
                )}
                intent={
                  stringField(transport, 'deploymentPreflightStatus') !==
                  'ready'
                }
              />
              <Metric
                label="Persistence"
                value={stringField(transport, 'deploymentPreflightPersistence')}
                detail={`quota ${stringField(transport, 'deploymentPreflightQuotaPressure')}`}
                intent={
                  stringField(transport, 'deploymentPreflightPersistence') ===
                  'memory'
                }
              />
              <Metric
                label="Available"
                value={formatBytes(
                  numberField(transport, 'deploymentPreflightAvailableBytes')
                )}
                detail={`min ${formatBytes(numberField(transport, 'deploymentPreflightMinimumAvailableBytes'))}`}
              />
              <Metric
                label="Usage"
                value={formatPercent(
                  numberField(transport, 'deploymentPreflightUsageRatio')
                )}
                detail={`${formatBytes(numberField(transport, 'deploymentPreflightUsageBytes'))} / ${formatBytes(numberField(transport, 'deploymentPreflightQuotaBytes'))}`}
              />
              <Metric
                label="Service Worker"
                value={`controlled ${stringField(transport, 'serviceWorkerControlled')}`}
                detail={`state ${stringField(transport, 'serviceWorkerControllerState')}`}
                intent={
                  stringField(transport, 'serviceWorkerControlled') === 'false'
                }
              />
              <Metric
                label="Controller"
                value={stringField(
                  transport,
                  'serviceWorkerControllerScriptPath'
                )}
                detail={`available ${stringField(transport, 'serviceWorker')}`}
              />
            </div>
          </div>
        ) : null}

        {hasBrowserLifecycleSummary ? (
          <div className="mt-4">
            <p className="font-mono text-[10px] text-neutral-500 uppercase tracking-wide">
              Browser Lifecycle
            </p>
            <div className="mt-2 grid grid-cols-2 gap-3">
              <Metric
                label="Resume"
                value={stringField(latestTiming, 'lifecycleResumeStatus')}
                detail={`${stringField(latestTiming, 'lifecycleResumeReason')} / ${formatNumber(numberField(latestTiming, 'lifecycleResumeCount'))}x`}
                intent={
                  stringField(latestTiming, 'lifecycleResumeStatus') === 'error'
                }
              />
              <Metric
                label="Resume Lock"
                value={stringField(latestTiming, 'lifecycleResumeLockState')}
                detail={`${stringField(latestTiming, 'lifecycleResumeLockRequired')} required / ${formatDurationMs(numberField(latestTiming, 'lifecycleResumeLockTimeoutMs'))}`}
                intent={
                  stringField(latestTiming, 'lifecycleResumeLockState') ===
                  'timed-out'
                }
              />
              <Metric
                label="Pause"
                value={stringField(latestTiming, 'lifecyclePauseReason')}
                detail={`${stringField(latestTiming, 'lifecyclePauseVisibilityState')} / ${formatNumber(numberField(latestTiming, 'lifecyclePauseCount'))}x`}
              />
              <Metric
                label="Shutdown"
                value={formatNumber(
                  numberField(latestTiming, 'lifecycleShutdownSignalCount')
                )}
                detail={stringField(latestTiming, 'lifecycleResumeLockName')}
              />
            </div>
          </div>
        ) : null}

        {hasCloudflareRuntimeSummary ? (
          <div className="mt-4">
            <p className="font-mono text-[10px] text-neutral-500 uppercase tracking-wide">
              Cloudflare Runtime
            </p>
            <div className="mt-2 grid grid-cols-2 gap-3">
              <Metric
                label="Route"
                value={stringField(transport, 'route')}
                detail={`port ${stringField(transport, 'port')}`}
              />
              <Metric
                label="Sync Route"
                value={stringField(transport, 'syncRouteBase')}
                detail={`ws ${stringField(transport, 'webSocketRoute')}`}
              />
              <Metric
                label="Blob Route"
                value={stringField(transport, 'blobRouteBase')}
                detail={`r2 ${stringField(transport, 'blobMetricsAttempted')}`}
              />
              <Metric
                label="Exit"
                value={`code ${stringField(bootstrap, 'exitCode')}`}
                detail={`signal ${stringField(bootstrap, 'exitSignal')}`}
                intent={
                  numberField(bootstrap, 'exitCode') !== null &&
                  numberField(bootstrap, 'exitCode') !== 0
                }
              />
              <Metric
                label="Output Excerpt"
                value={formatNumber(
                  numberField(transport, 'outputExcerptLength')
                )}
                detail="redacted chars"
              />
              <Metric
                label="Expected"
                value={stringField(bootstrap, 'expectedText')}
              />
            </div>
          </div>
        ) : null}

        {hasCloudflareBlobSummary ? (
          <div className="mt-4">
            <p className="font-mono text-[10px] text-neutral-500 uppercase tracking-wide">
              Cloudflare R2 Blob Smoke
            </p>
            <div className="mt-2 grid grid-cols-2 gap-3">
              <Metric
                label="Content"
                value={formatBytes(
                  numberField(transport, 'blobContentBytes') ??
                    numberField(cloudflareBlobMetrics, 'contentBytes')
                )}
                detail={`attempted ${stringField(cloudflareBlobMetrics, 'attempted', stringField(transport, 'blobMetricsAttempted'))}`}
              />
              <Metric
                label="Download Bytes"
                value={formatBytes(
                  numberField(transport, 'blobDownloadBytes') ??
                    numberField(cloudflareBlobMetrics, 'downloadBytes')
                )}
                detail={`partition ${formatBytes(numberField(transport, 'blobPartitionedDownloadBytes') ?? numberField(cloudflareBlobMetrics, 'partitionedDownloadBytes'))}`}
              />
              <Metric
                label="Upload"
                value={formatDurationMs(
                  numberField(cloudflareBlobMetrics, 'uploadInitMs')
                )}
                detail={`bytes ${formatDurationMs(numberField(cloudflareBlobMetrics, 'uploadBytesMs'))} / complete ${formatDurationMs(numberField(cloudflareBlobMetrics, 'completeUploadMs'))}`}
              />
              <Metric
                label="Owner Download"
                value={formatDurationMs(
                  numberField(cloudflareBlobMetrics, 'downloadUrlMs')
                )}
                detail={`bytes ${formatDurationMs(numberField(cloudflareBlobMetrics, 'downloadBytesMs'))}`}
              />
              <Metric
                label="Partition Download"
                value={formatDurationMs(
                  numberField(cloudflareBlobMetrics, 'partitionedDownloadUrlMs')
                )}
                detail={`bytes ${formatDurationMs(numberField(cloudflareBlobMetrics, 'partitionedDownloadBytesMs'))}`}
              />
              <Metric
                label="Blob Total"
                value={formatDurationMs(
                  numberField(cloudflareBlobMetrics, 'totalMs')
                )}
              />
            </div>
          </div>
        ) : null}
      </PanelShell>

      <PanelShell
        title="Subscriptions"
        description="Redacted subscription state from the Rust client snapshot."
      >
        {diagnostics.subscriptions.length === 0 ? (
          <EmptyState message="No subscriptions reported" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[160px]">Subscription</TableHead>
                <TableHead className="w-[100px]">Table</TableHead>
                <TableHead className="w-[80px]">Ready</TableHead>
                <TableHead className="w-[90px]">Cursor</TableHead>
                <TableHead className="flex-1">Scope Keys</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {diagnostics.subscriptions.map((subscription) => (
                <TableRow key={subscription.id}>
                  <TableCell className="w-[160px]">
                    <span className="font-mono text-[10px] text-neutral-300 truncate block">
                      {subscription.id}
                    </span>
                  </TableCell>
                  <TableCell className="w-[100px]">
                    <span className="font-mono text-[10px] text-neutral-400">
                      {subscription.table}
                    </span>
                  </TableCell>
                  <TableCell className="w-[80px]">
                    <Badge variant={subscription.ready ? 'healthy' : 'syncing'}>
                      {subscription.ready ? 'ready' : 'pending'}
                    </Badge>
                  </TableCell>
                  <TableCell className="w-[90px]">
                    <span className="font-mono text-[10px] text-neutral-400">
                      {subscription.cursor ?? '--'}
                    </span>
                  </TableCell>
                  <TableCell className="flex-1">
                    <span className="font-mono text-[10px] text-neutral-400">
                      {subscription.scopeKeys.join(', ') || '--'}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </PanelShell>

      <PanelShell
        title="Recent Runtime Diagnostics"
        description="Stable client diagnostic codes with sync-attempt correlation."
      >
        {recentDiagnostics.length === 0 ? (
          <EmptyState message="No runtime diagnostic events reported" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[150px]">When</TableHead>
                <TableHead className="w-[90px]">Level</TableHead>
                <TableHead className="w-[160px]">Code</TableHead>
                <TableHead className="flex-1">Message</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {recentDiagnostics.map((event, index) => (
                <TableRow key={`${event.at}:${event.code}:${index}`}>
                  <TableCell className="w-[150px]">
                    <span className="font-mono text-[10px] text-neutral-400">
                      {formatDateTime(new Date(event.at).toISOString())}
                    </span>
                  </TableCell>
                  <TableCell className="w-[90px]">
                    <Badge
                      variant={
                        event.level === 'error'
                          ? 'destructive'
                          : event.level === 'warn'
                            ? 'syncing'
                            : 'ghost'
                      }
                    >
                      {event.level}
                    </Badge>
                  </TableCell>
                  <TableCell className="w-[160px]">
                    <span className="font-mono text-[10px] text-flow break-all">
                      {event.code}
                    </span>
                    {event.syncAttemptId ? (
                      <div className="font-mono text-[9px] text-neutral-600 break-all">
                        {event.syncAttemptId}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell className="flex-1">
                    <span className="font-mono text-[10px] text-neutral-300">
                      {event.message}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </PanelShell>

      <PanelShell
        title="Snapshot History"
        description="Retained redacted Rust runtime snapshots for this client."
        actions={
          historyLoading ? (
            <span className="inline-flex items-center gap-1 font-mono text-[10px] text-neutral-500">
              <Spinner size="sm" />
              Loading
            </span>
          ) : null
        }
      >
        {history.length === 0 ? (
          <EmptyState message="No retained snapshots" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[170px]">Received</TableHead>
                <TableHead className="w-[90px]">Freshness</TableHead>
                <TableHead className="w-[90px]">Health</TableHead>
                <TableHead className="flex-1">Codes</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {history.map((snapshot) => (
                <TableRow key={`${snapshot.clientId}:${snapshot.receivedAt}`}>
                  <TableCell className="w-[170px]">
                    <span className="font-mono text-[10px] text-neutral-400">
                      {formatDateTime(snapshot.receivedAt)}
                    </span>
                  </TableCell>
                  <TableCell className="w-[90px]">
                    <Badge
                      variant={
                        snapshot.freshnessState === 'active'
                          ? 'healthy'
                          : snapshot.freshnessState === 'idle'
                            ? 'syncing'
                            : 'offline'
                      }
                    >
                      {snapshot.freshnessState}
                    </Badge>
                  </TableCell>
                  <TableCell className="w-[90px]">
                    {snapshot.healthMaxSeverity ? (
                      <Badge
                        variant={
                          snapshot.healthMaxSeverity === 'error'
                            ? 'destructive'
                            : snapshot.healthMaxSeverity === 'warn'
                              ? 'syncing'
                              : 'ghost'
                        }
                      >
                        {snapshot.healthMaxSeverity}
                      </Badge>
                    ) : (
                      <span className="font-mono text-[10px] text-neutral-600">
                        --
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="flex-1">
                    <span className="font-mono text-[10px] text-neutral-400">
                      {snapshot.diagnosticCodesSummary
                        .slice(0, 3)
                        .map((entry) => `${entry.code} x${entry.count}`)
                        .join(', ') || '--'}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </PanelShell>
    </div>
  );
}

function QueuePanel({
  fields,
  icon,
  stats,
  title,
}: {
  fields: string[];
  icon: import('react').ReactNode;
  stats: Record<string, unknown> | null;
  title: string;
}) {
  return (
    <div className="rounded-md border border-border bg-surface/40 px-3 py-2">
      <div className="flex items-center gap-2 font-mono text-[10px] text-neutral-300">
        {icon}
        <span>{title}</span>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        {fields.map((field) => (
          <div key={field}>
            <p className="font-mono text-[9px] text-neutral-600 uppercase">
              {field}
            </p>
            <p
              className={`font-mono text-[12px] ${
                field === 'failed' && (numberField(stats, field) ?? 0) > 0
                  ? 'text-offline'
                  : 'text-white'
              }`}
            >
              {formatNumber(numberField(stats, field))}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

function Metric({
  detail,
  intent = false,
  label,
  value,
}: {
  detail?: string;
  intent?: boolean;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-md border border-border bg-surface/40 px-3 py-2">
      <p className="font-mono text-[9px] text-neutral-500 uppercase tracking-wide">
        {label}
      </p>
      <p
        className={`mt-1 font-mono text-[12px] ${intent ? 'text-offline' : 'text-white'} truncate`}
        title={value}
      >
        {value}
      </p>
      {detail ? (
        <p className="mt-1 font-mono text-[9px] text-neutral-500 truncate">
          {detail}
        </p>
      ) : null}
    </div>
  );
}
