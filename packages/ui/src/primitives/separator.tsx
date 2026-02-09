'use client';

import { type ComponentPropsWithoutRef, forwardRef } from 'react';
import { cn } from '../lib/cn';

type SeparatorProps = Omit<ComponentPropsWithoutRef<'hr'>, 'children'> & {
  orientation?: 'horizontal' | 'vertical';
};

const Separator = forwardRef<HTMLHRElement, SeparatorProps>(
  ({ className, orientation = 'horizontal', ...props }, ref) => (
    <hr
      ref={ref}
      aria-orientation={orientation === 'vertical' ? 'vertical' : undefined}
      className={cn(
        'border-none m-0',
        orientation === 'horizontal'
          ? 'h-px w-full bg-border'
          : 'w-px h-4 bg-border',
        className
      )}
      {...props}
    />
  )
);
Separator.displayName = 'Separator';

export { Separator };
export type { SeparatorProps };
