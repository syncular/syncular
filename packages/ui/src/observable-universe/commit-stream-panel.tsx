'use client';

import { forwardRef } from 'react';
import { cn } from '../lib/cn';
import type { ObservableStreamEntry } from './types';

export interface CommitStreamPanelProps {
  entries: ObservableStreamEntry[];
  rate?: string;
  className?: string;
}

function formatDetail(entry: ObservableStreamEntry) {
  if (entry.operation === 'PUSH') {
    return {
      color: 'text-amber-400',
      detail: (
        <>
          <span className="text-neutral-500">{entry.table}</span>
          {'  '}
          <span className="text-neutral-400">{entry.mutation}</span>
          {'  '}
          <span className="text-neutral-500">
            +{entry.commits} commit{entry.commits > 1 ? 's' : ''}
          </span>
        </>
      ),
    };
  }
  if (entry.operation === 'PULL') {
    return {
      color: 'text-emerald-400',
      detail: (
        <>
          <span className="text-neutral-500">{entry.table}</span>
          {'  '}
          <span className="text-neutral-400">
            +{entry.commits} commit{entry.commits > 1 ? 's' : ''}
          </span>{' '}
          <span className="text-neutral-600">(synced)</span>
        </>
      ),
    };
  }
  return {
    color: 'text-blue-400',
    detail: (
      <>
        <span className="text-neutral-500">sync complete</span>{' '}
        <span className="text-neutral-600">(0 conflicts)</span>
      </>
    ),
  };
}

export const CommitStreamPanel = forwardRef<
  HTMLDivElement,
  CommitStreamPanelProps
>(function CommitStreamPanel({ entries, rate, className }, ref) {
  return (
    <div
      ref={ref}
      className={cn('dashboard-panel rounded-lg flex flex-col', className)}
    >
      <div className="px-4 py-3 border-b border-border flex items-center justify-between">
        <span className="font-mono text-[11px] text-neutral-400 uppercase tracking-wider">
          Commit Stream
        </span>
        {rate ? (
          <span className="font-mono text-[11px] text-healthy">{rate}</span>
        ) : null}
      </div>
      <div className="flex-1 overflow-hidden relative">
        <div
          className="absolute inset-x-0 top-0 h-6 z-10 pointer-events-none"
          style={{
            background: 'linear-gradient(to bottom, #111111, transparent)',
          }}
        />
        <div
          className="absolute inset-x-0 bottom-0 h-8 z-10 pointer-events-none"
          style={{
            background: 'linear-gradient(to top, #111111, transparent)',
          }}
        />
        <div
          className="p-3 space-y-0.5 overflow-hidden"
          style={{ maxHeight: '100%' }}
        >
          {entries.map((entry) => {
            const { color, detail } = formatDetail(entry);
            return (
              <div
                key={entry.id}
                className="stream-entry font-mono text-[9px] leading-5 whitespace-nowrap"
              >
                <span className="text-neutral-600">{entry.timestamp}</span>
                {'  '}
                <span className={cn('font-medium', color)}>
                  {entry.operation.padEnd(4)}
                </span>
                {'  '}
                <span className="text-neutral-400">
                  {entry.clientId.padEnd(10)}
                </span>
                {'  '}
                {detail}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
});
