'use client';

import { type ComponentPropsWithoutRef, forwardRef } from 'react';
import { cn } from '../lib/cn';
import type { MetricItem } from '../lib/types';

export type KpiStripProps = ComponentPropsWithoutRef<'div'> & {
  items: MetricItem[];
};

const dotColorMap: Record<string, string> = {
  flow: 'bg-flow',
  healthy: 'bg-healthy',
  syncing: 'bg-syncing',
  offline: 'bg-offline',
  relay: 'bg-relay',
  muted: 'bg-neutral-500',
};

const KpiStrip = forwardRef<HTMLDivElement, KpiStripProps>(
  ({ className, items, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        'border-b border-border px-6 py-3 flex items-center justify-between flex-wrap gap-4',
        'bg-[linear-gradient(to_bottom,rgba(17,17,17,0.8),#0c0c0c)]',
        className
      )}
      {...props}
    >
      {items.map((item, i) => (
        <MetricInlineItem key={item.label} item={item} showDivider={i > 0} />
      ))}
    </div>
  )
);
KpiStrip.displayName = 'KpiStrip';

function MetricInlineItem({
  item,
  showDivider,
}: {
  item: MetricItem;
  showDivider: boolean;
}) {
  const dotClass = dotColorMap[item.color ?? 'muted'] ?? 'bg-neutral-500';

  return (
    <>
      {showDivider && <div className="w-px h-4 bg-border" />}
      <div className="flex items-center gap-2">
        <span className={cn('w-1.5 h-1.5 rounded-full', dotClass)} />
        <span className="font-mono text-[10px] text-neutral-500 uppercase">
          {item.label}
        </span>
        <span className="font-mono text-sm text-white font-semibold">
          {item.value}
          {item.unit && (
            <span className="text-xs text-neutral-600">{item.unit}</span>
          )}
        </span>
        {item.trend && (
          <span
            className={cn(
              'font-mono text-[10px]',
              item.trend.startsWith('+') ? 'text-healthy' : 'text-offline'
            )}
          >
            {item.trend}
          </span>
        )}
      </div>
    </>
  );
}

export { KpiStrip };
