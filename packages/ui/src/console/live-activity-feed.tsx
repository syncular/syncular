'use client';

import { type ComponentPropsWithoutRef, forwardRef } from 'react';
import { cn } from '../lib/cn';
import { Badge } from '../primitives/badge';

type FeedEventType = 'PUSH' | 'PULL' | 'ACK' | (string & {});

export type FeedEntry = {
  type: FeedEventType;
  actor: string;
  table: string;
  time: string;
};

export type LiveActivityFeedProps = ComponentPropsWithoutRef<'div'> & {
  entries: FeedEntry[];
  isConnected?: boolean;
  maxVisible?: number;
  /** Height for the scroll area */
  maxHeight?: string;
};

const badgeVariantMap: Record<string, 'syncing' | 'healthy' | 'flow'> = {
  PUSH: 'syncing',
  PULL: 'healthy',
  ACK: 'flow',
};

const LiveActivityFeed = forwardRef<HTMLDivElement, LiveActivityFeedProps>(
  (
    {
      className,
      entries,
      isConnected = true,
      maxVisible = 20,
      maxHeight,
      ...props
    },
    ref
  ) => {
    const visibleEntries = entries.slice(0, maxVisible);

    return (
      <div
        ref={ref}
        className={cn('flex-shrink-0', className)}
        style={{ width: 360 }}
        {...props}
      >
        {/* Header */}
        <div className="px-4 py-2.5 border-b border-border flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[10px] text-neutral-500 uppercase tracking-widest">
              Live Feed
            </span>
            <span
              className={cn(
                'w-1.5 h-1.5 rounded-full',
                isConnected
                  ? 'bg-healthy animate-[dotPulse_1.5s_ease-in-out_infinite]'
                  : 'bg-neutral-600'
              )}
            />
          </div>
          <span className="font-mono text-[9px] text-neutral-600">
            {isConnected ? 'WebSocket' : 'Disconnected'}
          </span>
        </div>

        {/* Entries */}
        <div
          className="px-3 py-2 space-y-0.5 overflow-y-auto"
          style={maxHeight ? { maxHeight } : undefined}
        >
          {visibleEntries.length === 0 ? (
            <div className="flex items-center justify-center h-[200px]">
              <p className="text-neutral-500 text-sm font-mono">
                {isConnected
                  ? 'Waiting for activity...'
                  : 'Connect to see live activity'}
              </p>
            </div>
          ) : (
            visibleEntries.map((entry, i) => (
              <div
                key={`${entry.time}-${i}`}
                className="flex items-center gap-2 py-1 animate-[streamSlide_0.35s_ease-out]"
              >
                <Badge
                  variant={badgeVariantMap[entry.type] ?? 'ghost'}
                  className="text-[8px] px-1.5 py-0"
                >
                  {entry.type}
                </Badge>
                <span className="font-mono text-[10px] text-neutral-400 truncate flex-1">
                  {entry.actor} &middot; {entry.table}
                </span>
                <span className="font-mono text-[9px] text-neutral-600">
                  {entry.time}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    );
  }
);
LiveActivityFeed.displayName = 'LiveActivityFeed';

export { LiveActivityFeed };
