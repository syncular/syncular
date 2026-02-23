'use client';

import { cn } from '../lib/cn';

export type SyncStatus = 'synced' | 'syncing' | 'offline' | 'error';

export interface SyncStatusBadgeProps {
  status: SyncStatus;
  className?: string;
}

const statusConfig: Record<SyncStatus, { text: string; color: string }> = {
  synced: { text: 'Synced', color: 'text-healthy' },
  syncing: { text: 'Syncing', color: 'text-syncing' },
  offline: { text: 'Offline', color: 'text-offline' },
  error: { text: 'Error', color: 'text-offline' },
};

const dotConfig: Record<SyncStatus, string> = {
  synced: 'bg-healthy',
  syncing: 'bg-syncing',
  offline: 'bg-offline',
  error: 'bg-offline',
};

export function SyncStatusBadge({ status, className }: SyncStatusBadgeProps) {
  const config = statusConfig[status];
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <span className={cn('font-mono text-[10px]', config.color)}>
        {config.text}
      </span>
      <span className={cn('w-1.5 h-1.5 rounded-full', dotConfig[status])} />
    </div>
  );
}
