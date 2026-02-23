'use client';

import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

export type ClientPanelColor =
  | 'flow'
  | 'relay'
  | 'healthy'
  | 'syncing'
  | 'encrypt';

const colorMap: Record<ClientPanelColor, string> = {
  flow: 'bg-flow',
  relay: 'bg-relay',
  healthy: 'bg-healthy',
  syncing: 'bg-syncing',
  encrypt: 'bg-encrypt',
};

export interface ClientPanelProps {
  label: string;
  color: ClientPanelColor;
  status?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function ClientPanel({
  label,
  color,
  status,
  footer,
  children,
  className,
}: ClientPanelProps) {
  return (
    <div
      className={cn('rounded-[10px] border border-border bg-panel', className)}
    >
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
        <div className="flex items-center gap-2">
          <div className={cn('w-2 h-2 rounded-full', colorMap[color])} />
          <span className="font-mono text-[10px] uppercase tracking-[1.5px] text-neutral-500">
            {label}
          </span>
        </div>
        {status ? (
          <div className="flex items-center gap-2">{status}</div>
        ) : null}
      </div>
      <div className="p-3">{children}</div>
      {footer ? (
        <div className="border-t border-border px-3 py-2 flex items-center justify-between">
          {footer}
        </div>
      ) : null}
    </div>
  );
}
