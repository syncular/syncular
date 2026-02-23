'use client';

import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

export interface TopologyPanelProps {
  label: string;
  headerRight?: ReactNode;
  minHeight?: number;
  children: ReactNode;
  className?: string;
}

export function TopologyPanel({
  label,
  headerRight,
  minHeight = 220,
  children,
  className,
}: TopologyPanelProps) {
  return (
    <div
      className={cn(
        'rounded-[10px] border border-border bg-panel overflow-hidden',
        className
      )}
    >
      <div className="px-4 py-2.5 border-b border-border flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[1.5px] text-neutral-500">
          {label}
        </span>
        {headerRight ? (
          <div className="flex items-center gap-4">{headerRight}</div>
        ) : null}
      </div>
      <div
        className="flex items-center justify-center relative dot-grid"
        style={{ minHeight: `${minHeight}px` }}
      >
        {children}
      </div>
    </div>
  );
}
