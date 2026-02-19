import type { SyncClientNode } from '@syncular/ui';
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  FleetTable,
  Pagination,
  PanelShell,
  Spinner,
  SyncHorizon,
} from '@syncular/ui';
import { useEffect, useState } from 'react';
import {
  useClients,
  useEvictClientMutation,
  usePartitionContext,
  usePreferences,
  useStats,
} from '../hooks';

function inferClientType(clientId: string): string {
  const lower = clientId.toLowerCase();
  if (
    lower.includes('mobile') ||
    lower.includes('ios') ||
    lower.includes('android')
  )
    return 'mobile';
  if (lower.includes('tablet')) return 'tablet';
  if (lower.includes('desktop') || lower.includes('laptop')) return 'desktop';
  if (lower.includes('edge')) return 'edge';
  if (lower.includes('iot')) return 'iot';
  return 'desktop';
}

function inferDialect(clientId: string): string {
  const lower = clientId.toLowerCase();
  if (lower.includes('pglite')) return 'PGlite';
  if (lower.includes('wa-sqlite') || lower.includes('sqlite')) return 'SQLite';
  if (lower.includes('postgres') || lower.includes('pg')) return 'PostgreSQL';
  return 'unknown';
}

function formatTime(isoString: string, timeFormat: 'relative' | 'absolute') {
  if (timeFormat === 'absolute') {
    return new Date(isoString).toLocaleString();
  }

  try {
    const date = new Date(isoString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffSecs = Math.floor(diffMs / 1000);
    const diffMins = Math.floor(diffSecs / 60);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffSecs < 60) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    return `${diffDays}d ago`;
  } catch {
    return isoString;
  }
}

function mapToSyncNode(
  client: {
    clientId: string;
    cursor: number;
    actorId: string;
    connectionMode: 'polling' | 'realtime';
    activityState: 'active' | 'idle' | 'stale';
    effectiveScopes: Record<string, unknown>;
    updatedAt: string;
  },
  _headSeq: number,
  timeFormat: 'relative' | 'absolute'
): SyncClientNode {
  return {
    id: client.clientId,
    type: inferClientType(client.clientId),
    status:
      client.activityState === 'stale'
        ? 'offline'
        : client.activityState === 'idle'
          ? 'syncing'
          : 'online',
    cursor: client.cursor,
    actor: client.actorId,
    mode: client.connectionMode === 'realtime' ? 'realtime' : 'polling',
    dialect: inferDialect(client.clientId),
    scopes: Object.keys(client.effectiveScopes ?? {}),
    lastSeen: formatTime(client.updatedAt, timeFormat),
  };
}

export function Fleet({
  emptyState,
}: {
  emptyState?: import('react').ReactNode;
} = {}) {
  const [page, setPage] = useState(1);
  const [evictingClientId, setEvictingClientId] = useState<string | null>(null);
  const { preferences } = usePreferences();
  const { partitionId } = usePartitionContext();
  const pageSize = preferences.pageSize;
  const refreshIntervalMs = preferences.refreshInterval * 1000;

  const { data: stats, isLoading: statsLoading } = useStats({
    refetchIntervalMs: refreshIntervalMs,
    partitionId,
  });
  const { data, isLoading, error } = useClients(
    {
      limit: pageSize,
      offset: (page - 1) * pageSize,
      partitionId,
    },
    { refetchIntervalMs: refreshIntervalMs }
  );
  const evictMutation = useEvictClientMutation();

  const totalPages = Math.ceil((data?.total ?? 0) / pageSize);
  const headSeq = stats?.maxCommitSeq ?? 0;

  useEffect(() => {
    setPage(1);
  }, []);

  const handleEvict = async () => {
    if (!evictingClientId) return;
    try {
      await evictMutation.mutateAsync({
        clientId: evictingClientId,
        partitionId,
      });
    } finally {
      setEvictingClientId(null);
    }
  };

  if (isLoading || statsLoading) {
    return (
      <div className="flex items-center justify-center h-[200px]">
        <Spinner size="lg" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-[200px]">
        <p className="text-danger">Failed to load clients: {error.message}</p>
      </div>
    );
  }

  const syncNodes = (data?.items ?? []).map((c) =>
    mapToSyncNode(c, headSeq, preferences.timeFormat)
  );

  return (
    <div className="flex flex-col gap-5 px-5 py-5">
      {syncNodes.length > 0 && (
        <SyncHorizon clients={syncNodes} headSeq={headSeq} />
      )}

      {syncNodes.length === 0 ? (
        (emptyState ?? (
          <PanelShell>
            <EmptyState message="No clients yet" />
          </PanelShell>
        ))
      ) : (
        <FleetTable
          clients={syncNodes}
          headSeq={headSeq}
          onEvict={(clientId) => {
            const item = data?.items.find((c) => c.clientId === clientId);
            setEvictingClientId(item?.clientId ?? clientId);
          }}
        />
      )}

      {totalPages > 1 && (
        <Pagination
          page={page}
          totalPages={totalPages}
          totalItems={data?.total ?? 0}
          onPageChange={setPage}
        />
      )}

      <Dialog
        open={evictingClientId !== null}
        onOpenChange={() => setEvictingClientId(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Evict Client</DialogTitle>
          </DialogHeader>

          <div className="px-5 py-4 flex flex-col gap-4">
            <p className="font-mono text-[11px] text-neutral-300">
              Are you sure you want to evict client{' '}
              <span className="font-mono text-white">
                {evictingClientId?.slice(0, 12)}...
              </span>
              ?
            </p>
            <p className="font-mono text-[10px] text-neutral-500">
              This will force the client to re-bootstrap on their next sync.
            </p>
          </div>

          <DialogFooter>
            <Button variant="default" onClick={() => setEvictingClientId(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleEvict}
              disabled={evictMutation.isPending}
            >
              {evictMutation.isPending ? (
                <>
                  <Spinner size="sm" />
                  Evicting...
                </>
              ) : (
                'Evict'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
