import type { AlertThresholds, HandlerEntry } from '@syncular/ui';
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
  HandlersTable,
  MaintenanceCard,
  Spinner,
} from '@syncular/ui';
import { type ReactNode, useState } from 'react';
import {
  useCompactMutation,
  useHandlers,
  useLocalStorage,
  usePruneMutation,
  usePrunePreview,
  useStats,
} from '../hooks';

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

export function Ops() {
  return (
    <div className="flex flex-col gap-4 px-5 py-5">
      <div className="grid grid-cols-2 gap-4">
        <HandlersView />
        <AlertsView />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <PruneView />
        <CompactView />
      </div>
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

function PruneView() {
  const [modalOpen, setModalOpen] = useState(false);
  const [lastResult, setLastResult] = useState<number | null>(null);

  const { data: stats, isLoading: statsLoading } = useStats();
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

function CompactView() {
  const [modalOpen, setModalOpen] = useState(false);
  const [lastResult, setLastResult] = useState<number | null>(null);

  const { data: stats, isLoading: statsLoading } = useStats();
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
