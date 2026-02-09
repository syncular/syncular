'use client';

import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

export interface TaskListProps {
  children: ReactNode;
  emptyMessage?: string;
  className?: string;
}

export function TaskList({
  children,
  emptyMessage = 'No tasks yet',
  className,
}: TaskListProps) {
  // Check if children is empty
  const hasChildren = Array.isArray(children)
    ? children.filter(Boolean).length > 0
    : Boolean(children);

  return (
    <div className={cn('min-h-[120px]', className)}>
      {hasChildren ? (
        <div className="space-y-0.5">{children}</div>
      ) : (
        <div className="flex items-center justify-center h-[120px]">
          <p className="text-xs text-neutral-600">{emptyMessage}</p>
        </div>
      )}
    </div>
  );
}
