'use client';

import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

export interface DemoSectionProps {
  active: boolean;
  children: ReactNode;
  className?: string;
}

export function DemoSection({ active, children, className }: DemoSectionProps) {
  return (
    <div
      className={cn(className)}
      style={{
        display: active ? 'block' : 'none',
        animation: active ? 'pageIn 0.3s ease-out' : undefined,
      }}
    >
      {children}
    </div>
  );
}
