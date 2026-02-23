'use client';

import { Badge } from '../primitives/badge';
import { Spinner } from '../primitives/spinner';

export type ConnectionState =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'not-configured';

export interface ConnectionStatusBadgeProps {
  className?: string;
  state: ConnectionState;
}

export function ConnectionStatusBadge({
  className,
  state,
}: ConnectionStatusBadgeProps) {
  switch (state) {
    case 'connected':
      return (
        <Badge variant="healthy" className={className}>
          Connected
        </Badge>
      );
    case 'disconnected':
      return (
        <Badge variant="destructive" className={className}>
          Disconnected
        </Badge>
      );
    case 'connecting':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs text-neutral-400">
          <Spinner size="sm" />
          Connecting
        </span>
      );
    case 'not-configured':
      return (
        <Badge variant="ghost" className={className}>
          Not configured
        </Badge>
      );
  }
}
