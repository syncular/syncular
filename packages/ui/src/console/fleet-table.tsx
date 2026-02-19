'use client';

import { type ComponentPropsWithoutRef, forwardRef } from 'react';
import { cn } from '../lib/cn';
import type { SyncClientNode } from '../lib/types';
import { Badge } from '../primitives/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../primitives/table';

export type FleetTableProps = ComponentPropsWithoutRef<'div'> & {
  clients: SyncClientNode[];
  headSeq: number;
  onEvict?: (clientId: string) => void;
};

function getLagColor(lag: number) {
  if (lag === 0) return '#22c55e';
  if (lag < 10) return '#f59e0b';
  if (lag < 50) return '#f97316';
  return '#ef4444';
}

const statusBadgeVariant = {
  online: 'healthy',
  syncing: 'syncing',
  offline: 'offline',
} as const;

const FleetTable = forwardRef<HTMLDivElement, FleetTableProps>(
  ({ className, clients, headSeq, onEvict, ...props }, ref) => {
    return (
      <div ref={ref} className={cn('w-full', className)} {...props}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Client</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Cursor</TableHead>
              <TableHead>Lag</TableHead>
              <TableHead>Dialect</TableHead>
              <TableHead>Mode</TableHead>
              {onEvict && <TableHead>Actions</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {clients.map((client) => {
              const lag = Math.max(0, headSeq - client.cursor);
              const pct =
                headSeq > 0
                  ? Math.min(100, (client.cursor / headSeq) * 100)
                  : 100;
              const lagColor = getLagColor(lag);

              return (
                <TableRow key={client.id}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <span
                        className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                        style={{
                          background: lagColor,
                          boxShadow: `0 0 4px ${lagColor}`,
                        }}
                      />
                      <span
                        className="font-mono text-[11px] text-white truncate"
                        title={client.id}
                      >
                        {client.id.length > 18
                          ? `${client.id.substring(0, 18)}\u2026`
                          : client.id}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusBadgeVariant[client.status]}>
                      {client.status}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <span className="font-mono text-[10px] text-neutral-400">
                      {client.type}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className="font-mono text-[11px] text-white font-medium">
                      #{client.cursor.toLocaleString()}
                    </span>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <div className="w-[60px] h-[3px] rounded-full bg-surface overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all"
                          style={{ width: `${pct}%`, background: lagColor }}
                        />
                      </div>
                      <span
                        className="font-mono text-[10px] font-medium"
                        style={{ color: lagColor }}
                      >
                        {lag === 0 ? '0' : `${lag}`}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <span className="font-mono text-[10px] text-neutral-400">
                      {client.dialect}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={client.mode === 'realtime' ? 'flow' : 'ghost'}
                    >
                      {client.mode}
                    </Badge>
                  </TableCell>
                  {onEvict && (
                    <TableCell>
                      <button
                        type="button"
                        onClick={() => onEvict(client.id)}
                        className="inline-flex items-center gap-1 rounded-md font-mono text-[9px] px-2 py-1 border border-transparent text-neutral-600 hover:border-offline/50 hover:text-offline hover:bg-offline/[0.06] cursor-pointer transition-all opacity-0 group-hover:opacity-100"
                      >
                        evict
                      </button>
                    </TableCell>
                  )}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    );
  }
);
FleetTable.displayName = 'FleetTable';

export { FleetTable };
