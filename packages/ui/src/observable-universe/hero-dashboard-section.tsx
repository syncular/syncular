'use client';

import { forwardRef } from 'react';
import { cn } from '../lib/cn';
import { CommitStreamPanel } from './commit-stream-panel';
import { ConnectedClientsPanel } from './connected-clients-panel';
import { LiveMetricsBar } from './live-metrics-bar';
import { SyncTopologyPanel } from './sync-topology-panel';
import type {
  ObservableClient,
  ObservableMetrics,
  ObservableStreamEntry,
} from './types';

export interface HeroDashboardSectionProps {
  clients: ObservableClient[];
  streamEntries: ObservableStreamEntry[];
  metrics: ObservableMetrics;
  streamRate?: string;
  className?: string;
}

export const HeroDashboardSection = forwardRef<
  HTMLElement,
  HeroDashboardSectionProps
>(function HeroDashboardSection(
  { clients, streamEntries, metrics, streamRate, className },
  ref
) {
  return (
    <section
      ref={ref}
      className={cn('pt-16 pb-4 min-h-screen flex flex-col', className)}
    >
      {/* Title bar */}
      <div className="max-w-[1400px] mx-auto w-full px-6 pt-6 pb-4">
        <h1 className="font-display font-bold text-3xl md:text-4xl text-white leading-tight">
          Offline-first SQL sync you can operate.
        </h1>
        <p className="font-display text-base text-neutral-500 mt-2 max-w-2xl">
          Web, Electron, Expo. Local SQLite read and write path. Commit-log
          sync. Scopes for partial sync and auth.
        </p>
        <div className="mt-3 flex items-center gap-2 flex-wrap">
          <span className="font-mono text-[10px] uppercase tracking-widest text-amber-300 border border-amber-300/30 px-2 py-0.5 rounded">
            Alpha
          </span>
          <span className="text-sm text-neutral-500">
            APIs and storage layouts will change. Pin versions and expect manual
            migrations between versions.
          </span>
        </div>
      </div>

      {/* Dashboard grid */}
      <div
        className="max-w-[1400px] mx-auto w-full px-6 flex-1 grid grid-cols-1 lg:grid-cols-[320px_1fr_320px] gap-3 pb-3"
        style={{ minHeight: 520 }}
      >
        <ConnectedClientsPanel clients={clients} />
        <SyncTopologyPanel clients={clients} />
        <CommitStreamPanel entries={streamEntries} rate={streamRate} />
      </div>

      {/* Bottom strip: Live Metrics */}
      <div className="max-w-[1400px] mx-auto w-full px-6 pb-6">
        <LiveMetricsBar metrics={metrics} />
      </div>
    </section>
  );
});
