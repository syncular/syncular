'use client';

import { forwardRef } from 'react';
import { cn } from '../lib/cn';
import type { ObservableMetrics } from './types';

export interface LiveMetricsBarProps {
  metrics: ObservableMetrics;
  className?: string;
}

export const LiveMetricsBar = forwardRef<HTMLDivElement, LiveMetricsBarProps>(
  function LiveMetricsBar({ metrics, className }, ref) {
    return (
      <div
        ref={ref}
        className={cn(
          'dashboard-panel rounded-lg px-6 py-3 flex items-center justify-between flex-wrap gap-4',
          className
        )}
      >
        <div className="flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-flow inline-block" />
          <span className="font-mono text-[11px] text-neutral-500 uppercase">
            Commits/sec
          </span>
          <span className="font-mono text-sm text-white font-medium">
            {metrics.commitsPerSec.toFixed(1)}
          </span>
        </div>
        <div className="w-px h-4 bg-border" />
        <div className="flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-healthy inline-block" />
          <span className="font-mono text-[11px] text-neutral-500 uppercase">
            Avg Sync Latency
          </span>
          <span className="font-mono text-sm text-white font-medium">
            {metrics.avgLatency}ms
          </span>
        </div>
        <div className="w-px h-4 bg-border" />
        <div className="flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-syncing inline-block" />
          <span className="font-mono text-[11px] text-neutral-500 uppercase">
            Active Clients
          </span>
          <span className="font-mono text-sm text-white font-medium">
            {metrics.activeClients}
          </span>
        </div>
        <div className="w-px h-4 bg-border" />
        <div className="flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-healthy inline-block" />
          <span className="font-mono text-[11px] text-neutral-500 uppercase">
            Uptime
          </span>
          <span className="font-mono text-sm text-white font-medium">
            {metrics.uptime}
          </span>
        </div>
      </div>
    );
  }
);
