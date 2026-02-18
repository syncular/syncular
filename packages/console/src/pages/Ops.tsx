import type {
  AlertThresholds,
  HandlerEntry,
  MaintenanceStat,
} from '@syncular/ui';
import {
  Alert,
  AlertDescription,
  AlertsConfig,
  AlertTitle,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldDescription,
  FieldLabel,
  HandlersTable,
  Input,
  MaintenanceCard,
  SectionCard,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@syncular/ui';
import { type ReactNode, useState } from 'react';
import {
  useCompactMutation,
  useHandlers,
  useLocalStorage,
  useNotifyDataChangeMutation,
  useOperationEvents,
  usePartitionContext,
  usePruneMutation,
  usePrunePreview,
  useStats,
} from '../hooks';
import type {
  ConsoleNotifyDataChangeResponse,
  ConsoleOperationEvent,
  ConsoleOperationType,
} from '../lib/types';

interface AlertConfig {
  latencyThresholdMs: number;
  errorRateThreshold: number;
  clientLagThreshold: number;
  enabled: boolean;
}

const DEFAULT_ALERT_CONFIG: AlertConfig = {
  latencyThresholdMs: 1000,
  errorRateThreshold: 5,
  clientLagThreshold: 50,
  enabled: false,
};

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
  return `${Math.round(ms / 3600000)}h`;
}

function parseTableList(value: string): string[] {
  const parts = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return Array.from(new Set(parts));
}

function formatOperationTypeLabel(type: ConsoleOperationType): string {
  switch (type) {
    case 'notify_data_change':
      return 'Notify';
    case 'evict_client':
      return 'Evict';
    case 'compact':
      return 'Compact';
    default:
      return 'Prune';
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function summarizeOperation(event: ConsoleOperationEvent): string {
  const request = asObject(event.requestPayload);
  const result = asObject(event.resultPayload);

  if (event.operationType === 'notify_data_change') {
    const tables = asStringArray(request?.tables);
    const commitSeq = result?.commitSeq;
    return `${tables.length} table${tables.length === 1 ? '' : 's'} -> commit #${typeof commitSeq === 'number' ? commitSeq : '?'}`;
  }

  if (event.operationType === 'evict_client') {
    const evicted = result?.evicted === true ? 'evicted' : 'not found';
    return `client ${event.targetClientId ?? '?'} ${evicted}`;
  }

  if (event.operationType === 'compact') {
    const deletedChanges =
      typeof result?.deletedChanges === 'number' ? result.deletedChanges : 0;
    return `${deletedChanges} changes removed`;
  }

  const deletedCommits =
    typeof result?.deletedCommits === 'number' ? result.deletedCommits : 0;
  const watermark =
    typeof request?.watermarkCommitSeq === 'number'
      ? ` at #${request.watermarkCommitSeq}`
      : '';
  return `${deletedCommits} commits removed${watermark}`;
}

function formatDateTime(iso: string): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return iso;
  return new Date(parsed).toLocaleString();
}

export function Ops() {
  const { partitionId } = usePartitionContext();

  return (
    <div className="flex flex-col gap-4 px-5 py-5">
      <div className="grid gap-4 lg:grid-cols-2">
        <HandlersView />
        <AlertsView />
      </div>
      <div className="grid gap-4 xl:grid-cols-3">
        <PruneView partitionId={partitionId} />
        <CompactView partitionId={partitionId} />
        <NotifyDataChangeView partitionId={partitionId} />
      </div>
      <OperationsAuditView partitionId={partitionId} />
    </div>
  );
}

function HandlersView() {
  const { data, isLoading, error } = useHandlers();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-[200px]">
        <Spinner size="lg" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-[200px]">
        <p className="text-danger">Failed to load handlers: {error.message}</p>
      </div>
    );
  }

  const mapped: HandlerEntry[] = (data?.items ?? []).map((h) => ({
    table: h.table,
    dependsOn: h.dependsOn?.join(', ') ?? null,
    chunkTtl: h.snapshotChunkTtlMs
      ? formatDuration(h.snapshotChunkTtlMs)
      : 'default',
  }));

  return (
    <HandlersTable handlers={mapped} tableCount={data?.items.length ?? 0} />
  );
}

function PruneView({ partitionId }: { partitionId?: string }) {
  const [modalOpen, setModalOpen] = useState(false);
  const [lastResult, setLastResult] = useState<number | null>(null);

  const { data: stats, isLoading: statsLoading } = useStats({ partitionId });
  const {
    data: prunePreview,
    isLoading: previewLoading,
    refetch: refetchPreview,
  } = usePrunePreview({ enabled: false });

  const pruneMutation = usePruneMutation();

  const handleOpenModal = async () => {
    setModalOpen(true);
    setLastResult(null);
    await refetchPreview();
  };

  const handlePrune = async () => {
    const result = await pruneMutation.mutateAsync();
    setLastResult(result.deletedCommits);
  };

  if (statsLoading) {
    return (
      <div className="flex items-center justify-center h-[200px]">
        <Spinner size="lg" />
      </div>
    );
  }

  const pruneStats: {
    label: string;
    value: ReactNode;
    tone?: 'default' | 'syncing';
  }[] = [
    { label: 'Total commits', value: stats?.commitCount ?? 0 },
    {
      label: 'Commit range',
      value: `${stats?.minCommitSeq ?? 0} - ${stats?.maxCommitSeq ?? 0}`,
    },
    {
      label: 'Min active cursor',
      value: stats?.minActiveClientCursor ?? 'N/A',
      tone: 'syncing',
    },
  ];

  return (
    <>
      <MaintenanceCard
        title="Prune"
        description="Delete commits that all clients have already synced. Pruning removes commits older than the oldest active client cursor."
        dotColor="syncing"
        stats={pruneStats}
        actionLabel="Preview Prune"
        actionVariant="destructive"
        onAction={handleOpenModal}
      />

      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Prune Old Commits</DialogTitle>
          </DialogHeader>

          <div className="px-5 py-4 flex flex-col gap-4">
            {lastResult !== null ? (
              <Alert variant="default">
                <AlertTitle>Pruning Complete</AlertTitle>
                <AlertDescription>
                  Successfully deleted <strong>{lastResult}</strong> commits.
                </AlertDescription>
              </Alert>
            ) : previewLoading ? (
              <div className="flex items-center justify-center py-8">
                <Spinner size="sm" />
              </div>
            ) : prunePreview ? (
              <>
                <Alert
                  variant={
                    prunePreview.commitsToDelete > 0 ? 'destructive' : 'default'
                  }
                >
                  <AlertDescription>
                    {prunePreview.commitsToDelete > 0 ? (
                      <>
                        This will delete{' '}
                        <strong>{prunePreview.commitsToDelete}</strong> commits
                        up to sequence{' '}
                        <code className="font-mono">
                          #{prunePreview.watermarkCommitSeq}
                        </code>
                        .
                      </>
                    ) : (
                      'No commits are eligible for pruning.'
                    )}
                  </AlertDescription>
                </Alert>

                <div className="flex flex-col gap-2">
                  <div className="flex justify-between font-mono text-[11px]">
                    <span className="text-neutral-500">
                      Watermark commit seq:
                    </span>
                    <span className="text-white">
                      #{prunePreview.watermarkCommitSeq}
                    </span>
                  </div>
                  <div className="flex justify-between font-mono text-[11px] items-center">
                    <span className="text-neutral-500">Commits to delete:</span>
                    <Badge
                      variant={
                        prunePreview.commitsToDelete > 0 ? 'offline' : 'ghost'
                      }
                    >
                      {prunePreview.commitsToDelete}
                    </Badge>
                  </div>
                </div>
              </>
            ) : null}
          </div>

          <DialogFooter>
            <Button variant="default" onClick={() => setModalOpen(false)}>
              {lastResult !== null ? 'Close' : 'Cancel'}
            </Button>
            {lastResult === null && (
              <Button
                variant="destructive"
                onClick={handlePrune}
                disabled={
                  pruneMutation.isPending ||
                  previewLoading ||
                  (prunePreview?.commitsToDelete ?? 0) === 0
                }
              >
                {pruneMutation.isPending ? (
                  <>
                    <Spinner size="sm" />
                    Pruning...
                  </>
                ) : (
                  'Prune Now'
                )}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function CompactView({ partitionId }: { partitionId?: string }) {
  const [modalOpen, setModalOpen] = useState(false);
  const [lastResult, setLastResult] = useState<number | null>(null);

  const { data: stats, isLoading: statsLoading } = useStats({ partitionId });
  const compactMutation = useCompactMutation();

  const handleOpenModal = () => {
    setModalOpen(true);
    setLastResult(null);
  };

  const handleCompact = async () => {
    const result = await compactMutation.mutateAsync();
    setLastResult(result.deletedChanges);
  };

  if (statsLoading) {
    return (
      <div className="flex items-center justify-center h-[200px]">
        <Spinner size="lg" />
      </div>
    );
  }

  const compactStats: {
    label: string;
    value: ReactNode;
    tone?: 'default' | 'syncing';
  }[] = [
    { label: 'Total changes', value: stats?.changeCount ?? 0 },
    { label: 'Total commits', value: stats?.commitCount ?? 0 },
  ];

  return (
    <>
      <MaintenanceCard
        title="Compact"
        description="Merge old changes to reduce storage space. Compaction merges multiple changes to the same row into a single change."
        dotColor="flow"
        stats={compactStats}
        actionLabel="Run Compaction"
        actionVariant="primary"
        onAction={handleOpenModal}
      />

      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Compact Changes</DialogTitle>
          </DialogHeader>

          <div className="px-5 py-4 flex flex-col gap-4">
            {lastResult !== null ? (
              <Alert variant="default">
                <AlertTitle>Compaction Complete</AlertTitle>
                <AlertDescription>
                  Successfully removed <strong>{lastResult}</strong> redundant
                  changes.
                </AlertDescription>
              </Alert>
            ) : (
              <Alert variant="default">
                <AlertDescription>
                  Compaction will merge multiple changes to the same row,
                  keeping only the most recent version. This is safe and can be
                  run at any time.
                </AlertDescription>
              </Alert>
            )}
          </div>

          <DialogFooter>
            <Button variant="default" onClick={() => setModalOpen(false)}>
              {lastResult !== null ? 'Close' : 'Cancel'}
            </Button>
            {lastResult === null && (
              <Button
                variant="primary"
                onClick={handleCompact}
                disabled={compactMutation.isPending}
              >
                {compactMutation.isPending ? (
                  <>
                    <Spinner size="sm" />
                    Compacting...
                  </>
                ) : (
                  'Compact Now'
                )}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function NotifyDataChangeView({ partitionId }: { partitionId?: string }) {
  const [modalOpen, setModalOpen] = useState(false);
  const [tablesInput, setTablesInput] = useState('tasks');
  const [partitionIdInput, setPartitionIdInput] = useState(partitionId ?? '');
  const [lastResult, setLastResult] =
    useState<ConsoleNotifyDataChangeResponse | null>(null);
  const [validationMessage, setValidationMessage] = useState<string | null>(
    null
  );
  const notifyMutation = useNotifyDataChangeMutation();

  const tables = parseTableList(tablesInput);
  const notifyStats: MaintenanceStat[] = [
    {
      label: 'Next tables',
      value: tables.length,
      tone: 'syncing',
    },
    {
      label: 'Last commit seq',
      value: lastResult ? `#${lastResult.commitSeq}` : '—',
      tone: 'syncing',
    },
    {
      label: 'Last chunks cleared',
      value: lastResult?.deletedChunks ?? '—',
    },
  ];

  const handleOpenModal = () => {
    setModalOpen(true);
    setValidationMessage(null);
  };

  const handleNotify = async () => {
    if (tables.length === 0) {
      setValidationMessage('Provide at least one table name.');
      return;
    }

    setValidationMessage(null);
    const result = await notifyMutation.mutateAsync({
      tables,
      partitionId: partitionIdInput.trim() || undefined,
    });
    setLastResult(result);
  };

  return (
    <>
      <MaintenanceCard
        title="Notify Data Change"
        description="Create a synthetic commit after external imports or direct DB writes so clients re-bootstrap for affected tables."
        dotColor="healthy"
        stats={notifyStats}
        actionLabel="Notify Clients"
        actionVariant="primary"
        onAction={handleOpenModal}
      />

      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Notify External Data Change</DialogTitle>
          </DialogHeader>

          <div className="flex flex-col gap-4 px-5 py-4">
            {lastResult ? (
              <Alert variant="default">
                <AlertTitle>Notification Sent</AlertTitle>
                <AlertDescription>
                  Created synthetic commit{' '}
                  <strong>#{lastResult.commitSeq}</strong> for{' '}
                  <strong>{lastResult.tables.length}</strong> table
                  {lastResult.tables.length === 1 ? '' : 's'} and cleared{' '}
                  <strong>{lastResult.deletedChunks}</strong> cached chunk
                  {lastResult.deletedChunks === 1 ? '' : 's'}.
                </AlertDescription>
              </Alert>
            ) : (
              <Alert variant="default">
                <AlertDescription>
                  Use this when data changed outside Syncular push flow. It
                  invalidates cached snapshot chunks and forces clients to pull
                  fresh data.
                </AlertDescription>
              </Alert>
            )}

            {validationMessage ? (
              <Alert variant="destructive">
                <AlertDescription>{validationMessage}</AlertDescription>
              </Alert>
            ) : null}

            <Field>
              <FieldLabel>Tables (comma-separated)</FieldLabel>
              <Input
                value={tablesInput}
                onChange={(event) => setTablesInput(event.target.value)}
                placeholder="tasks, notes"
                disabled={notifyMutation.isPending}
              />
              <FieldDescription>
                Enter one or more table names affected by the external change.
              </FieldDescription>
            </Field>

            <Field>
              <FieldLabel>Partition ID (optional)</FieldLabel>
              <Input
                value={partitionIdInput}
                onChange={(event) => setPartitionIdInput(event.target.value)}
                placeholder="default"
                disabled={notifyMutation.isPending}
              />
            </Field>
          </div>

          <DialogFooter>
            <Button variant="default" onClick={() => setModalOpen(false)}>
              {lastResult ? 'Close' : 'Cancel'}
            </Button>
            {!lastResult ? (
              <Button
                variant="primary"
                onClick={handleNotify}
                disabled={notifyMutation.isPending}
              >
                {notifyMutation.isPending ? (
                  <>
                    <Spinner size="sm" />
                    Notifying...
                  </>
                ) : (
                  'Notify Data Change'
                )}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function OperationsAuditView({ partitionId }: { partitionId?: string }) {
  const [operationTypeFilter, setOperationTypeFilter] = useState<
    ConsoleOperationType | 'all'
  >('all');

  const { data, isLoading, error } = useOperationEvents(
    {
      limit: 20,
      offset: 0,
      operationType:
        operationTypeFilter === 'all' ? undefined : operationTypeFilter,
      partitionId,
    },
    { refetchIntervalMs: 5000 }
  );

  return (
    <SectionCard
      title="Operation Audit"
      description="Recent prune/compact/notify/evict actions with actor and result context."
      actions={
        <div className="flex items-center gap-2">
          <Button
            variant={operationTypeFilter === 'all' ? 'default' : 'ghost'}
            size="sm"
            onClick={() => setOperationTypeFilter('all')}
          >
            All
          </Button>
          <Button
            variant={operationTypeFilter === 'prune' ? 'default' : 'ghost'}
            size="sm"
            onClick={() => setOperationTypeFilter('prune')}
          >
            Prune
          </Button>
          <Button
            variant={operationTypeFilter === 'compact' ? 'default' : 'ghost'}
            size="sm"
            onClick={() => setOperationTypeFilter('compact')}
          >
            Compact
          </Button>
          <Button
            variant={
              operationTypeFilter === 'notify_data_change' ? 'default' : 'ghost'
            }
            size="sm"
            onClick={() => setOperationTypeFilter('notify_data_change')}
          >
            Notify
          </Button>
          <Button
            variant={
              operationTypeFilter === 'evict_client' ? 'default' : 'ghost'
            }
            size="sm"
            onClick={() => setOperationTypeFilter('evict_client')}
          >
            Evict
          </Button>
        </div>
      }
      contentClassName="pt-2"
    >
      {isLoading ? (
        <div className="flex items-center justify-center py-10">
          <Spinner size="lg" />
        </div>
      ) : error ? (
        <Alert variant="destructive">
          <AlertDescription>
            Failed to load operation audit events: {error.message}
          </AlertDescription>
        </Alert>
      ) : (data?.items.length ?? 0) === 0 ? (
        <div className="px-2 py-8 text-sm text-neutral-500">
          No operation events found for this filter.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>User</TableHead>
                <TableHead>Target</TableHead>
                <TableHead>Result</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data?.items ?? []).map((event, index) => (
                <TableRow
                  key={`${event.operationId}:${event.createdAt}:${index}`}
                >
                  <TableCell className="whitespace-nowrap text-xs text-neutral-400">
                    {formatDateTime(event.createdAt)}
                  </TableCell>
                  <TableCell>
                    <Badge variant="ghost">
                      {formatOperationTypeLabel(event.operationType)}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {event.consoleUserId ?? 'system'}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {event.targetClientId ??
                      event.partitionId ??
                      (event.operationType === 'notify_data_change'
                        ? 'partition default'
                        : 'global')}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-neutral-300">
                    {summarizeOperation(event)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </SectionCard>
  );
}

function AlertsView() {
  const [config, setConfig] = useLocalStorage<AlertConfig>(
    'console:alert-config',
    DEFAULT_ALERT_CONFIG
  );

  const thresholds: AlertThresholds = {
    p90Latency: config.latencyThresholdMs,
    errorRate: config.errorRateThreshold,
    clientLag: config.clientLagThreshold,
  };

  const handleThresholdsChange = (next: AlertThresholds) => {
    setConfig((prev) => ({
      ...prev,
      latencyThresholdMs: next.p90Latency,
      errorRateThreshold: next.errorRate,
      clientLagThreshold: next.clientLag,
    }));
  };

  const handleEnabledChange = (enabled: boolean) => {
    setConfig((prev) => ({ ...prev, enabled }));
  };

  return (
    <AlertsConfig
      enabled={config.enabled}
      onEnabledChange={handleEnabledChange}
      thresholds={thresholds}
      onThresholdsChange={handleThresholdsChange}
    />
  );
}
