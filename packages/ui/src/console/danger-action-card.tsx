'use client';

import { cn } from '../lib/cn';
import { Button } from '../primitives/button';
import { Card, CardContent } from '../primitives/card';

export interface DangerActionCardProps {
  actionLabel?: string;
  className?: string;
  description?: string;
  onAction?: () => void;
  stats?: React.ReactNode;
  title: string;
}

export function DangerActionCard({
  actionLabel = 'Confirm',
  className,
  description,
  onAction,
  stats,
  title,
}: DangerActionCardProps) {
  return (
    <Card className={cn('border-offline/20', className)}>
      <CardContent className="flex flex-col gap-3">
        <h3 className="font-mono text-[10px] text-offline uppercase tracking-widest">
          {title}
        </h3>
        {description ? (
          <p className="font-mono text-[10px] text-neutral-500">
            {description}
          </p>
        ) : null}
        {stats ? <div>{stats}</div> : null}
        {onAction ? (
          <Button
            variant="destructive"
            className="self-start"
            onClick={onAction}
          >
            {actionLabel}
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}
