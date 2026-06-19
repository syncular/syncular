'use client';

import { cn } from '../lib/cn';
import { buttonVariants } from '../primitives/button';

export const navActionLinkClassName = cn(
  buttonVariants({ variant: 'secondary', size: 'sm' }),
  'h-7 whitespace-nowrap uppercase tracking-[0.08em] leading-none no-underline'
);
