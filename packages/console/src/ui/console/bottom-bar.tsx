'use client';

import { type ComponentPropsWithoutRef, forwardRef } from 'react';
import { cn } from '../lib/cn';

export type BottomBarMetric = {
  label: string;
  value: string;
};

export type BottomBarProps = ComponentPropsWithoutRef<'div'> & {
  metrics?: BottomBarMetric[];
  uptime?: string;
  isLive?: boolean;
};

const BottomBar = forwardRef<HTMLDivElement, BottomBarProps>(
  ({ className, metrics = [], uptime, isLive = true, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        'fixed bottom-0 left-0 right-0 z-100 h-8 border-t border-border bg-surface/92 backdrop-blur-lg flex items-center justify-between px-5',
        className
      )}
      {...props}
    >
      {/* Left: heartbeat + live indicator */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-[2px]">
          {[0, 0.1, 0.2, 0.3, 0.4].map((delay) => (
            <div
              key={delay}
              className="w-0.5 h-1.5 bg-healthy rounded-sm animate-[heartbeat_1.2s_ease-in-out_infinite]"
              style={{ animationDelay: `${delay}s` }}
            />
          ))}
        </div>
        {isLive && (
          <span className="font-mono text-[9px] text-healthy uppercase tracking-widest">
            Live
          </span>
        )}
      </div>

      {/* Center: metrics */}
      <div className="flex items-center gap-6">
        {metrics.map((m) => (
          <div key={m.label} className="flex items-center gap-1.5">
            <span className="font-mono text-[9px] text-neutral-600">
              {m.label}
            </span>
            <span className="font-mono text-[10px] text-neutral-300">
              {m.value}
            </span>
          </div>
        ))}
      </div>

      {/* Right: uptime */}
      {uptime != null && (
        <div className="flex items-center gap-2">
          <span className="font-mono text-[9px] text-neutral-600">UPTIME</span>
          <span className="font-mono text-[10px] text-neutral-400">
            {uptime}
          </span>
        </div>
      )}
    </div>
  )
);
BottomBar.displayName = 'BottomBar';

export { BottomBar };
