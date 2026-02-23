'use client';

import { UserX } from 'lucide-react';
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
              <TableHead className="w-[160px]">Client</TableHead>
              <TableHead className="w-[70px]">Status</TableHead>
              <TableHead className="w-[60px]">Type</TableHead>
              <TableHead className="w-[80px]">Cursor</TableHead>
              <TableHead className="w-[110px]">Lag</TableHead>
              <TableHead className="w-[60px]">Dialect</TableHead>
              <TableHead className="flex-1">Mode</TableHead>
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
                <TableRow key={client.id} className="group relative">
                  <TableCell className="w-[160px]">
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
                  <TableCell className="w-[70px]">
                    <Badge variant={statusBadgeVariant[client.status]}>
                      {client.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="w-[60px]">
                    <span className="font-mono text-[10px] text-neutral-400">
                      {client.type}
                    </span>
                  </TableCell>
                  <TableCell className="w-[80px]">
                    <span className="font-mono text-[11px] text-white font-medium">
                      #{client.cursor.toLocaleString()}
                    </span>
                  </TableCell>
                  <TableCell className="w-[110px]">
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
                  <TableCell className="w-[60px]">
                    <span className="font-mono text-[10px] text-neutral-400">
                      {client.dialect}
                    </span>
                  </TableCell>
                  <TableCell className="flex-1">
                    <Badge
                      variant={client.mode === 'realtime' ? 'flow' : 'ghost'}
                    >
                      {client.mode}
                    </Badge>
                  </TableCell>
                  {onEvict && (
                    <button
                      type="button"
                      title="Evict client"
                      onClick={() => onEvict(client.id)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] text-neutral-600 hover:text-offline hover:bg-offline/10 cursor-pointer transition-colors opacity-0 group-hover:opacity-100"
                    >
                      <UserX size={10} />
                      evict
                    </button>
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
