'use client';

import { Toggle as BaseToggle } from '@base-ui/react/toggle';
import { type ComponentPropsWithoutRef, forwardRef } from 'react';
import { cn } from '../lib/cn';

type ToggleProps = ComponentPropsWithoutRef<typeof BaseToggle>;

const Toggle = forwardRef<HTMLButtonElement, ToggleProps>(
  ({ className, ...props }, ref) => (
    <BaseToggle
      ref={ref}
      className={cn(
        'font-mono text-[10px] text-neutral-500 border border-transparent rounded-sm px-2.5 py-1 cursor-pointer transition-all hover:text-neutral-300 data-[pressed]:text-white data-[pressed]:border-border-bright data-[pressed]:bg-white/[0.03]',
        className
      )}
      {...props}
    />
  )
);
Toggle.displayName = 'Toggle';

export { Toggle };
export type { ToggleProps };
