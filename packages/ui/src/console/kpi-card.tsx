'use client';

import type { ReactNode } from 'react';
import { cn } from '../lib/cn';
import { Card, CardContent } from '../primitives/card';

export interface KpiCardProps {
  className?: string;
  label: ReactNode;
  meta?: ReactNode;
  tone?: 'accent' | 'destructive' | 'info' | 'muted' | 'success' | 'warning';
  value: ReactNode;
}

const toneColorMap: Record<NonNullable<KpiCardProps['tone']>, string> = {
  success: 'text-healthy',
  warning: 'text-syncing',
  destructive: 'text-offline',
  info: 'text-flow',
  accent: 'text-relay',
  muted: 'text-neutral-500',
};

export function KpiCard({
  className,
  label,
  meta,
  tone = 'muted',
  value,
}: KpiCardProps) {
  return (
    <Card className={className}>
      <CardContent className="flex flex-col gap-1">
        <span className="text-xs font-mono uppercase tracking-wider text-neutral-500">
          {label}
        </span>
        <span
          className={cn('text-2xl font-bold tabular-nums', toneColorMap[tone])}
        >
          {value}
        </span>
        {meta ? <span className="text-xs text-neutral-500">{meta}</span> : null}
      </CardContent>
    </Card>
  );
}
