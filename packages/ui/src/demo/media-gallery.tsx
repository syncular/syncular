'use client';

import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

export interface MediaGalleryProps {
  children: ReactNode;
  className?: string;
}

export function MediaGallery({ children, className }: MediaGalleryProps) {
  return (
    <div className={cn('grid grid-cols-3 gap-2', className)}>{children}</div>
  );
}
