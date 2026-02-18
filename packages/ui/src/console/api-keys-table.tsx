'use client';

import { type ComponentPropsWithoutRef, forwardRef } from 'react';
import { cn } from '../lib/cn';
import type { ApiKeyEntry } from '../lib/types';
import { Badge, type BadgeProps } from '../primitives/badge';
import { Button } from '../primitives/button';

export type ApiKeysTableProps = ComponentPropsWithoutRef<'div'> & {
  keys: ApiKeyEntry[];
  onCreateKey?: () => void;
  onRotateKey?: (name: string) => void;
  onRevokeKey?: (name: string) => void;
};

const typeBadgeMap: Record<string, BadgeProps['variant']> = {
  relay: 'relay',
  admin: 'flow',
  proxy: 'ghost',
};

const ApiKeysTable = forwardRef<HTMLDivElement, ApiKeysTableProps>(
  (
    { className, keys, onCreateKey, onRotateKey, onRevokeKey, ...props },
    ref
  ) => (
    <div
      ref={ref}
      className={cn(
        'bg-panel border border-border rounded-lg hover:border-border-bright transition',
        className
      )}
      {...props}
    >
      {/* Header */}
      <div className="px-4 py-2.5 border-b border-border flex items-center justify-between">
        <span className="font-mono text-[10px] text-neutral-500 uppercase tracking-widest">
          API Keys
        </span>
        {onCreateKey && (
          <Button variant="primary" size="sm" onClick={onCreateKey}>
            + Create Key
          </Button>
        )}
      </div>

      {/* Column headers */}
      <div className="font-mono text-[9px] tracking-wider uppercase text-neutral-600 flex items-center gap-4 px-4 leading-6 border-b border-border">
        <span className="w-[140px]">Name</span>
        <span className="w-[70px]">Type</span>
        <span className="flex-1">Prefix</span>
        <span className="w-[90px]">Created</span>
        <span className="w-[80px] text-right">Actions</span>
      </div>

      {/* Rows */}
      {keys.map((k, i) => (
        <div
          key={`${k.name}:${k.prefix}:${i}`}
          className={cn(
            'font-mono text-[11px] leading-7 px-4 flex items-center gap-4 hover:bg-white/[0.015] transition-colors cursor-default',
            i < keys.length - 1 && 'border-b border-[#141414]'
          )}
        >
          <span className="w-[140px] text-white truncate">{k.name}</span>
          <span className="w-[70px]">
            <Badge variant={typeBadgeMap[k.type] ?? 'ghost'}>{k.type}</Badge>
          </span>
          <span className="flex-1 text-neutral-500 truncate">{k.prefix}</span>
          <span className="w-[90px] text-neutral-600 truncate">
            {k.created}
          </span>
          <span className="w-[80px] flex gap-2 justify-end">
            {onRotateKey && (
              <Button
                variant="default"
                size="sm"
                className="text-[9px] px-1.5 py-0.5"
                onClick={() => onRotateKey(k.name)}
              >
                Rotate
              </Button>
            )}
            {onRevokeKey && (
              <Button
                variant="destructive"
                size="sm"
                className="text-[9px] px-1.5 py-0.5"
                onClick={() => onRevokeKey(k.name)}
              >
                Revoke
              </Button>
            )}
          </span>
        </div>
      ))}
    </div>
  )
);
ApiKeysTable.displayName = 'ApiKeysTable';

export { ApiKeysTable };
