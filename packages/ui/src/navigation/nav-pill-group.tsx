'use client';

import type { ReactNode } from 'react';
import { cn } from '../lib/cn';
import type { NavItem } from '../lib/types';
import { NavPill } from './nav-pill';

export type NavPillGroupProps = {
  items: readonly NavItem[];
  activeId: string;
  onItemChange?: (id: string) => void;
  renderItem?: (
    item: NavItem,
    props: { active: boolean; onClick: () => void }
  ) => ReactNode;
  className?: string;
};

export function NavPillGroup({
  items,
  activeId,
  onItemChange,
  renderItem,
  className,
}: NavPillGroupProps) {
  return (
    <div className={cn('flex items-center gap-0.5', className)}>
      {items.map((item) => {
        const active = item.id === activeId;
        const onClick = () => onItemChange?.(item.id);

        if (renderItem) {
          return (
            <span key={item.id}>{renderItem(item, { active, onClick })}</span>
          );
        }

        return (
          <NavPill key={item.id} active={active} onClick={onClick}>
            {item.label}
          </NavPill>
        );
      })}
    </div>
  );
}
