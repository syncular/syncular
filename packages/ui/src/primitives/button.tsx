'use client';

import { cva, type VariantProps } from 'class-variance-authority';
import { type ComponentPropsWithoutRef, forwardRef } from 'react';
import { cn } from '../lib/cn';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 rounded-md font-mono transition-all cursor-pointer disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default:
          'border border-border-bright bg-transparent text-neutral-400 hover:text-white hover:bg-white/[0.03]',
        primary: 'border border-flow bg-flow/10 text-flow hover:bg-flow/20',
        destructive:
          'border border-offline bg-offline/10 text-offline hover:bg-offline/20',
        ghost:
          'border border-transparent bg-transparent text-neutral-400 hover:text-white hover:bg-white/[0.03]',
        link: 'border border-transparent bg-transparent text-neutral-400 underline underline-offset-4 hover:text-white',
        secondary:
          'border border-border bg-panel text-neutral-400 hover:text-white hover:bg-white/[0.03]',
      },
      size: {
        sm: 'text-[10px] px-2.5 py-1',
        md: 'text-[11px] px-3.5 py-1.5',
        icon: 'h-8 w-8',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'md',
    },
  }
);

type ButtonProps = ComponentPropsWithoutRef<'button'> &
  VariantProps<typeof buttonVariants>;

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button
      ref={ref}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
);
Button.displayName = 'Button';

export { Button, buttonVariants };
export type { ButtonProps };
