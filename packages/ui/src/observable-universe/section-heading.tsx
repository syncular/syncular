'use client';

import { forwardRef } from 'react';
import { cn } from '../lib/cn';

export interface SectionHeadingProps {
  label?: string;
  title: string;
  description?: string;
  className?: string;
}

export const SectionHeading = forwardRef<HTMLDivElement, SectionHeadingProps>(
  function SectionHeading({ label, title, description, className }, ref) {
    return (
      <div ref={ref} className={cn('max-w-2xl mb-16', className)}>
        {label ? (
          <span className="font-mono text-[11px] text-flow uppercase tracking-widest">
            {label}
          </span>
        ) : null}
        <h2 className="font-display font-bold text-2xl md:text-3xl text-white mt-4 leading-tight">
          {title}
        </h2>
        {description ? (
          <p className="text-neutral-400 mt-4 leading-relaxed">{description}</p>
        ) : null}
      </div>
    );
  }
);
