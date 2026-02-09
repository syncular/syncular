'use client';

import { cn } from '../lib/cn';

export interface Channel {
  id: string;
  label: string;
}

export interface ChannelSelectorProps {
  channels: Channel[];
  activeId: string;
  onSelect: (id: string) => void;
  className?: string;
}

export function ChannelSelector({
  channels,
  activeId,
  onSelect,
  className,
}: ChannelSelectorProps) {
  return (
    <div className={cn('flex items-center gap-3', className)}>
      {channels.map((ch) => {
        const active = ch.id === activeId;
        return (
          <button
            key={ch.id}
            type="button"
            onClick={() => onSelect(ch.id)}
            className={cn(
              'inline-flex items-center gap-1.5 px-3 py-1 rounded-md font-mono text-[10px] border transition-all cursor-pointer',
              active
                ? 'border-flow/40 bg-flow/[0.08] text-white'
                : 'border-border-bright bg-transparent text-neutral-500 hover:text-neutral-300'
            )}
          >
            <span
              className={cn(
                'w-1.5 h-1.5 rounded-full',
                active ? 'bg-flow' : 'bg-neutral-600'
              )}
            />
            {ch.label}
          </button>
        );
      })}
    </div>
  );
}
