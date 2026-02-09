'use client';

import { forwardRef } from 'react';
import { cn } from '../lib/cn';
import { SectionHeading } from './section-heading';

export interface ArchitectureSectionProps {
  className?: string;
}

export const ArchitectureSection = forwardRef<
  HTMLElement,
  ArchitectureSectionProps
>(function ArchitectureSection({ className }, ref) {
  return (
    <section
      ref={ref}
      id="architecture"
      className={cn('py-24 border-t border-border', className)}
    >
      <div className="max-w-[1400px] mx-auto px-6">
        <SectionHeading
          label="How sync works"
          title="Local SQLite on every client. Commit log for change tracking. Server as the source of truth."
        />

        {/* Architecture diagram */}
        <div className="dashboard-panel rounded-lg p-8 md:p-12 overflow-x-auto">
          <div className="flex items-center justify-center gap-0 min-w-[700px]">
            {/* Client A */}
            <div className="flex flex-col items-center gap-2 shrink-0">
              <div className="w-32 border border-border rounded-lg p-4 text-center bg-panel">
                <div className="font-mono text-[10px] text-neutral-500 uppercase mb-1">
                  Client A
                </div>
                <div className="font-mono text-xs text-white">SQLite</div>
                <div className="font-mono text-[10px] text-neutral-600 mt-1">
                  outbox + local DB
                </div>
              </div>
            </div>

            {/* Arrow */}
            <div className="flex flex-col items-center gap-1 px-3 shrink-0">
              <svg width="60" height="24" viewBox="0 0 60 24">
                <path
                  d="M0 12h52m-6-5l6 5-6 5"
                  stroke="#3b82f6"
                  strokeWidth="1.5"
                  fill="none"
                  strokeLinecap="round"
                />
              </svg>
              <span className="font-mono text-[9px] text-flow">HTTP / WS</span>
            </div>

            {/* Transport */}
            <div className="flex flex-col items-center gap-2 shrink-0">
              <div
                className="w-28 border border-flow/30 rounded-lg p-4 text-center"
                style={{ background: 'rgba(59,130,246,0.05)' }}
              >
                <div className="font-mono text-[10px] text-flow uppercase mb-1">
                  Transport
                </div>
                <div className="font-mono text-xs text-white">Push / Pull</div>
                <div className="font-mono text-[10px] text-neutral-600 mt-1">
                  delta sync
                </div>
              </div>
            </div>

            {/* Arrow */}
            <div className="flex flex-col items-center gap-1 px-3 shrink-0">
              <svg width="60" height="24" viewBox="0 0 60 24">
                <path
                  d="M0 12h52m-6-5l6 5-6 5"
                  stroke="#3b82f6"
                  strokeWidth="1.5"
                  fill="none"
                  strokeLinecap="round"
                />
              </svg>
              <span className="font-mono text-[9px] text-flow">commits</span>
            </div>

            {/* Server */}
            <div className="flex flex-col items-center gap-2 shrink-0">
              <div
                className="w-36 border-2 border-flow rounded-lg p-4 text-center relative"
                style={{
                  background: 'rgba(59,130,246,0.08)',
                  boxShadow: '0 0 20px rgba(59,130,246,0.15)',
                }}
              >
                <div className="font-mono text-[10px] text-flow uppercase mb-1">
                  Server
                </div>
                <div className="font-mono text-xs text-white font-medium">
                  Commit Log
                </div>
                <div className="font-mono text-[10px] text-neutral-600 mt-1">
                  source of truth
                </div>
              </div>
            </div>

            {/* Arrow */}
            <div className="flex flex-col items-center gap-1 px-3 shrink-0">
              <svg width="60" height="24" viewBox="0 0 60 24">
                <path
                  d="M0 12h52m-6-5l6 5-6 5"
                  stroke="#3b82f6"
                  strokeWidth="1.5"
                  fill="none"
                  strokeLinecap="round"
                />
              </svg>
              <span className="font-mono text-[9px] text-flow">commits</span>
            </div>

            {/* Transport */}
            <div className="flex flex-col items-center gap-2 shrink-0">
              <div
                className="w-28 border border-flow/30 rounded-lg p-4 text-center"
                style={{ background: 'rgba(59,130,246,0.05)' }}
              >
                <div className="font-mono text-[10px] text-flow uppercase mb-1">
                  Transport
                </div>
                <div className="font-mono text-xs text-white">Push / Pull</div>
                <div className="font-mono text-[10px] text-neutral-600 mt-1">
                  delta sync
                </div>
              </div>
            </div>

            {/* Arrow */}
            <div className="flex flex-col items-center gap-1 px-3 shrink-0">
              <svg width="60" height="24" viewBox="0 0 60 24">
                <path
                  d="M0 12h52m-6-5l6 5-6 5"
                  stroke="#3b82f6"
                  strokeWidth="1.5"
                  fill="none"
                  strokeLinecap="round"
                />
              </svg>
              <span className="font-mono text-[9px] text-flow">HTTP / WS</span>
            </div>

            {/* Client B */}
            <div className="flex flex-col items-center gap-2 shrink-0">
              <div className="w-32 border border-border rounded-lg p-4 text-center bg-panel">
                <div className="font-mono text-[10px] text-neutral-500 uppercase mb-1">
                  Client B
                </div>
                <div className="font-mono text-xs text-white">SQLite</div>
                <div className="font-mono text-[10px] text-neutral-600 mt-1">
                  outbox + local DB
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Step cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mt-6">
          <div className="dashboard-panel rounded-lg p-5">
            <div className="font-mono text-[10px] text-healthy uppercase tracking-wider mb-2">
              Bootstrap
            </div>
            <p className="text-sm text-neutral-400 leading-relaxed">
              First sync sends a point-in-time snapshot, chunked and compressed
              for large datasets.
            </p>
          </div>
          <div className="dashboard-panel rounded-lg p-5">
            <div className="font-mono text-[10px] text-syncing uppercase tracking-wider mb-2">
              Push
            </div>
            <p className="text-sm text-neutral-400 leading-relaxed">
              Client writes locally, queues in outbox, pushes to server. Server
              validates and writes to commit log.
            </p>
          </div>
          <div className="dashboard-panel rounded-lg p-5">
            <div className="font-mono text-[10px] text-flow uppercase tracking-wider mb-2">
              Pull
            </div>
            <p className="text-sm text-neutral-400 leading-relaxed">
              Client sends its cursor. Server returns commits since then,
              filtered by scopes.
            </p>
          </div>
          <div className="dashboard-panel rounded-lg p-5">
            <div className="font-mono text-[10px] text-violet-400 uppercase tracking-wider mb-2">
              Realtime
            </div>
            <p className="text-sm text-neutral-400 leading-relaxed">
              WebSocket wakes clients on new commits. Data still flows over
              HTTP.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
});
