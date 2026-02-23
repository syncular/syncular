'use client';

import { forwardRef } from 'react';
import { cn } from '../lib/cn';

export interface FooterBarProps {
  className?: string;
}

export const FooterBar = forwardRef<HTMLElement, FooterBarProps>(
  function FooterBar({ className }, ref) {
    return (
      <footer
        ref={ref}
        className={cn('border-t border-border py-10', className)}
      >
        <div className="max-w-[1400px] mx-auto px-6 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="font-display font-bold text-white text-sm">
              syncular
            </span>
            <span
              className="w-1.5 h-1.5 rounded-full bg-healthy inline-block"
              style={{ boxShadow: '0 0 4px #22c55e' }}
            />
          </div>
          <div className="font-mono text-[11px] text-neutral-600">
            Offline-first sync for SQLite. Open source.
          </div>
        </div>
      </footer>
    );
  }
);
