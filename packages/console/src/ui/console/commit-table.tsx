'use client';

import { type ComponentPropsWithoutRef, forwardRef } from 'react';
import { cn } from '../lib/cn';
import type { CommitStreamEntry } from '../lib/types';

export type CommitTableProps = ComponentPropsWithoutRef<'div'> & {
  commits: CommitStreamEntry[];
  onViewAll?: () => void;
};

const CommitTable = forwardRef<HTMLDivElement, CommitTableProps>(
  ({ className, commits, onViewAll, ...props }, ref) => (
    <div ref={ref} className={cn('px-5 pt-3 pb-2', className)} {...props}>
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <span className="font-mono text-[10px] text-neutral-500 uppercase tracking-widest">
          Recent Commits
        </span>
        {onViewAll && (
          <button
            type="button"
            onClick={onViewAll}
            className="inline-flex items-center gap-1.5 rounded-md font-mono text-[9px] px-2 py-0.5 border border-border-bright bg-transparent text-neutral-400 hover:text-white hover:bg-white/[0.03] cursor-pointer transition-all"
          >
            View all &rarr;
          </button>
        )}
      </div>

      {/* Column headers */}
      <div className="font-mono text-[9px] tracking-wider uppercase text-neutral-600 flex items-center gap-4 px-4 leading-[22px] border-b border-border">
        <span className="w-[60px] truncate">Seq</span>
        <span className="w-[100px] truncate">Actor</span>
        <span className="w-[50px] truncate">Chg</span>
        <span className="flex-1 truncate">Tables</span>
        <span className="w-[70px] text-right truncate">Time</span>
      </div>

      {/* Rows */}
      {commits.map((c) => (
        <div
          key={c.seq}
          className="font-mono text-[11px] leading-7 px-4 flex items-center gap-4 border-b border-[#141414] hover:bg-white/[0.015] transition-colors cursor-default"
        >
          <span className="w-[60px] text-flow font-medium truncate">
            #{c.seq}
          </span>
          <span className="w-[100px] text-neutral-400 truncate">{c.actor}</span>
          <span className="w-[50px] text-white truncate">{c.changes}</span>
          <span className="flex-1 truncate">
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-sm font-mono text-[9px] uppercase tracking-wider bg-transparent text-neutral-500 border border-border-bright">
              {c.tables}
            </span>
          </span>
          <span className="w-[70px] text-right text-neutral-600 truncate">
            {c.time}
          </span>
        </div>
      ))}
    </div>
  )
);
CommitTable.displayName = 'CommitTable';

export { CommitTable };
