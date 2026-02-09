'use client';

import { cn } from '../lib/cn';
import { Button } from '../primitives/button';

export interface SyncControlsProps {
  isOffline: boolean;
  onToggleOffline?: () => void;
  onReset?: () => void;
  className?: string;
}

export function SyncControls({
  isOffline,
  onToggleOffline,
  onReset,
  className,
}: SyncControlsProps) {
  return (
    <div className={cn('flex items-center gap-3', className)}>
      {onToggleOffline ? (
        <Button variant="ghost" size="sm" onClick={onToggleOffline}>
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            {isOffline ? (
              <>
                <line x1="1" y1="1" x2="23" y2="23" />
                <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55" />
                <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39" />
                <path d="M10.71 5.05A16 16 0 0 1 22.56 9" />
                <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88" />
                <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
                <line x1="12" y1="20" x2="12.01" y2="20" />
              </>
            ) : (
              <>
                <path d="M1.42 9a16 16 0 0 1 21.16 0" />
                <path d="M5 12.55a11 11 0 0 1 14.08 0" />
                <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
                <line x1="12" y1="20" x2="12.01" y2="20" />
              </>
            )}
          </svg>
          {isOffline ? 'Go Online' : 'Go Offline'}
        </Button>
      ) : null}
      {onReset ? (
        <Button variant="ghost" size="sm" onClick={onReset}>
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="23 4 23 10 17 10" />
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
          </svg>
          Reset
        </Button>
      ) : null}
    </div>
  );
}
