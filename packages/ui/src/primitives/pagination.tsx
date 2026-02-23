'use client';

import { forwardRef, type HTMLAttributes } from 'react';
import { cn } from '../lib/cn';
import { Button } from './button';

type PaginationProps = HTMLAttributes<HTMLDivElement> & {
  page: number;
  totalPages: number;
  totalItems: number;
  onPageChange: (page: number) => void;
};

const Pagination = forwardRef<HTMLDivElement, PaginationProps>(
  (
    { className, page, totalPages, totalItems, onPageChange, ...props },
    ref
  ) => (
    <div
      ref={ref}
      className={cn(
        'px-5 py-2.5 border-t border-border flex items-center justify-between',
        className
      )}
      {...props}
    >
      <span className="font-mono text-[10px] text-neutral-600">
        {totalItems} items · Page {page} of {totalPages}
      </span>
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="default"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          Prev
        </Button>
        <Button
          size="sm"
          variant="default"
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
        >
          Next
        </Button>
      </div>
    </div>
  )
);
Pagination.displayName = 'Pagination';

export { Pagination };
export type { PaginationProps };
