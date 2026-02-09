'use client';

import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

export interface InfoPanelProps {
  icon: ReactNode;
  title: string;
  description: ReactNode;
  className?: string;
}

export function InfoPanel({
  icon,
  title,
  description,
  className,
}: InfoPanelProps) {
  return (
    <div
      className={cn(
        'rounded-[10px] border border-border bg-panel p-6',
        className
      )}
    >
      <div className="flex items-start gap-6">
        <div className="w-10 h-10 rounded-lg bg-flow/10 border border-flow/20 flex items-center justify-center flex-shrink-0">
          {icon}
        </div>
        <div>
          <h3 className="font-display font-semibold text-white text-sm mb-1">
            {title}
          </h3>
          <p className="text-neutral-400 text-sm leading-relaxed max-w-2xl">
            {description}
          </p>
        </div>
      </div>
    </div>
  );
}
