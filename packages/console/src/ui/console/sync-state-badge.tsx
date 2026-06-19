'use client';

import { cn } from '../lib/cn';
import { Badge } from '../primitives/badge';

export interface SyncStateBadgeProps {
  className?: string;
  state: string;
}

export function SyncStateBadge({ className, state }: SyncStateBadgeProps) {
  const variant = stateToVariant(state);

  return (
    <Badge variant={variant} className={cn(className)}>
      {state}
    </Badge>
  );
}

function stateToVariant(state: string) {
  switch (state) {
    case 'idle':
      return 'ghost' as const;
    case 'syncing':
      return 'syncing' as const;
    case 'error':
      return 'destructive' as const;
    default:
      return 'ghost' as const;
  }
}
