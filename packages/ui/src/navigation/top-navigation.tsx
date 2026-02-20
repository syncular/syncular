'use client';

import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

export type TopNavigationProps = {
  brand?: ReactNode;
  center?: ReactNode;
  right?: ReactNode;
  className?: string;
};

export function TopNavigation({
  brand,
  center,
  right,
  className,
}: TopNavigationProps) {
  return (
    <>
      <div aria-hidden="true" className="h-[42px] shrink-0" />
      <nav
        className={cn(
          'fixed top-0 left-0 right-0 z-100 h-[42px] border-b border-border bg-surface/88 backdrop-blur-lg flex items-center justify-between px-5',
          className
        )}
      >
        <div className="flex items-center gap-3">{brand}</div>
        <div className="flex items-center gap-0.5">{center}</div>
        <div className="flex items-center gap-2">{right}</div>
      </nav>
    </>
  );
}
