'use client';

import { cva, type VariantProps } from 'class-variance-authority';
import { type ComponentPropsWithoutRef, forwardRef } from 'react';
import { cn } from '../lib/cn';

const badgeVariants = cva(
  'inline-flex items-center gap-1 px-2 py-0.5 rounded-sm font-mono text-[9px] leading-normal uppercase tracking-wider',
  {
    variants: {
      variant: {
        default: 'bg-white/[0.05] text-neutral-300 border border-border-bright',
        destructive: 'bg-offline/10 text-offline border border-offline/20',
        ghost: 'bg-transparent text-neutral-500 border border-border-bright',
        outline: 'bg-transparent text-neutral-400 border border-border-bright',
        secondary: 'bg-panel text-neutral-400 border border-border',
        healthy: 'bg-healthy/10 text-healthy border border-healthy/20',
        syncing: 'bg-syncing/10 text-syncing border border-syncing/20',
        offline: 'bg-offline/10 text-offline border border-offline/20',
        flow: 'bg-flow/10 text-flow border border-flow/20',
        relay: 'bg-relay/10 text-relay border border-relay/20',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
);

type BadgeProps = ComponentPropsWithoutRef<'span'> &
  VariantProps<typeof badgeVariants>;

const Badge = forwardRef<HTMLSpanElement, BadgeProps>(
  ({ className, variant, style, ...props }, ref) => (
    <span
      ref={ref}
      className={cn(badgeVariants({ variant, className }))}
      style={{ lineHeight: 1, ...style }}
      {...props}
    />
  )
);
Badge.displayName = 'Badge';

export { Badge, badgeVariants };
export type { BadgeProps };
