'use client';

import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

export interface CatalogRow {
  id: string;
  name: string;
  sku: string;
  price: string;
}

export interface CatalogTableProps {
  rows: CatalogRow[];
  label?: string;
  headerRight?: ReactNode;
  footer?: ReactNode;
  maxHeight?: number;
  className?: string;
}

export function CatalogTable({
  rows,
  label = 'Catalog Items',
  headerRight,
  footer,
  maxHeight = 400,
  className,
}: CatalogTableProps) {
  return (
    <div
      className={cn('rounded-[10px] border border-border bg-panel', className)}
    >
      {/* Panel header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="font-mono text-[10px] uppercase tracking-wider text-neutral-500">
          {label}
        </span>
        {headerRight ? (
          <div className="flex items-center gap-3">{headerRight}</div>
        ) : null}
      </div>

      {/* Column headers */}
      <div className="grid grid-cols-[80px_1fr_100px_80px] px-3 py-2 border-b border-border bg-panel-alt">
        <span className="font-mono text-[9px] text-neutral-500 uppercase">
          ID
        </span>
        <span className="font-mono text-[9px] text-neutral-500 uppercase">
          Name
        </span>
        <span className="font-mono text-[9px] text-neutral-500 uppercase">
          SKU
        </span>
        <span className="font-mono text-[9px] text-neutral-500 uppercase">
          Price
        </span>
      </div>

      {/* Rows */}
      <div className="overflow-auto" style={{ maxHeight }}>
        {rows.map((row) => (
          <div
            key={row.id}
            className="grid grid-cols-[80px_1fr_100px_80px] px-3 py-2 border-b border-[#161616] font-mono text-[11px] text-neutral-400 hover:bg-white/[0.015] transition-colors"
          >
            <span className="text-neutral-600">{row.id}</span>
            <span className="text-neutral-300">{row.name}</span>
            <span className="text-neutral-600">{row.sku}</span>
            <span className="text-healthy">{row.price}</span>
          </div>
        ))}
      </div>

      {/* Footer */}
      {footer ? (
        <div className="border-t border-border px-4 py-2 flex items-center justify-between">
          {footer}
        </div>
      ) : null}
    </div>
  );
}
