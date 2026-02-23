'use client';

import { cva, type VariantProps } from 'class-variance-authority';
import { type ComponentPropsWithoutRef, forwardRef } from 'react';
import { cn } from '../lib/cn';

const spinnerVariants = cva('animate-spin text-neutral-500', {
  variants: {
    size: {
      sm: 'h-3 w-3',
      md: 'h-5 w-5',
      lg: 'h-8 w-8',
    },
  },
  defaultVariants: {
    size: 'md',
  },
});

type SpinnerProps = Omit<ComponentPropsWithoutRef<'svg'>, 'children'> &
  VariantProps<typeof spinnerVariants>;

const Spinner = forwardRef<SVGSVGElement, SpinnerProps>(
  ({ className, size, ...props }, ref) => (
    <svg
      ref={ref}
      className={cn(spinnerVariants({ size, className }))}
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      {...props}
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
  )
);
Spinner.displayName = 'Spinner';

export { Spinner, spinnerVariants };
export type { SpinnerProps };
