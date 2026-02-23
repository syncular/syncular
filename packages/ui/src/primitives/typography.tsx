'use client';

import { type ComponentPropsWithoutRef, forwardRef } from 'react';
import { cn } from '../lib/cn';

/**
 * Dialog/panel body text — primary weight.
 * `font-mono text-[11px] text-neutral-300`
 */
const Text = forwardRef<HTMLParagraphElement, ComponentPropsWithoutRef<'p'>>(
  ({ className, ...props }, ref) => (
    <p
      ref={ref}
      className={cn('font-mono text-[11px] text-neutral-300', className)}
      {...props}
    />
  )
);
Text.displayName = 'Text';

/**
 * Secondary / meta text — smaller, muted.
 * `font-mono text-[10px] text-neutral-500`
 */
const TextMuted = forwardRef<
  HTMLParagraphElement,
  ComponentPropsWithoutRef<'p'>
>(({ className, ...props }, ref) => (
  <p
    ref={ref}
    className={cn('font-mono text-[10px] text-neutral-500', className)}
    {...props}
  />
));
TextMuted.displayName = 'TextMuted';

/**
 * Inline code / monospace value.
 * `font-mono text-[11px] text-white`
 */
const TextCode = forwardRef<HTMLElement, ComponentPropsWithoutRef<'code'>>(
  ({ className, ...props }, ref) => (
    <code
      ref={ref}
      className={cn('font-mono text-[11px] text-white', className)}
      {...props}
    />
  )
);
TextCode.displayName = 'TextCode';

/**
 * Uppercase monospace label — section headers, code block labels.
 * `font-mono text-[9px] uppercase tracking-wider text-neutral-500`
 */
const TextLabel = forwardRef<HTMLSpanElement, ComponentPropsWithoutRef<'span'>>(
  ({ className, ...props }, ref) => (
    <span
      ref={ref}
      className={cn(
        'font-mono text-[9px] uppercase tracking-wider text-neutral-500',
        className
      )}
      {...props}
    />
  )
);
TextLabel.displayName = 'TextLabel';

/**
 * Pre-formatted code block.
 * `font-mono text-[11px] text-neutral-300 p-3 rounded border border-border bg-panel-alt overflow-x-auto`
 */
const CodeBlock = forwardRef<HTMLPreElement, ComponentPropsWithoutRef<'pre'>>(
  ({ className, ...props }, ref) => (
    <pre
      ref={ref}
      className={cn(
        'font-mono text-[11px] text-neutral-300 p-3 rounded border border-border bg-panel-alt overflow-x-auto',
        className
      )}
      {...props}
    />
  )
);
CodeBlock.displayName = 'CodeBlock';

export { Text, TextMuted, TextCode, TextLabel, CodeBlock };
