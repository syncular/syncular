'use client';

import { cn } from '../lib/cn';

export interface TransferEntry {
  type: 'UPLOAD' | 'SYNC' | 'DEDUP';
  name: string;
  size: string;
  time: string;
}

export interface TransferLogProps {
  entries: TransferEntry[];
  label?: string;
  emptyText?: string;
  className?: string;
}

const badgeClass: Record<TransferEntry['type'], string> = {
  UPLOAD:
    'inline-flex items-center px-2 py-0.5 rounded-sm font-mono text-[9px] uppercase tracking-wider bg-flow/10 text-flow border border-flow/20',
  SYNC: 'inline-flex items-center px-2 py-0.5 rounded-sm font-mono text-[9px] uppercase tracking-wider bg-healthy/10 text-healthy border border-healthy/20',
  DEDUP:
    'inline-flex items-center px-2 py-0.5 rounded-sm font-mono text-[9px] uppercase tracking-wider bg-syncing/10 text-syncing border border-syncing/20',
};

export function TransferLog({
  entries,
  label = 'Blob Transfer Log',
  emptyText = 'No transfers yet',
  className,
}: TransferLogProps) {
  return (
    <div
      className={cn('rounded-[10px] border border-border bg-panel', className)}
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="font-mono text-[10px] uppercase tracking-wider text-neutral-500">
          {label}
        </span>
        <span className="font-mono text-[10px] text-neutral-600">
          {entries.length} transfers
        </span>
      </div>
      <div className="overflow-auto" style={{ maxHeight: 180 }}>
        {entries.length === 0 ? (
          <div className="text-center py-6">
            <span className="font-mono text-[10px] text-neutral-600">
              {emptyText}
            </span>
          </div>
        ) : (
          entries.map((entry, i) => (
            <div
              key={`${entry.name}-${i}`}
              className="font-mono text-[10px] leading-[26px] px-3 flex items-center gap-2.5 border-b border-[#141414] text-neutral-500 last:border-b-0"
            >
              <span className={badgeClass[entry.type]}>{entry.type}</span>
              <span className="truncate">{entry.name}</span>
              <span className="text-neutral-700">{entry.size}</span>
              <span className="ml-auto text-neutral-700">{entry.time}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
