'use client';

import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

export type NavPillProps = {
  active?: boolean;
  onClick?: () => void;
  children: ReactNode;
  className?: string;
};

export function NavPill({
  active,
  onClick,
  children,
  className,
}: NavPillProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'font-mono text-[10px] tracking-[1.5px] uppercase bg-transparent border-none px-3.5 py-1 cursor-pointer relative transition-colors',
        active ? 'text-white' : 'text-neutral-500 hover:text-neutral-300',
        className
      )}
    >
      {children}
      {active && (
        <span className="absolute -bottom-2.5 left-1/2 -translate-x-1/2 w-4 h-0.5 bg-flow rounded-sm shadow-[0_0_8px_rgba(59,130,246,0.5)]" />
      )}
    </button>
  );
}
