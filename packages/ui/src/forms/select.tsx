'use client';

import { Select as BaseSelect } from '@base-ui/react/select';
import { type ComponentPropsWithoutRef, forwardRef } from 'react';
import { cn } from '../lib/cn';

const Select = BaseSelect.Root;

const SelectTrigger = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<typeof BaseSelect.Trigger>
>(({ className, children, ...props }, ref) => (
  <BaseSelect.Trigger
    ref={ref}
    className={cn(
      'inline-flex items-center justify-between bg-surface border border-border rounded-md px-3 py-1.5 font-mono text-[12px] text-foreground cursor-pointer hover:border-border-bright transition',
      className
    )}
    {...props}
  >
    {children}
  </BaseSelect.Trigger>
));
SelectTrigger.displayName = 'SelectTrigger';

const SelectValue = BaseSelect.Value;

const SelectContent = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof BaseSelect.Popup> & {
    portalProps?: ComponentPropsWithoutRef<typeof BaseSelect.Portal>;
    positionerProps?: ComponentPropsWithoutRef<typeof BaseSelect.Positioner>;
  }
>(({ className, portalProps, positionerProps, ...props }, ref) => (
  <BaseSelect.Portal {...portalProps}>
    <BaseSelect.Positioner {...positionerProps}>
      <BaseSelect.Popup
        ref={ref}
        className={cn(
          'bg-panel border border-border rounded-md py-1 shadow-lg z-50',
          className
        )}
        {...props}
      />
    </BaseSelect.Positioner>
  </BaseSelect.Portal>
));
SelectContent.displayName = 'SelectContent';

const SelectItem = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof BaseSelect.Item>
>(({ className, ...props }, ref) => (
  <BaseSelect.Item
    ref={ref}
    className={cn(
      'font-mono text-[11px] px-3 py-1.5 text-neutral-400 cursor-pointer hover:bg-white/[0.03] hover:text-white data-[highlighted]:bg-white/[0.03] data-[highlighted]:text-white outline-none',
      className
    )}
    {...props}
  />
));
SelectItem.displayName = 'SelectItem';

export { Select, SelectTrigger, SelectValue, SelectContent, SelectItem };
