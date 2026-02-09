'use client';

import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../lib/cn';

const statusDotVariants = cva('rounded-full inline-block flex-shrink-0', {
  variants: {
    color: {
      healthy: 'bg-healthy',
      syncing: 'bg-syncing',
      offline: 'bg-offline',
      flow: 'bg-flow',
      relay: 'bg-relay',
      encrypt: 'bg-encrypt',
      muted: 'bg-neutral-500',
    },
    size: {
      sm: 'w-1.5 h-1.5',
      md: 'w-2 h-2',
      lg: 'w-2.5 h-2.5',
    },
    glow: {
      true: '',
      false: '',
    },
  },
  defaultVariants: {
    color: 'healthy',
    size: 'sm',
    glow: false,
  },
});

const glowMap: Record<string, string> = {
  healthy: '0 0 6px #22c55e',
  syncing: '0 0 6px #f59e0b',
  offline: '0 0 6px #ef4444',
  flow: '0 0 6px #3b82f6',
  relay: '0 0 6px #8b5cf6',
  encrypt: '0 0 6px #f472b6',
  muted: 'none',
};

export type StatusDotProps = VariantProps<typeof statusDotVariants> & {
  className?: string;
  pulse?: boolean;
};

export function StatusDot({
  color,
  size,
  glow,
  pulse,
  className,
}: StatusDotProps) {
  return (
    <span
      className={cn(
        statusDotVariants({ color, size, glow }),
        pulse && 'dot-pulse',
        className
      )}
      style={glow ? { boxShadow: glowMap[color ?? 'healthy'] } : undefined}
    />
  );
}
