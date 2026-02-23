'use client';

import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

export interface ActorPanelProps {
  label: string;
  color: 'flow' | 'healthy' | 'syncing' | 'relay' | 'encrypt';
  icon: ReactNode;
  badge?: ReactNode;
  children: ReactNode;
  className?: string;
}

const iconBgMap: Record<ActorPanelProps['color'], string> = {
  flow: 'bg-flow/15',
  healthy: 'bg-healthy/15',
  syncing: 'bg-syncing/15',
  relay: 'bg-relay/15',
  encrypt: 'bg-encrypt/15',
};

export function ActorPanel({
  label,
  color,
  icon,
  badge,
  children,
  className,
}: ActorPanelProps) {
  return (
    <div className={cn('panel', className)}>
      <div className="panel-header">
        <div className="flex items-center gap-2">
          <div
            className={cn(
              'w-5 h-5 rounded-full flex items-center justify-center',
              iconBgMap[color]
            )}
          >
            <span className="text-[12px] leading-none">{icon}</span>
          </div>
          <span className="panel-label">{label}</span>
        </div>
        {badge}
      </div>
      <div className="p-3">{children}</div>
    </div>
  );
}
