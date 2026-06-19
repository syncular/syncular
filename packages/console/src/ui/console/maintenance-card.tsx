'use client';

import {
  type ComponentPropsWithoutRef,
  forwardRef,
  type ReactNode,
} from 'react';
import { cn } from '../lib/cn';
import { Button } from '../primitives/button';

export type MaintenanceStat = {
  label: string;
  value: ReactNode;
  tone?: 'default' | 'syncing';
};

export type MaintenanceCardProps = ComponentPropsWithoutRef<'div'> & {
  title: string;
  description: string;
  dotColor?: 'syncing' | 'flow' | 'healthy' | 'offline';
  stats: MaintenanceStat[];
  actionLabel: string;
  actionVariant?: 'default' | 'primary' | 'destructive';
  actionIcon?: ReactNode;
  onAction?: () => void;
};

const dotColorMap: Record<string, string> = {
  syncing: 'bg-syncing',
  flow: 'bg-flow',
  healthy: 'bg-healthy',
  offline: 'bg-offline',
};

const MaintenanceCard = forwardRef<HTMLDivElement, MaintenanceCardProps>(
  (
    {
      className,
      title,
      description,
      dotColor = 'syncing',
      stats,
      actionLabel,
      actionVariant = 'default',
      actionIcon,
      onAction,
      ...props
    },
    ref
  ) => (
    <div
      ref={ref}
      className={cn(
        'bg-panel border border-border rounded-lg hover:border-border-bright transition',
        className
      )}
      {...props}
    >
      {/* Header */}
      <div className="px-4 py-2.5 border-b border-border flex items-center gap-2">
        <span
          className={cn('w-1.5 h-1.5 rounded-full', dotColorMap[dotColor])}
        />
        <span className="font-mono text-[10px] text-neutral-500 uppercase tracking-widest">
          {title}
        </span>
      </div>

      {/* Body */}
      <div className="p-4">
        <p className="font-mono text-[10px] text-neutral-500 leading-relaxed mb-4">
          {description}
        </p>

        {/* Stats grid */}
        <div
          className={cn(
            'grid gap-3 mb-4',
            stats.length <= 2 ? 'grid-cols-2' : 'grid-cols-3'
          )}
        >
          {stats.map((s) => (
            <div key={s.label}>
              <div className="font-mono text-[9px] text-neutral-600 uppercase tracking-wider mb-1">
                {s.label}
              </div>
              <div
                className={cn(
                  'font-mono font-semibold',
                  s.tone === 'syncing'
                    ? 'text-sm text-syncing'
                    : 'text-lg text-white'
                )}
              >
                {s.value}
              </div>
            </div>
          ))}
        </div>

        {/* Action */}
        <Button variant={actionVariant} size="md" onClick={onAction}>
          {actionIcon}
          {actionLabel}
        </Button>
      </div>
    </div>
  )
);
MaintenanceCard.displayName = 'MaintenanceCard';

export { MaintenanceCard };
