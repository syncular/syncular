'use client';

import { type ComponentPropsWithoutRef, forwardRef } from 'react';
import { cn } from '../lib/cn';

const Table = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<'div'>>(
  ({ className, ...props }, ref) => (
    // biome-ignore lint/a11y/useSemanticElements: using div for flex layout compatibility
    <div
      ref={ref}
      role="table"
      className={cn('w-full', className)}
      {...props}
    />
  )
);
Table.displayName = 'Table';

const TableHeader = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<'div'>>(
  ({ className, ...props }, ref) => (
    // biome-ignore lint/a11y/useSemanticElements: using div for flex layout compatibility
    <div ref={ref} role="rowgroup" className={cn(className)} {...props} />
  )
);
TableHeader.displayName = 'TableHeader';

const TableBody = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<'div'>>(
  ({ className, ...props }, ref) => (
    // biome-ignore lint/a11y/useSemanticElements: using div for flex layout compatibility
    <div ref={ref} role="rowgroup" className={cn(className)} {...props} />
  )
);
TableBody.displayName = 'TableBody';

const TableRow = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<'div'>>(
  ({ className, ...props }, ref) => (
    // biome-ignore lint/a11y/useSemanticElements: using div for flex layout compatibility
    // biome-ignore lint/a11y/useFocusableInteractive: presentational table row, not interactive
    <div
      ref={ref}
      role="row"
      className={cn(
        'font-mono text-[11px] leading-6 px-4 flex items-center gap-4 border-b border-[#141414] hover:bg-white/[0.015] transition-colors cursor-default',
        className
      )}
      {...props}
    />
  )
);
TableRow.displayName = 'TableRow';

const TableHead = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<'div'>>(
  ({ className, ...props }, ref) => (
    // biome-ignore lint/a11y/useSemanticElements: using div for flex layout compatibility
    // biome-ignore lint/a11y/useFocusableInteractive: presentational column header, not interactive
    <div
      ref={ref}
      role="columnheader"
      className={cn(
        'min-w-0 font-mono text-[9px] text-neutral-600 uppercase tracking-wider leading-6 bg-white/[0.01] text-left truncate',
        className
      )}
      {...props}
    />
  )
);
TableHead.displayName = 'TableHead';

const TableCell = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<'div'>>(
  ({ className, ...props }, ref) => (
    // biome-ignore lint/a11y/useSemanticElements: using div for flex layout compatibility
    <div
      ref={ref}
      role="cell"
      className={cn(
        'min-w-0 whitespace-nowrap overflow-hidden text-ellipsis',
        className
      )}
      {...props}
    />
  )
);
TableCell.displayName = 'TableCell';

export { Table, TableHeader, TableBody, TableRow, TableHead, TableCell };
