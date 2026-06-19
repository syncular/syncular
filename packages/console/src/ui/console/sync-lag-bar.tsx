'use client';

import { useMemo } from 'react';
import { cn } from '../lib/cn';
import { Tooltip, TooltipContent, TooltipTrigger } from '../primitives/tooltip';

export interface SyncLagStats {
  maxCommitSeq: number;
}

export interface SyncLagClient {
  clientId: string;
  cursor: number;
  lagCommitCount?: number | null;
}

export interface SyncLagBarProps {
  className?: string;
  clients: SyncLagClient[];
  stats: SyncLagStats;
}

interface ClientLagInfo {
  lag: number;
  status: 'ok' | 'behind' | 'far-behind' | 'bootstrapping';
  colorClass: string;
  bgClass: string;
}

export function getClientLagInfo(
  cursor: number,
  headSeq: number,
  lagOverride?: number | null
): ClientLagInfo {
  const lag = lagOverride ?? Math.max(0, headSeq - cursor);

  if (cursor <= 0) {
    return {
      lag,
      status: 'bootstrapping',
      colorClass: 'text-neutral-500',
      bgClass: 'bg-neutral-700',
    };
  }

  if (lag === 0) {
    return {
      lag,
      status: 'ok',
      colorClass: 'text-healthy',
      bgClass: 'bg-healthy',
    };
  }

  if (lag <= 10) {
    return {
      lag,
      status: 'behind',
      colorClass: 'text-syncing',
      bgClass: 'bg-syncing',
    };
  }

  return {
    lag,
    status: 'far-behind',
    colorClass: 'text-offline',
    bgClass: 'bg-offline',
  };
}

export function SyncLagBar({ className, clients, stats }: SyncLagBarProps) {
  const headSeq = stats.maxCommitSeq;

  const analysis = useMemo(() => {
    const infos = clients.map((c) => ({
      ...c,
      info: getClientLagInfo(c.cursor, headSeq, c.lagCommitCount),
    }));

    const active = infos.filter((c) => c.info.status !== 'bootstrapping');
    const bootstrapping = infos.filter(
      (c) => c.info.status === 'bootstrapping'
    );

    const lags = active.map((c) => c.info.lag);
    const maxLag = lags.length > 0 ? Math.max(...lags) : 0;
    const avgLag =
      lags.length > 0
        ? Math.round(lags.reduce((sum, l) => sum + l, 0) / lags.length)
        : 0;

    const okCount = active.filter((c) => c.info.status === 'ok').length;
    const behindCount = active.filter((c) => c.info.status === 'behind').length;
    const farBehindCount = active.filter(
      (c) => c.info.status === 'far-behind'
    ).length;

    return {
      infos,
      active,
      bootstrapping,
      maxLag,
      avgLag,
      okCount,
      behindCount,
      farBehindCount,
    };
  }, [clients, headSeq]);

  const total = analysis.active.length;
  const barSegments = [
    { count: analysis.okCount, colorClass: 'bg-healthy', label: 'Up to date' },
    {
      count: analysis.behindCount,
      colorClass: 'bg-syncing',
      label: 'Behind (1-10)',
    },
    {
      count: analysis.farBehindCount,
      colorClass: 'bg-offline',
      label: 'Far behind (>10)',
    },
  ];

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      {/* Header stats */}
      <div className="flex items-center justify-between text-xs">
        <div className="flex items-center gap-4">
          <span className="text-neutral-500">
            Head: <span className="text-foreground font-mono">#{headSeq}</span>
          </span>
          <span className="text-neutral-500">
            Active:{' '}
            <span className="text-foreground">{analysis.active.length}</span>
          </span>
          {analysis.bootstrapping.length > 0 ? (
            <span className="text-neutral-500">
              Bootstrapping:{' '}
              <span className="text-foreground">
                {analysis.bootstrapping.length}
              </span>
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-4">
          <span className="text-neutral-500">
            Max lag:{' '}
            <span
              className={cn(
                'font-mono',
                analysis.maxLag === 0
                  ? 'text-healthy'
                  : analysis.maxLag <= 10
                    ? 'text-syncing'
                    : 'text-offline'
              )}
            >
              {analysis.maxLag}
            </span>
          </span>
          <span className="text-neutral-500">
            Avg lag:{' '}
            <span
              className={cn(
                'font-mono',
                analysis.avgLag === 0
                  ? 'text-healthy'
                  : analysis.avgLag <= 10
                    ? 'text-syncing'
                    : 'text-offline'
              )}
            >
              {analysis.avgLag}
            </span>
          </span>
        </div>
      </div>

      {/* Stacked bar */}
      {total > 0 ? (
        <div className="h-3 rounded-full bg-neutral-900 overflow-hidden flex">
          {barSegments.map((segment) =>
            segment.count > 0 ? (
              <Tooltip key={segment.label}>
                <TooltipTrigger
                  render={
                    <div
                      className={cn(
                        'h-full transition-all',
                        segment.colorClass
                      )}
                      style={{
                        width: `${(segment.count / total) * 100}%`,
                      }}
                    />
                  }
                />
                <TooltipContent>
                  {segment.label}: {segment.count} client
                  {segment.count !== 1 ? 's' : ''}
                </TooltipContent>
              </Tooltip>
            ) : null
          )}
        </div>
      ) : (
        <div className="h-3 rounded-full bg-neutral-900" />
      )}

      {/* Legend */}
      <div className="flex items-center gap-4 text-xs">
        {barSegments.map((segment) => (
          <div key={segment.label} className="flex items-center gap-1.5">
            <div className={cn('h-2 w-2 rounded-full', segment.colorClass)} />
            <span className="text-neutral-500">
              {segment.label}{' '}
              <span className="text-foreground">{segment.count}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
