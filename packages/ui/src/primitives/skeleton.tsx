'use client';

import { type ComponentPropsWithoutRef, forwardRef } from 'react';
import { cn } from '../lib/cn';

const Skeleton = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<'div'>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn('rounded-md bg-neutral-800 animate-pulse', className)}
      {...props}
    />
  )
);
Skeleton.displayName = 'Skeleton';

export { Skeleton };
