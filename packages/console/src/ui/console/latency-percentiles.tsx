'use client';

import { type ComponentPropsWithoutRef, forwardRef } from 'react';
import { cn } from '../lib/cn';

export type LatencyBucket = {
  label: string;
  pushMs: number;
  pullMs: number;
  /** Bar height as a percent (0-100) for push */
  pushBarPercent: number;
  /** Bar height as a percent (0-100) for pull */
  pullBarPercent: number;
};

export type LatencyPercentilesBarProps = ComponentPropsWithoutRef<'div'> & {
  buckets: LatencyBucket[];
  /** Success rate 0-100 */
  successRate?: number;
  successLabel?: string;
};

const LatencyPercentilesBar = forwardRef<
  HTMLDivElement,
  LatencyPercentilesBarProps
>(
  (
    {
      className,
      buckets,
      successRate = 99.6,
      successLabel = 'success',
      ...props
    },
    ref
  ) => {
    const dashLength = (successRate / 100) * 88;
    const gapLength = 88 - dashLength;

    return (
      <div
        ref={ref}
        className={cn(
          'px-5 py-3 border-b border-border flex items-center gap-8',
          className
        )}
        {...props}
      >
        <span className="font-mono text-[10px] text-neutral-500 uppercase tracking-widest">
          Latency
        </span>
        <div className="flex items-center gap-6">
          {buckets.map((b) => (
            <div key={b.label} className="flex items-center gap-2">
              <span className="font-mono text-[9px] text-neutral-500">
                {b.label}
              </span>
              <div className="flex gap-1 items-end h-5">
                <div
                  className="w-3 rounded-t bg-healthy/60"
                  style={{ height: `${b.pushBarPercent}%` }}
                />
                <div
                  className="w-3 rounded-t bg-flow/60"
                  style={{ height: `${b.pullBarPercent}%` }}
                />
              </div>
              <span className="font-mono text-[10px] text-neutral-400">
                {b.pushMs} / {b.pullMs}ms
              </span>
            </div>
          ))}
        </div>

        {/* Donut */}
        <div className="flex items-center gap-2 ml-auto">
          <svg viewBox="0 0 36 36" className="w-7 h-7">
            <circle
              cx={18}
              cy={18}
              r={14}
              fill="none"
              stroke="#1e1e1e"
              strokeWidth={4}
            />
            <circle
              cx={18}
              cy={18}
              r={14}
              fill="none"
              stroke="#22c55e"
              strokeWidth={4}
              strokeDasharray={`${dashLength} ${gapLength}`}
              transform="rotate(-90 18 18)"
              strokeLinecap="round"
            />
          </svg>
          <span className="font-mono text-[10px] text-neutral-400">
            {successRate}%{' '}
            <span className="text-neutral-600">{successLabel}</span>
          </span>
        </div>
      </div>
    );
  }
);
LatencyPercentilesBar.displayName = 'LatencyPercentilesBar';

export { LatencyPercentilesBar };
