'use client';

import {
  type ComponentPropsWithoutRef,
  forwardRef,
  type ReactNode,
} from 'react';
import { cn } from '../lib/cn';
import type { StreamOperation } from '../lib/types';

export type StreamLogProps = ComponentPropsWithoutRef<'div'> & {
  entries: StreamOperation[];
  /** Filter bar rendered above the table */
  filterBar?: ReactNode;
  /** Pagination rendered below the table */
  pagination?: ReactNode;
  /** Optional click handler for selecting a row */
  onEntryClick?: (entry: StreamOperation) => void;
  /** Selected entry id for row highlighting */
  selectedEntryId?: string | null;
};

const typeColorMap: Record<string, string> = {
  commit: 'text-flow',
  push: 'text-syncing',
  pull: 'text-healthy',
};

const outcomeColorMap: Record<string, string> = {
  applied: 'text-healthy',
  error: 'text-offline',
  cached: 'text-syncing',
};

const StreamLog = forwardRef<HTMLDivElement, StreamLogProps>(
  (
    {
      className,
      entries,
      filterBar,
      pagination,
      onEntryClick,
      selectedEntryId,
      ...props
    },
    ref
  ) => (
    <div ref={ref} className={cn('h-full flex flex-col', className)} {...props}>
      {filterBar}

      {/* Column headers */}
      <div className="font-mono text-[9px] tracking-wider uppercase text-neutral-600 flex items-center gap-4 px-4 leading-6 border-b border-border bg-white/[0.01]">
        <span className="w-[50px] truncate">Time</span>
        <span className="w-[65px] truncate">Type</span>
        <span className="w-[55px] truncate">ID</span>
        <span className="w-[65px] truncate">Outcome</span>
        <span className="w-[50px] truncate">Dur</span>
        <span className="w-[100px] truncate">Actor</span>
        <span className="w-[120px] truncate">Client</span>
        <span className="flex-1 truncate">Detail</span>
      </div>

      {/* Log entries */}
      <div className="flex-1 overflow-y-auto">
        {entries.map((entry, i) => (
          <StreamLogRow
            key={`${entry.id}-${i}`}
            entry={entry}
            isSelected={selectedEntryId === entry.id}
            onClick={onEntryClick}
          />
        ))}
      </div>

      {pagination}
    </div>
  )
);
StreamLog.displayName = 'StreamLog';

function StreamLogRow({
  entry,
  isSelected,
  onClick,
}: {
  entry: StreamOperation;
  isSelected: boolean;
  onClick?: (entry: StreamOperation) => void;
}) {
  const typeColor = typeColorMap[entry.type] ?? 'text-neutral-500';
  const outcomeColor = outcomeColorMap[entry.outcome] ?? 'text-neutral-600';
  const rowClassName = cn(
    'font-mono text-[11px] leading-7 px-4 flex items-center gap-4 border-b border-[#141414] hover:bg-white/[0.015] transition-colors',
    onClick ? 'cursor-pointer' : 'cursor-default',
    isSelected && 'bg-white/[0.05]'
  );
  const rowContent = (
    <>
      <span className="w-[50px] text-neutral-600 truncate">{entry.time}</span>
      <span className={cn('w-[65px] font-medium truncate', typeColor)}>
        {entry.type.toUpperCase()}
      </span>
      <span className="w-[55px] text-flow truncate">{entry.id}</span>
      <span className={cn('w-[65px] truncate', outcomeColor)}>
        {entry.outcome}
      </span>
      <span className="w-[50px] text-neutral-500 truncate">
        {entry.duration}
      </span>
      <span className="w-[100px] text-neutral-400 truncate">{entry.actor}</span>
      <span
        className="w-[120px] text-neutral-600 truncate"
        title={entry.client}
      >
        {entry.client.length > 14
          ? `${entry.client.substring(0, 14)}\u2026`
          : entry.client}
      </span>
      <span className="flex-1 text-neutral-500 truncate">{entry.detail}</span>
    </>
  );

  if (!onClick) {
    return <div className={rowClassName}>{rowContent}</div>;
  }

  return (
    <button
      type="button"
      className={cn(rowClassName, 'w-full bg-transparent text-left')}
      onClick={() => onClick(entry)}
    >
      {rowContent}
    </button>
  );
}

export { StreamLog };
