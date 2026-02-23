'use client';

import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

export interface ConflictPanelProps {
  visible: boolean;
  children: ReactNode;
  className?: string;
}

export function ConflictPanel({
  visible,
  children,
  className,
}: ConflictPanelProps) {
  return (
    <div className={cn('mt-3', className)} hidden={!visible}>
      <div className="font-mono text-[10px] text-syncing uppercase tracking-wider mb-2">
        Pending Conflicts
      </div>
      <div className="space-y-1">{children}</div>
    </div>
  );
}
