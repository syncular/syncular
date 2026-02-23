'use client';

import { ToggleGroup as BaseToggleGroup } from '@base-ui/react/toggle-group';
import { type ComponentPropsWithoutRef, forwardRef } from 'react';
import { cn } from '../lib/cn';

type ToggleGroupProps = ComponentPropsWithoutRef<typeof BaseToggleGroup>;

const ToggleGroup = forwardRef<HTMLDivElement, ToggleGroupProps>(
  ({ className, ...props }, ref) => (
    <BaseToggleGroup
      ref={ref}
      className={cn('flex items-center gap-0.5', className)}
      {...props}
    />
  )
);
ToggleGroup.displayName = 'ToggleGroup';

export { ToggleGroup };
export type { ToggleGroupProps };

// Re-export Toggle as ToggleGroupItem for backward compat
export { Toggle as ToggleGroupItem } from './toggle';
