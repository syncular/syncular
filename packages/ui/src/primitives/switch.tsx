'use client';

import { Switch as BaseSwitch } from '@base-ui/react/switch';
import { type ComponentPropsWithoutRef, forwardRef } from 'react';
import { cn } from '../lib/cn';

type SwitchProps = ComponentPropsWithoutRef<typeof BaseSwitch.Root>;

const Switch = forwardRef<HTMLButtonElement, SwitchProps>(
  ({ className, ...props }, ref) => (
    <BaseSwitch.Root
      ref={ref}
      className={cn(
        'relative w-[34px] h-[18px] bg-border-bright rounded-full cursor-pointer transition data-[checked]:bg-healthy',
        className
      )}
      {...props}
    >
      <BaseSwitch.Thumb className="block w-[14px] h-[14px] bg-white rounded-full transition-transform data-[checked]:translate-x-4 absolute top-0.5 left-0.5" />
    </BaseSwitch.Root>
  )
);
Switch.displayName = 'Switch';

export { Switch };
export type { SwitchProps };
