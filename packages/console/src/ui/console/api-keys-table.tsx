'use client';

import { type ComponentPropsWithoutRef, forwardRef } from 'react';
import { cn } from '../lib/cn';
import type { ApiKeyEntry } from '../lib/types';
import { Badge, type BadgeProps } from '../primitives/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../primitives/table';

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
    <div ref={ref} className={cn('w-full', className)} {...props}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Prefix</TableHead>
            <TableHead>Created</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {keys.map((k, i) => (
            <TableRow
              key={`${k.name}:${k.prefix}:${i}`}
              className="group relative"
            >
              <TableCell>
                <span className="text-white truncate">{k.name}</span>
              </TableCell>
              <TableCell>
                <Badge variant={typeBadgeMap[k.type] ?? 'ghost'}>
                  {k.type}
                </Badge>
              </TableCell>
              <TableCell>
                <span className="text-neutral-500 truncate">{k.prefix}</span>
              </TableCell>
              <TableCell>
                <span className="text-neutral-600 truncate">{k.created}</span>
              </TableCell>
              {(onRotateKey || onRevokeKey) && (
                <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  {onRotateKey && (
                    <button
                      type="button"
                      onClick={() => onRotateKey(k.name)}
                      className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] text-neutral-600 hover:text-white hover:bg-white/[0.05] cursor-pointer transition-colors"
                    >
                      rotate
                    </button>
                  )}
                  {onRevokeKey && (
                    <button
                      type="button"
                      onClick={() => onRevokeKey(k.name)}
                      className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] text-neutral-600 hover:text-offline hover:bg-offline/10 cursor-pointer transition-colors"
                    >
                      revoke
                    </button>
                  )}
                </div>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
);
ApiKeysTable.displayName = 'ApiKeysTable';

export { ApiKeysTable };
