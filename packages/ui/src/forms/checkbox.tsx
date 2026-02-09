'use client';

import { Checkbox as BaseCheckbox } from '@base-ui/react/checkbox';
import { type ComponentPropsWithoutRef, forwardRef } from 'react';
import { cn } from '../lib/cn';

type CheckboxProps = ComponentPropsWithoutRef<typeof BaseCheckbox.Root> & {
  label?: string;
};

const Checkbox = forwardRef<HTMLElement, CheckboxProps>(
  ({ className, label, ...props }, ref) => {
    const checkbox = (
      <BaseCheckbox.Root
        ref={ref}
        className={cn(
          'w-[15px] h-[15px] border-[1.5px] border-neutral-700 rounded-full flex items-center justify-center cursor-pointer transition-all duration-200',
          'data-[checked]:bg-healthy data-[checked]:border-healthy data-[checked]:shadow-[0_0_6px_rgba(34,197,94,0.3)]',
          className
        )}
        {...props}
      >
        <BaseCheckbox.Indicator className="flex items-center justify-center text-white">
          <svg
            width="8"
            height="8"
            viewBox="0 0 8 8"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              d="M1.5 4L3.25 5.75L6.5 2.25"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </BaseCheckbox.Indicator>
      </BaseCheckbox.Root>
    );

    if (label) {
      return (
        <span className="inline-flex items-center gap-2 cursor-pointer font-mono text-[11px] text-neutral-400">
          {checkbox}
          <span>{label}</span>
        </span>
      );
    }

    return checkbox;
  }
);
Checkbox.displayName = 'Checkbox';

export { Checkbox };
export type { CheckboxProps };
