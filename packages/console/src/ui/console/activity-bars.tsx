'use client';

import { type ComponentPropsWithoutRef, forwardRef } from 'react';
import { cn } from '../lib/cn';

export type ActivityBarData = {
  pushPercent: number;
  pullPercent: number;
};

export type ActivityTimeRange = '1h' | '6h' | '24h' | '7d';

export type ActivityBarsProps = ComponentPropsWithoutRef<'div'> & {
  bars: ActivityBarData[];
  activeRange?: ActivityTimeRange;
  onRangeChange?: (range: ActivityTimeRange) => void;
  startLabel?: string;
  midLabel?: string;
  endLabel?: string;
};

const ranges: ActivityTimeRange[] = ['1h', '6h', '24h', '7d'];

const ActivityBars = forwardRef<HTMLDivElement, ActivityBarsProps>(
  (
    {
      className,
      bars,
      activeRange = '1h',
      onRangeChange,
      startLabel = '-1h',
      midLabel = '-30m',
      endLabel = 'now',
      ...props
    },
    ref
  ) => (
    <div
      ref={ref}
      className={cn('px-5 pt-4 pb-3 border-b border-border', className)}
      {...props}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <span className="font-mono text-[10px] text-neutral-500 uppercase tracking-widest">
          Activity
        </span>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-sm bg-healthy/70" />
            <span className="font-mono text-[9px] text-neutral-500">Push</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-sm bg-flow/70" />
            <span className="font-mono text-[9px] text-neutral-500">Pull</span>
          </div>
          <div className="flex gap-0.5 ml-2">
            {ranges.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => onRangeChange?.(r)}
                className={cn(
                  'font-mono text-[9px] border rounded-sm px-1.5 py-0.5 cursor-pointer transition-all',
                  r === activeRange
                    ? 'text-white border-border-bright bg-white/[0.03]'
                    : 'text-neutral-500 border-transparent hover:text-neutral-300'
                )}
              >
                {r}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Bars */}
      <div className="flex items-end gap-[2px] h-16">
        {bars.map((bar, i) => (
          <div
            key={i}
            className="flex-1 flex flex-col gap-[1px] h-16 justify-end"
          >
            <div
              className="bg-flow/60 rounded-t-sm min-h-[2px]"
              style={{ height: `${bar.pullPercent}%` }}
            />
            <div
              className="bg-healthy/60 rounded-t-sm min-h-[2px]"
              style={{ height: `${bar.pushPercent}%` }}
            />
          </div>
        ))}
      </div>

      {/* Time labels */}
      <div className="flex justify-between mt-1.5">
        <span className="font-mono text-[8px] text-neutral-600">
          {startLabel}
        </span>
        <span className="font-mono text-[8px] text-neutral-600">
          {midLabel}
        </span>
        <span className="font-mono text-[8px] text-neutral-600">
          {endLabel}
        </span>
      </div>
    </div>
  )
);
ActivityBars.displayName = 'ActivityBars';

export { ActivityBars };
