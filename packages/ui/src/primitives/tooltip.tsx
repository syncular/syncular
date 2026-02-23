'use client';

import { Tooltip as BaseTooltip } from '@base-ui/react/tooltip';
import {
  type ComponentPropsWithoutRef,
  forwardRef,
  type ReactNode,
} from 'react';
import { cn } from '../lib/cn';

const Tooltip = BaseTooltip.Root;

const TooltipTrigger = BaseTooltip.Trigger;

const TooltipContent = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof BaseTooltip.Popup> & {
    sideOffset?: number;
  }
>(({ className, sideOffset = 4, children, ...props }, ref) => (
  <BaseTooltip.Portal>
    <BaseTooltip.Positioner sideOffset={sideOffset}>
      <BaseTooltip.Popup
        ref={ref}
        className={cn(
          'bg-[#1e1e1e] border border-neutral-700 rounded-md px-2.5 py-1.5 text-xs text-neutral-300 font-mono shadow-lg',
          className
        )}
        {...props}
      >
        {children}
      </BaseTooltip.Popup>
    </BaseTooltip.Positioner>
  </BaseTooltip.Portal>
));
TooltipContent.displayName = 'TooltipContent';

/** @base-ui doesn't need a provider - this is a passthrough for backward compat */
function TooltipProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
