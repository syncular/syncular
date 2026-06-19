'use client';

import { type ComponentPropsWithoutRef, forwardRef } from 'react';
import { cn } from '../lib/cn';
import type { SyncClientNode } from '../lib/types';
import { Badge } from '../primitives/badge';

export type FleetCardProps = ComponentPropsWithoutRef<'div'> & {
  client: SyncClientNode;
  headSeq: number;
  onEvict?: () => void;
};

function getLagColor(lag: number) {
  if (lag === 0) return '#22c55e';
  if (lag < 10) return '#f59e0b';
  if (lag < 50) return '#f97316';
  return '#ef4444';
}

const statusBadgeVariant = {
  online: 'healthy',
  syncing: 'syncing',
  offline: 'offline',
} as const;

const modeBadgeVariant = {
  realtime: 'flow',
  polling: 'ghost',
} as const;

const FleetCard = forwardRef<HTMLDivElement, FleetCardProps>(
  ({ className, client, headSeq, onEvict, ...props }, ref) => {
    const lag = Math.max(0, headSeq - client.cursor);
    const pct = Math.min(100, (client.cursor / headSeq) * 100);
    const lagColor = getLagColor(lag);

    return (
      <div
        ref={ref}
        className={cn(
          'bg-panel border border-border rounded-lg hover:border-border-bright transition',
          className
        )}
        style={{ borderLeft: `3px solid ${lagColor}` }}
        {...props}
      >
        {/* Header */}
        <div className="px-3.5 py-2 border-b border-border flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <span
              className="font-mono text-[11px] text-white truncate"
              title={client.id}
            >
              {client.id.length > 14
                ? `${client.id.substring(0, 14)}\u2026`
                : client.id}
            </span>
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <Badge variant={statusBadgeVariant[client.status]}>
              {client.status}
            </Badge>
            <Badge variant={modeBadgeVariant[client.mode]}>{client.mode}</Badge>
          </div>
        </div>

        {/* Body */}
        <div className="p-3 space-y-3">
          {/* Progress bar */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="font-mono text-[9px] text-neutral-600">
                #{client.cursor.toLocaleString()}
              </span>
              <span className="font-mono text-[9px] text-neutral-600">
                #{headSeq.toLocaleString()}
              </span>
            </div>
            <div className="h-1 rounded-full bg-surface">
              <div
                className="h-full rounded-full transition-all"
                style={{ width: `${pct}%`, background: lagColor }}
              />
            </div>
            <div
              className="font-mono text-[9px] mt-1"
              style={{ color: lagColor }}
            >
              {lag === 0 ? 'Caught up' : `${lag} behind`}
            </div>
          </div>

          {/* Details */}
          <div className="space-y-1">
            <DetailRow label="Actor" value={client.actor} />
            <DetailRow label="Dialect" value={client.dialect} />
            <DetailRow label="Last seen" value={client.lastSeen} />
            <div className="flex justify-between items-start">
              <span className="font-mono text-[9px] text-neutral-600">
                Scopes
              </span>
              <div className="flex gap-1 flex-wrap justify-end">
                {client.scopes.slice(0, 2).map((s) => (
                  <Badge key={s} variant="ghost">
                    {s}
                  </Badge>
                ))}
                {client.scopes.length > 2 && (
                  <span className="font-mono text-[9px] text-neutral-600">
                    +{client.scopes.length - 2}
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Evict button */}
          {onEvict && (
            <button
              type="button"
              onClick={onEvict}
              className="w-full inline-flex items-center justify-center gap-1.5 rounded-md font-mono text-[9px] px-2 py-1 border border-offline/25 bg-offline/[0.04] text-offline hover:border-offline hover:bg-offline/[0.08] cursor-pointer transition-all"
            >
              <svg
                className="w-3 h-3"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                viewBox="0 0 24 24"
              >
                <path d="M18.36 6.64a9 9 0 11-12.73 0" />
                <line x1="12" y1="2" x2="12" y2="12" />
              </svg>
              Evict
            </button>
          )}
        </div>
      </div>
    );
  }
);
FleetCard.displayName = 'FleetCard';

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <span className="font-mono text-[9px] text-neutral-600">{label}</span>
      <span className="font-mono text-[10px] text-neutral-400">{value}</span>
    </div>
  );
}

export { FleetCard };
