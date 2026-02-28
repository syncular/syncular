'use client';

import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

export interface MediaThumbnailProps {
  filename: string;
  statusColor?: string;
  bgColor?: string;
  icon?: ReactNode;
  src?: string;
  className?: string;
}

export function MediaThumbnail({
  filename,
  statusColor,
  bgColor,
  icon,
  src,
  className,
}: MediaThumbnailProps) {
  return (
    <div
      data-testid="media-thumbnail"
      className={cn(
        'relative aspect-square rounded-[6px] overflow-hidden border border-border cursor-default transition-[border-color] hover:border-border-bright',
        className
      )}
    >
      <div
        className="w-full h-full flex items-center justify-center"
        style={bgColor ? { background: bgColor } : undefined}
      >
        {src ? (
          <img
            src={src}
            alt={filename}
            className="w-full h-full object-cover"
          />
        ) : (
          icon
        )}
      </div>
      <div className="absolute bottom-0 left-0 right-0 px-1.5 py-[3px] bg-black/70 backdrop-blur-[4px] font-mono text-[8px] text-neutral-400 flex items-center justify-between">
        <span className="truncate">{filename}</span>
        {statusColor ? (
          <span
            className="w-[5px] h-[5px] rounded-full flex-shrink-0"
            style={{ background: statusColor }}
          />
        ) : null}
      </div>
    </div>
  );
}
