'use client';

import { Field as BaseField } from '@base-ui/react/field';
import {
  type ComponentPropsWithoutRef,
  type ComponentRef,
  forwardRef,
} from 'react';
import { cn } from '../lib/cn';

const Field = BaseField.Root;

const FieldLabel = forwardRef<
  ComponentRef<typeof BaseField.Label>,
  ComponentPropsWithoutRef<typeof BaseField.Label>
>(({ className, ...props }, ref) => (
  <BaseField.Label
    ref={ref}
    className={cn(
      'font-mono text-[9px] text-neutral-500 uppercase tracking-wider block mb-1.5',
      className
    )}
    {...props}
  />
));
FieldLabel.displayName = 'FieldLabel';

const FieldDescription = forwardRef<
  ComponentRef<typeof BaseField.Description>,
  ComponentPropsWithoutRef<typeof BaseField.Description>
>(({ className, ...props }, ref) => (
  <BaseField.Description
    ref={ref}
    className={cn('font-mono text-[9px] text-neutral-600 mt-0.5', className)}
    {...props}
  />
));
FieldDescription.displayName = 'FieldDescription';

const FieldError = forwardRef<
  ComponentRef<typeof BaseField.Error>,
  ComponentPropsWithoutRef<typeof BaseField.Error>
>(({ className, ...props }, ref) => (
  <BaseField.Error
    ref={ref}
    className={cn('font-mono text-[10px] text-offline mt-1', className)}
    {...props}
  />
));
FieldError.displayName = 'FieldError';

const FieldContent = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<'div'>
>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn(className)} {...props} />
));
FieldContent.displayName = 'FieldContent';

export { Field, FieldLabel, FieldDescription, FieldError, FieldContent };
