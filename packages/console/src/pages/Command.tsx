import type {
  ActivityBarData,
  ActivityTimeRange,
  FeedEntry,
  LatencyBucket,
  MetricItem,
} from '@syncular/ui';
import {
  ActivityBars,
  Alert,
  AlertDescription,
  AlertTitle,
  CommitTable,
  KpiStrip,
  LatencyPercentilesBar,
  LiveActivityFeed,
  Spinner,
  TopologyHero,
} from '@syncular/ui';
import { useNavigate } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import {
  TimeRangeContext,
  useClients,
  useCommits,
  useLatencyStats,
  useLiveEvents,
  useLocalStorage,
  usePartitionContext,
  usePreferences,
  useStats,
  useTimeRangeState,
  useTimeseriesStats,
} from '../hooks';
import { adaptConsoleClientsToTopology } from '../lib/topology';

interface AlertConfig {
  enabled: boolean;
  thresholds: {
    p90Latency: number;
    errorRate: number;
    clientLag: number;
  };
}

const DEFAULT_ALERT_CONFIG: AlertConfig = {
  enabled: false,
  thresholds: {
    p90Latency: 500,
    errorRate: 5,
    clientLag: 100,
  },
};

function formatTime(
  iso: string,
  timeFormat: 'relative' | 'absolute' = 'relative'
): string {
  if (timeFormat === 'absolute') {
    return new Date(iso).toLocaleString();
  }

  const date = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffS = Math.floor(diffMs / 1000);

  if (diffS < 60) return `${diffS}s ago`;
  if (diffS < 3600) return `${Math.floor(diffS / 60)}m ago`;
  if (diffS < 86400) return `${Math.floor(diffS / 3600)}h ago`;
  return `${Math.floor(diffS / 86400)}d ago`;
}

function resolveStreamHref(pathname: string): string {
  const normalized =
    pathname.length > 1 && pathname.endsWith('/')
      ? pathname.slice(0, -1)
      : pathname;
  return normalized === '/console' || normalized.startsWith('/console/')
    ? '/console/stream'
    : '/stream';
}

function CommandInner() {
  const navigate = useNavigate();
  const streamHref = useMemo(() => {
    if (typeof window === 'undefined') return '/stream';
    return resolveStreamHref(window.location.pathname);
  }, []);
  const timeRangeState = useTimeRangeState();
  const { range } = timeRangeState;
  const { preferences } = usePreferences();
  const { partitionId } = usePartitionContext();
  const refreshIntervalMs = preferences.refreshInterval * 1000;

  const [alertConfig] = useLocalStorage<AlertConfig>(
    'console:alert-config',
    DEFAULT_ALERT_CONFIG
  );

  const [activityRange, setActivityRange] = useState<ActivityTimeRange>('1h');

  const { data: stats } = useStats({
    refetchIntervalMs: refreshIntervalMs,
    partitionId,
  });
  const { data: timeseriesData } = useTimeseriesStats(
    { range, partitionId },
    { refetchIntervalMs: refreshIntervalMs }
  );
  const { data: latencyData } = useLatencyStats(
    { range, partitionId },
    { refetchIntervalMs: refreshIntervalMs }
  );
  const { data: commitsData } = useCommits(
    { limit: 5, partitionId },
    { refetchIntervalMs: refreshIntervalMs }
  );
  const { data: clientsData } = useClients(
    { limit: 12, offset: 0, partitionId },
    { refetchIntervalMs: refreshIntervalMs }
  );
  const { events, isConnected } = useLiveEvents({
    maxEvents: 8,
    partitionId,
  });

  const eventSummary = useMemo(() => {
    const buckets = timeseriesData?.buckets ?? [];

    let totalEvents = 0;
    let totalErrors = 0;

    for (const bucket of buckets) {
      totalEvents += bucket.pushCount + bucket.pullCount;
      totalErrors += bucket.errorCount;
    }

    const errorRate = totalEvents > 0 ? (totalErrors / totalEvents) * 100 : 0;

    return {
      totalEvents,
      errorRate,
    };
  }, [timeseriesData?.buckets]);

  const topologyNodes = useMemo(() => {
    if (!clientsData?.items) return [];
    return adaptConsoleClientsToTopology(clientsData.items, stats, {
      maxNodes: 12,
    });
  }, [clientsData?.items, stats]);

  const onlineCount = topologyNodes.filter(
    (c) => c.status !== 'offline'
  ).length;
  const offlineCount = topologyNodes.filter(
    (c) => c.status === 'offline'
  ).length;

  const kpiItems = useMemo((): MetricItem[] => {
    if (!stats) return [];
    return [
      {
        label: 'Ops (Range)',
        value: eventSummary.totalEvents,
        color: 'flow',
      },
      {
        label: 'P50 Latency',
        value: latencyData?.push?.p50 ?? 0,
        unit: 'ms',
        color: 'healthy',
      },
      {
        label: 'Error Rate',
        value: `${eventSummary.errorRate.toFixed(1)}%`,
        color: eventSummary.errorRate > 0 ? 'offline' : 'muted',
      },
      {
        label: 'Active Clients',
        value: stats.activeClientCount,
        color: 'syncing',
      },
      {
        label: 'Pending',
        value:
          stats.maxActiveClientCursor !== null && stats.maxCommitSeq > 0
            ? stats.maxCommitSeq - (stats.minActiveClientCursor ?? 0)
            : 0,
        color: 'relay',
      },
    ];
  }, [stats, latencyData, eventSummary.errorRate, eventSummary.totalEvents]);

  const feedEntries = useMemo(
    (): FeedEntry[] =>
      events.map((e) => ({
        type: e.type.toUpperCase(),
        actor: (e.data?.actorId as string) ?? '',
        table: ((e.data?.tables as string[]) ?? [])[0] ?? '',
        time: formatTime(e.timestamp, preferences.timeFormat),
      })),
    [events, preferences.timeFormat]
  );

  const activityBars = useMemo((): ActivityBarData[] => {
    const buckets = timeseriesData?.buckets;
    if (!buckets?.length) return [];
    const maxVal = Math.max(
      ...buckets.map((b) => Math.max(b.pushCount, b.pullCount)),
      1
    );
    return buckets.map((b) => ({
      pushPercent: maxVal > 0 ? (b.pushCount / maxVal) * 100 : 0,
      pullPercent: maxVal > 0 ? (b.pullCount / maxVal) * 100 : 0,
    }));
  }, [timeseriesData?.buckets]);

  const latencyBuckets = useMemo((): LatencyBucket[] => {
    if (!latencyData) return [];
    const maxMs = Math.max(
      latencyData.push.p50,
      latencyData.push.p90,
      latencyData.push.p99,
      latencyData.pull.p50,
      latencyData.pull.p90,
      latencyData.pull.p99,
      1
    );
    return [
      {
        label: 'P50',
        pushMs: latencyData.push.p50,
        pullMs: latencyData.pull.p50,
        pushBarPercent: (latencyData.push.p50 / maxMs) * 100,
        pullBarPercent: (latencyData.pull.p50 / maxMs) * 100,
      },
      {
        label: 'P90',
        pushMs: latencyData.push.p90,
        pullMs: latencyData.pull.p90,
        pushBarPercent: (latencyData.push.p90 / maxMs) * 100,
        pullBarPercent: (latencyData.pull.p90 / maxMs) * 100,
      },
      {
        label: 'P99',
        pushMs: latencyData.push.p99,
        pullMs: latencyData.pull.p99,
        pushBarPercent: (latencyData.push.p99 / maxMs) * 100,
        pullBarPercent: (latencyData.pull.p99 / maxMs) * 100,
      },
    ];
  }, [latencyData]);

  const commitEntries = useMemo(() => {
    if (!commitsData?.items) return [];
    return commitsData.items.map((c) => ({
      seq: c.commitSeq,
      actor: c.actorId,
      changes: c.changeCount,
      tables: (c.affectedTables ?? []).join(', '),
      time: formatTime(c.createdAt, preferences.timeFormat),
    }));
  }, [commitsData?.items, preferences.timeFormat]);

  // Compute success rate from event window
  const successRate = useMemo(() => {
    return Math.max(0, 100 - eventSummary.errorRate);
  }, [eventSummary.errorRate]);

  // Alert evaluation
  const alertMessages = useMemo(() => {
    if (!alertConfig.enabled || !stats) return [];
    const messages: string[] = [];
    if (
      latencyData?.push?.p90 &&
      latencyData.push.p90 > alertConfig.thresholds.p90Latency
    ) {
      messages.push(
        `P90 push latency (${latencyData.push.p90}ms) exceeds threshold (${alertConfig.thresholds.p90Latency}ms)`
      );
    }
    if (
      stats.minActiveClientCursor !== null &&
      stats.maxCommitSeq - stats.minActiveClientCursor >
        alertConfig.thresholds.clientLag
    ) {
      messages.push(
        `Client lag (${stats.maxCommitSeq - stats.minActiveClientCursor}) exceeds threshold (${alertConfig.thresholds.clientLag})`
      );
    }
    if (eventSummary.errorRate > alertConfig.thresholds.errorRate) {
      messages.push(
        `Error rate (${eventSummary.errorRate.toFixed(1)}%) exceeds threshold (${alertConfig.thresholds.errorRate}%)`
      );
    }
    return messages;
  }, [alertConfig, stats, latencyData, eventSummary.errorRate]);

  if (!stats) {
    return (
      <div className="flex items-center justify-center py-24">
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <TimeRangeContext.Provider value={timeRangeState}>
      <div className="flex flex-col">
        {/* Alerts */}
        {alertMessages.length > 0 && (
          <div className="px-6 pb-4">
            <Alert variant="destructive">
              <AlertTitle>Threshold Exceeded</AlertTitle>
              <AlertDescription>
                {alertMessages.map((msg, i) => (
                  <span key={i} className="block">
                    {msg}
                  </span>
                ))}
              </AlertDescription>
            </Alert>
          </div>
        )}

        {/* Topology Hero */}
        <TopologyHero
          clients={topologyNodes}
          totalNodes={topologyNodes.length + 2}
          onlineCount={onlineCount}
          offlineCount={offlineCount}
          relayClientIds={[]}
        />

        {/* KPI Strip */}
        <KpiStrip items={kpiItems} />

        {/* Two-column grid */}
        <div className="flex">
          {/* Left column */}
          <div className="flex-1 min-w-0 flex flex-col">
            <div className="border-b border-border border-r border-border">
              <ActivityBars
                bars={activityBars}
                activeRange={activityRange}
                onRangeChange={setActivityRange}
              />
            </div>

            <div className="border-b border-border border-r border-border">
              <LatencyPercentilesBar
                buckets={latencyBuckets}
                successRate={successRate}
              />
            </div>

            <div className="border-r border-border">
              <CommitTable
                commits={commitEntries}
                onViewAll={() => navigate({ href: streamHref })}
              />
            </div>
          </div>

          {/* Right column */}
          <LiveActivityFeed
            entries={feedEntries}
            isConnected={isConnected}
            maxVisible={20}
            maxHeight="calc(100vh - 200px)"
          />
        </div>
      </div>
    </TimeRangeContext.Provider>
  );
}

export function Command() {
  return <CommandInner />;
}
