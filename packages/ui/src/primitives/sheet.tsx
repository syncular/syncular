'use client';

import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import { cva, type VariantProps } from 'class-variance-authority';
import {
  type ComponentPropsWithoutRef,
  forwardRef,
  type HTMLAttributes,
} from 'react';
import { cn } from '../lib/cn';

const Sheet = BaseDialog.Root;

const SheetTrigger = BaseDialog.Trigger;

const sheetContentVariants = cva(
  'fixed z-50 bg-panel shadow-lg overflow-auto',
  {
    variants: {
      side: {
        top: 'top-0 left-0 w-full h-[400px] border-b border-border',
        right: 'right-0 top-0 h-full w-[400px] border-l border-border',
        bottom: 'bottom-0 left-0 w-full h-[400px] border-t border-border',
        left: 'left-0 top-0 h-full w-[400px] border-r border-border',
      },
    },
    defaultVariants: {
      side: 'right',
    },
  }
);

type SheetContentProps = ComponentPropsWithoutRef<typeof BaseDialog.Popup> &
  VariantProps<typeof sheetContentVariants>;

const SheetContent = forwardRef<HTMLDivElement, SheetContentProps>(
  ({ className, side, children, ...props }, ref) => (
    <BaseDialog.Portal>
      <BaseDialog.Backdrop className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
      <BaseDialog.Popup
        ref={ref}
        className={cn(sheetContentVariants({ side, className }))}
        {...props}
      >
        {children}
      </BaseDialog.Popup>
    </BaseDialog.Portal>
  )
);
SheetContent.displayName = 'SheetContent';

const SheetHeader = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn('px-5 py-3 border-b border-border', className)}
      {...props}
    />
  )
);
SheetHeader.displayName = 'SheetHeader';

const SheetFooter = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        'px-5 py-3 border-t border-border flex justify-end gap-2',
        className
      )}
      {...props}
    />
  )
);
SheetFooter.displayName = 'SheetFooter';

const SheetTitle = forwardRef<
  HTMLHeadingElement,
  ComponentPropsWithoutRef<typeof BaseDialog.Title>
>(({ className, ...props }, ref) => (
  <BaseDialog.Title
    ref={ref}
    className={cn(
      'font-mono text-[10px] text-neutral-500 uppercase tracking-widest',
      className
    )}
    {...props}
  />
));
SheetTitle.displayName = 'SheetTitle';

const SheetDescription = forwardRef<
  HTMLParagraphElement,
  ComponentPropsWithoutRef<typeof BaseDialog.Description>
>(({ className, ...props }, ref) => (
  <BaseDialog.Description
    ref={ref}
    className={cn('text-sm text-neutral-400', className)}
    {...props}
  />
));
SheetDescription.displayName = 'SheetDescription';

export {
  Sheet,
  SheetTrigger,
  SheetContent,
  sheetContentVariants,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
};
export type { SheetContentProps };
