'use client';

import { forwardRef } from 'react';
import { cn } from '../lib/cn';
import type { ObservableClient } from './types';

export interface ConnectedClientsPanelProps {
  clients: ObservableClient[];
  className?: string;
}

function formatSyncTime(client: ObservableClient) {
  if (client.status === 'syncing') {
    return `pushing ${client.syncingCommits ?? 0} commits...`;
  }
  if (client.lastSync === 0) return 'just now';
  if (client.lastSync < 60) return `${client.lastSync}s ago`;
  return `${Math.floor(client.lastSync / 60)}m ago`;
}

function statusDotChar(status: ObservableClient['status']) {
  if (status === 'online') return '\u25CF';
  if (status === 'syncing') return '\u25D0';
  return '\u25CB';
}

const statusDotClass: Record<ObservableClient['status'], string> = {
  online: 'text-healthy',
  syncing: 'text-syncing animate-[dotPulse_1s_ease-in-out_infinite]',
  offline: 'text-offline',
};

const statusTextClass: Record<ObservableClient['status'], string> = {
  online: 'text-emerald-500',
  syncing: 'text-amber-500',
  offline: 'text-red-500',
};

export const ConnectedClientsPanel = forwardRef<
  HTMLDivElement,
  ConnectedClientsPanelProps
>(function ConnectedClientsPanel({ clients, className }, ref) {
  return (
    <div
      ref={ref}
      className={cn('dashboard-panel rounded-lg flex flex-col', className)}
    >
      <div className="px-4 py-3 border-b border-border flex items-center justify-between">
        <span className="font-mono text-[11px] text-neutral-400 uppercase tracking-wider">
          Connected Clients
        </span>
        <span className="font-mono text-[11px] text-neutral-600">
          {clients.length} nodes
        </span>
      </div>
      <div className="flex-1 overflow-auto p-2 space-y-1">
        {clients.map((client) => (
          <div
            key={client.id}
            className="flex items-start gap-3 px-3 py-2.5 rounded hover:bg-white/[0.02] transition-colors"
          >
            <span
              className={cn(
                'font-mono text-sm mt-0.5 shrink-0',
                statusDotClass[client.status]
              )}
            >
              {statusDotChar(client.status)}
            </span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-white truncate">
                  {client.id}
                </span>
                <span className="font-mono text-[10px] text-neutral-600">
                  ({client.type})
                </span>
                {client.via === 'relay' ? (
                  <span className="font-mono text-[9px] text-violet-400/60 border border-violet-400/20 rounded px-1 ml-1">
                    relay
                  </span>
                ) : null}
              </div>
              <div className="flex items-center gap-3 mt-0.5">
                <span
                  className={cn(
                    'font-mono text-[10px]',
                    statusTextClass[client.status]
                  )}
                >
                  {client.status}
                </span>
                <span className="font-mono text-[10px] text-neutral-600">
                  sync: {formatSyncTime(client)}
                </span>
              </div>
              <div className="font-mono text-[10px] text-neutral-600 mt-0.5">
                commits:{' '}
                <span className="text-neutral-400">
                  {client.commits.toLocaleString()}
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
});
