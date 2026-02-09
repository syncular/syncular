'use client';

import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

export interface MetricCardProps {
  label: string;
  value: ReactNode;
  subtext?: string;
  dotColor?: 'healthy' | 'syncing' | 'flow';
  dotPulse?: boolean;
  progress?: number;
  progressColor?: 'healthy' | 'syncing' | 'flow';
  progressLabel?: string;
  className?: string;
}

const dotColorMap = {
  healthy: 'bg-healthy',
  syncing: 'bg-syncing',
  flow: 'bg-flow',
};

const progressColorMap = {
  healthy: 'bg-healthy',
  syncing: 'bg-syncing',
  flow: 'bg-flow',
};

export function MetricCard({
  label,
  value,
  subtext,
  dotColor,
  dotPulse,
  progress,
  progressColor = 'healthy',
  progressLabel,
  className,
}: MetricCardProps) {
  return (
    <div
      className={cn('bg-panel border border-border rounded-lg p-4', className)}
    >
      <div className="flex items-center justify-between mb-2">
        <span className="font-mono text-[10px] text-neutral-500 uppercase tracking-wider">
          {label}
        </span>
        {dotColor ? (
          <span
            className={cn(
              'w-1.5 h-1.5 rounded-full',
              dotColorMap[dotColor],
              dotPulse && 'dot-pulse'
            )}
          />
        ) : null}
      </div>
      <div className="font-display text-2xl font-bold text-white">{value}</div>
      {subtext ? (
        <div className="font-mono text-[10px] text-neutral-600 mt-1">
          {subtext}
        </div>
      ) : null}
      {progress !== undefined ? (
        <div className="mt-2">
          <div className="h-[3px] bg-border rounded-full overflow-hidden">
            <div
              className={cn(
                'h-full rounded-full transition-all duration-800 ease-out',
                progressColorMap[progressColor]
              )}
              style={{ width: `${Math.min(100, progress)}%` }}
            />
          </div>
          {progressLabel ? (
            <div className="font-mono text-[10px] text-neutral-600 mt-1">
              {progressLabel}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
