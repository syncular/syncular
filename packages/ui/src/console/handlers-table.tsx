'use client';

import { type ComponentPropsWithoutRef, forwardRef } from 'react';
import { cn } from '../lib/cn';
import type { HandlerEntry } from '../lib/types';
import { Badge } from '../primitives/badge';

export type HandlersTableProps = ComponentPropsWithoutRef<'div'> & {
  handlers: HandlerEntry[];
  tableCount?: number;
};

const HandlersTable = forwardRef<HTMLDivElement, HandlersTableProps>(
  ({ className, handlers, tableCount, ...props }, ref) => {
    const count = tableCount ?? handlers.length;

    return (
      <div
        ref={ref}
        className={cn(
          'bg-panel border border-border rounded-lg hover:border-border-bright transition',
          className
        )}
        {...props}
      >
        {/* Header */}
        <div className="px-4 py-2.5 border-b border-border flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-flow" />
            <span className="font-mono text-[10px] text-neutral-500 uppercase tracking-widest">
              Handlers
            </span>
          </div>
          <span className="font-mono text-[10px] text-neutral-600">
            {count} tables
          </span>
        </div>

        {/* Column headers */}
        <div className="font-mono text-[9px] tracking-wider uppercase text-neutral-600 flex items-center gap-4 px-4 leading-6 border-b border-border">
          <span className="flex-1">Table</span>
          <span className="w-[100px]">Depends On</span>
          <span className="w-[70px] text-right">Chunk TTL</span>
        </div>

        {/* Rows */}
        {handlers.map((h, i) => (
          <div
            key={`${h.table}:${i}`}
            className={cn(
              'font-mono text-[11px] leading-7 px-4 flex items-center gap-4 hover:bg-white/[0.015] transition-colors cursor-default',
              i < handlers.length - 1 && 'border-b border-[#141414]'
            )}
          >
            <span className="flex-1 text-white truncate">{h.table}</span>
            <span className="w-[100px] truncate">
              {h.dependsOn ? (
                <Badge variant="ghost">{h.dependsOn}</Badge>
              ) : (
                <span className="text-neutral-600">&mdash;</span>
              )}
            </span>
            <span className="w-[70px] text-right text-neutral-500 truncate">
              {h.chunkTtl}
            </span>
          </div>
        ))}
      </div>
    );
  }
);
HandlersTable.displayName = 'HandlersTable';

export { HandlersTable };
