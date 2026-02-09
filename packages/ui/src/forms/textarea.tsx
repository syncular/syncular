'use client';

import { type ComponentPropsWithoutRef, forwardRef } from 'react';
import { cn } from '../lib/cn';

type TextareaProps = ComponentPropsWithoutRef<'textarea'>;

const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        'bg-surface border border-border rounded-md px-3 py-2 font-mono text-[12px] text-foreground outline-none w-full transition focus:border-flow placeholder:text-neutral-600 resize-none min-h-[80px]',
        className
      )}
      {...props}
    />
  )
);
Textarea.displayName = 'Textarea';

export { Textarea };
export type { TextareaProps };
