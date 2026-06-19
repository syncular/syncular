'use client';

import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

export interface EmptyStateProps {
  action?: ReactNode;
  className?: string;
  icon?: ReactNode;
  message: string;
}

export function EmptyState({
  action,
  className,
  icon,
  message,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 py-12',
        className
      )}
    >
      {icon ? <div className="text-neutral-500">{icon}</div> : null}
      <p className="font-mono text-[10px] text-neutral-500">{message}</p>
      {action ? <div>{action}</div> : null}
    </div>
  );
}
