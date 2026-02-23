'use client';

import {
  type ComponentPropsWithoutRef,
  forwardRef,
  type ReactNode,
} from 'react';
import { cn } from '../lib/cn';
import type { FilterGroup } from '../lib/types';

export type FilterBarProps = ComponentPropsWithoutRef<'div'> & {
  groups: FilterGroup[];
  searchValue?: string;
  searchPlaceholder?: string;
  onSearchChange?: (value: string) => void;
  actions?: ReactNode;
};

const FilterBar = forwardRef<HTMLDivElement, FilterBarProps>(
  (
    {
      className,
      groups,
      searchValue,
      searchPlaceholder = 'Filter by client or actor...',
      onSearchChange,
      actions,
      ...props
    },
    ref
  ) => (
    <div
      ref={ref}
      className={cn(
        'px-5 py-3 border-b border-border flex items-center gap-4 flex-wrap',
        className
      )}
      {...props}
    >
      {groups.map((group, i) => (
        <FilterGroupSection key={i} group={group} showDivider={i > 0} />
      ))}

      {onSearchChange !== undefined && (
        <input
          className="bg-surface border border-border rounded-md font-mono text-[10px] text-foreground outline-none transition focus:border-flow placeholder:text-neutral-600 max-w-[200px] px-2.5 py-1"
          placeholder={searchPlaceholder}
          value={searchValue}
          onChange={(e) => onSearchChange(e.target.value)}
        />
      )}

      {actions && (
        <div className="ml-auto flex items-center gap-2">{actions}</div>
      )}
    </div>
  )
);
FilterBar.displayName = 'FilterBar';

function FilterGroupSection({
  group,
  showDivider,
}: {
  group: FilterGroup;
  showDivider: boolean;
}) {
  return (
    <>
      {showDivider && <div className="w-px h-4 bg-border" />}
      <div className="flex items-center gap-1">
        {group.label && (
          <span className="font-mono text-[9px] text-neutral-500 mr-1">
            {group.label}
          </span>
        )}
        {group.options.map((opt) => (
          <button
            key={opt.id}
            type="button"
            onClick={() => group.onActiveChange(opt.id)}
            className={cn(
              'font-mono text-[10px] border rounded-sm px-2.5 py-0.5 cursor-pointer transition-all',
              opt.id === group.activeId
                ? 'text-white border-border-bright bg-white/[0.03]'
                : 'text-neutral-500 border-transparent hover:text-neutral-300'
            )}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </>
  );
}

export { FilterBar };
