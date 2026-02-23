'use client';

import { Tabs as BaseTabs } from '@base-ui/react/tabs';
import { cva, type VariantProps } from 'class-variance-authority';
import { type ComponentPropsWithoutRef, forwardRef } from 'react';
import { cn } from '../lib/cn';

const Tabs = BaseTabs.Root;

const TabsList = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof BaseTabs.List>
>(({ className, ...props }, ref) => (
  <BaseTabs.List
    ref={ref}
    className={cn('flex items-center gap-0.5', className)}
    {...props}
  />
));
TabsList.displayName = 'TabsList';

const tabsTriggerVariants = cva(
  'inline-flex items-center justify-center cursor-pointer transition-all outline-none',
  {
    variants: {
      variant: {
        default:
          'font-mono text-[10px] text-neutral-500 border border-transparent rounded-sm px-2.5 py-1 hover:text-neutral-300 data-[selected]:text-white data-[selected]:border-border-bright data-[selected]:bg-white/[0.03]',
        pills:
          'font-mono text-[10px] text-neutral-500 border border-transparent rounded-full px-3 py-1 hover:text-neutral-300 data-[selected]:text-white data-[selected]:border-border-bright data-[selected]:bg-white/[0.03]',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
);

type TabsTriggerProps = ComponentPropsWithoutRef<typeof BaseTabs.Tab> &
  VariantProps<typeof tabsTriggerVariants>;

const TabsTrigger = forwardRef<HTMLButtonElement, TabsTriggerProps>(
  ({ className, variant, ...props }, ref) => (
    <BaseTabs.Tab
      ref={ref}
      className={cn(tabsTriggerVariants({ variant, className }))}
      {...props}
    />
  )
);
TabsTrigger.displayName = 'TabsTrigger';

const TabsContent = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof BaseTabs.Panel>
>(({ className, ...props }, ref) => (
  <BaseTabs.Panel
    ref={ref}
    className={cn('outline-none', className)}
    {...props}
  />
));
TabsContent.displayName = 'TabsContent';

export { Tabs, TabsList, TabsTrigger, tabsTriggerVariants, TabsContent };
export type { TabsTriggerProps };
