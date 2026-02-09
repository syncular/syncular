'use client';

import type { ReactNode } from 'react';
import { cn } from '../lib/cn';
import { UI_VERSION } from '../version';

export interface DemoHeaderProps {
  title: string;
  subtitle: string;
  right?: ReactNode;
  className?: string;
}

export function DemoHeader({
  title,
  subtitle,
  right,
  className,
}: DemoHeaderProps) {
  const versionBadge = (
    <span className="font-mono text-[10px] text-neutral-600 border border-border rounded px-2 py-0.5">
      v{UI_VERSION}
    </span>
  );

  return (
    <div className={cn('flex items-center justify-between mb-5', className)}>
      <div>
        <h2 className="font-display font-semibold text-lg text-white">
          {title}
        </h2>
        <p className="font-mono text-[11px] text-neutral-500 mt-0.5">
          {subtitle}
        </p>
      </div>
      {right || versionBadge ? (
        <div className="flex items-center gap-3">
          {versionBadge}
          {right}
        </div>
      ) : null}
    </div>
  );
}
