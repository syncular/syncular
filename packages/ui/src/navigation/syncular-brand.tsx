'use client';

import { cn } from '../lib/cn';
import { UI_VERSION } from '../version';
import { StatusDot } from './status-dot';

export type SyncularBrandProps = {
  label?: string;
  className?: string;
};

export function SyncularBrand({ label, className }: SyncularBrandProps) {
  return (
    <div className={cn('flex items-center gap-3', className)}>
      <StatusDot color="healthy" size="md" glow />
      <span className="font-display font-bold text-white text-sm tracking-tight">
        syncular
      </span>
      {label && (
        <span className="font-mono text-[9px] text-neutral-600 uppercase tracking-widest">
          {label}
        </span>
      )}
      <span className="font-mono text-[9px] text-neutral-600 tracking-wider">
        v{UI_VERSION}
      </span>
    </div>
  );
}
