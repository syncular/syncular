'use client';

import type { ReactNode } from 'react';
import { cn } from '../lib/cn';
import { Card, CardContent } from '../primitives/card';

export interface PanelShellProps {
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  contentClassName?: string;
  description?: ReactNode;
  title?: ReactNode;
}

export function PanelShell({
  actions,
  children,
  className,
  contentClassName,
  description,
  title,
}: PanelShellProps) {
  return (
    <Card className={cn('border-border', className)}>
      {title || actions ? (
        <div className="flex items-start justify-between px-4 pt-4">
          <div>
            {title ? (
              <h3 className="font-mono text-[10px] text-neutral-500 uppercase tracking-widest">
                {title}
              </h3>
            ) : null}
            {description ? (
              <p className="mt-1 font-mono text-[10px] text-neutral-500">
                {description}
              </p>
            ) : null}
          </div>
          {actions ? (
            <div className="flex items-center gap-2">{actions}</div>
          ) : null}
        </div>
      ) : null}
      <CardContent className={contentClassName}>{children}</CardContent>
    </Card>
  );
}
