'use client';

import { cn } from '../lib/cn';
import type { SyncClient } from '../lib/types';
import { Card, CardContent } from '../primitives/card';
import { Spinner } from '../primitives/spinner';

export interface TopologyCardProps {
  clients: SyncClient[];
  emptyMessage?: string;
  isLoading?: boolean;
  relayLabel?: string;
}

export function TopologyCard({
  clients,
  emptyMessage = 'No clients connected',
  isLoading,
  relayLabel,
}: TopologyCardProps) {
  return (
    <Card>
      <CardContent className={cn('min-h-[280px] flex flex-col')}>
        {relayLabel ? (
          <span className="text-xs text-neutral-500 mb-2">{relayLabel}</span>
        ) : null}

        {isLoading ? (
          <div className="flex flex-1 items-center justify-center">
            <Spinner size="lg" />
          </div>
        ) : clients.length === 0 ? (
          <div className="flex flex-1 items-center justify-center">
            <p className="text-sm text-neutral-500">{emptyMessage}</p>
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center">
            {/* Placeholder for SVG topology visualization */}
            <div className="text-xs text-neutral-500">
              {clients.length} client{clients.length !== 1 ? 's' : ''} connected
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
