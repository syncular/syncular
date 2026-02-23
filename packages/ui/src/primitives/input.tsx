'use client';

import { cva, type VariantProps } from 'class-variance-authority';
import { type ComponentPropsWithoutRef, forwardRef } from 'react';
import { cn } from '../lib/cn';

const inputVariants = cva(
  'bg-surface border border-border rounded-md px-3 py-1.5 text-foreground outline-none w-full transition focus:border-flow placeholder:text-neutral-600',
  {
    variants: {
      variant: {
        default: 'font-sans text-[13px]',
        mono: 'font-mono text-[12px]',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
);

type InputProps = ComponentPropsWithoutRef<'input'> &
  VariantProps<typeof inputVariants>;

const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, variant, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(inputVariants({ variant, className }))}
      {...props}
    />
  )
);
Input.displayName = 'Input';

export { Input, inputVariants };
export type { InputProps };
