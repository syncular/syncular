'use client';

import { type ComponentPropsWithoutRef, forwardRef } from 'react';
import { cn } from '../lib/cn';
import type { SyncClientNode } from '../lib/types';

export type SyncHorizonProps = ComponentPropsWithoutRef<'div'> & {
  clients: SyncClientNode[];
  headSeq: number;
  maxLag?: number;
  /** Min seq shown on the scale. Defaults to headSeq minus range */
  minSeq?: number;
};

function getCursorColor(status: string) {
  if (status === 'online') return '#22c55e';
  if (status === 'syncing') return '#f59e0b';
  return '#ef4444';
}

const SyncHorizon = forwardRef<HTMLDivElement, SyncHorizonProps>(
  ({ className, clients, headSeq, maxLag, minSeq, ...props }, ref) => {
    const cursors = clients.map((c) => c.cursor);
    const computedMinSeq = minSeq ?? Math.min(...cursors, headSeq) - 10;
    const computedMaxLag =
      maxLag ?? Math.max(...clients.map((c) => headSeq - c.cursor), 0);
    const range = headSeq - computedMinSeq;

    const scaleMarkers = [
      computedMinSeq,
      Math.round(computedMinSeq + range * 0.33),
      Math.round(computedMinSeq + range * 0.66),
      headSeq,
    ];

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
          <span className="font-mono text-[10px] text-neutral-500 uppercase tracking-widest">
            Sync Horizon
          </span>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <span className="font-mono text-[10px] text-neutral-500">
                Head
              </span>
              <span className="font-mono text-xs text-white font-semibold">
                #{headSeq.toLocaleString()}
              </span>
            </div>
            <div className="w-px h-3 bg-border" />
            <div className="flex items-center gap-2">
              <span className="font-mono text-[10px] text-neutral-500">
                Max lag
              </span>
              <span className="font-mono text-xs text-syncing font-semibold">
                {computedMaxLag}
              </span>
            </div>
          </div>
        </div>

        {/* Body */}
        <div className="p-4">
          {/* Timeline bar */}
          <div className="relative h-8 mb-3 rounded bg-surface">
            {/* Scale markers */}
            <div className="absolute inset-0 flex items-center justify-between px-2">
              {scaleMarkers.map((m) => (
                <span key={m} className="font-mono text-[8px] text-neutral-700">
                  #{m.toLocaleString()}
                </span>
              ))}
            </div>

            {/* Head line */}
            <div
              className="absolute top-0 bottom-0 w-px bg-flow/40"
              style={{ right: '2%' }}
            />

            {/* Client cursors */}
            {clients.map((c) => {
              const pct =
                range > 0 ? ((c.cursor - computedMinSeq) / range) * 96 + 2 : 50;
              const color = getCursorColor(c.status);
              const op = c.status === 'offline' ? 0.4 : 1;

              return (
                <div
                  key={c.id}
                  className="absolute"
                  style={{
                    left: `${pct}%`,
                    top: '50%',
                    transform: 'translate(-50%,-50%)',
                    opacity: op,
                  }}
                  title={`${c.id} \u2192 #${c.cursor}`}
                >
                  <div
                    className="w-2.5 h-2.5 rounded-full"
                    style={{
                      background: color,
                      boxShadow: `0 0 4px ${color}`,
                    }}
                  />
                </div>
              );
            })}
          </div>

          {/* Legend */}
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-healthy" />
              <span className="font-mono text-[9px] text-neutral-500">
                Caught up
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-syncing" />
              <span className="font-mono text-[9px] text-neutral-500">
                Behind
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-offline opacity-50" />
              <span className="font-mono text-[9px] text-neutral-500">
                Offline
              </span>
            </div>
          </div>
        </div>
      </div>
    );
  }
);
SyncHorizon.displayName = 'SyncHorizon';

export { SyncHorizon };
