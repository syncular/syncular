'use client';

import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

export interface TaskItemProps {
  checked: boolean;
  text: string;
  meta?: string;
  trailing?: ReactNode;
  onToggle?: () => void;
  onDelete?: () => void;
  className?: string;
}

export function TaskItem({
  checked,
  text,
  meta,
  trailing,
  onToggle,
  onDelete,
  className,
}: TaskItemProps) {
  return (
    <div
      className={cn(
        'group flex items-center gap-3 px-3 h-10 border-b border-[#161616] transition-colors relative',
        'before:absolute before:left-0 before:top-[20%] before:bottom-[20%] before:w-[2px] before:bg-transparent before:transition-colors',
        'hover:bg-white/[0.018] hover:before:bg-flow',
        className
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          'h-[15px] w-[15px] rounded-full border-[1.5px] flex-shrink-0 flex items-center justify-center transition-all duration-200',
          'hover:scale-[1.15]',
          checked
            ? 'bg-healthy border-healthy shadow-[0_0_6px_rgba(34,197,94,0.3)]'
            : 'border-neutral-700 hover:border-neutral-500'
        )}
      >
        {checked ? (
          <svg width="8" height="8" viewBox="0 0 12 12" fill="none">
            <path
              d="M2.5 6L5 8.5L9.5 3.5"
              stroke="white"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : null}
      </button>
      <span
        className={cn(
          'text-[12.5px] leading-relaxed flex-1 truncate',
          checked
            ? 'line-through text-neutral-700 decoration-neutral-700'
            : 'text-neutral-400'
        )}
      >
        {text}
      </span>
      {trailing}
      {meta ? (
        <span className="font-mono text-[9px] text-neutral-700">{meta}</span>
      ) : null}
      {onDelete ? (
        <button
          type="button"
          onClick={onDelete}
          className="opacity-0 group-hover:opacity-100 text-neutral-600 hover:text-offline transition-all text-xs"
          aria-label="Delete"
        >
          ×
        </button>
      ) : null}
    </div>
  );
}
