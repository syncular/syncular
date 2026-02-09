'use client';

import { forwardRef } from 'react';
import { cn } from '../lib/cn';
import { SectionHeading } from './section-heading';

export interface ExplanationSectionProps {
  className?: string;
}

export const ExplanationSection = forwardRef<
  HTMLElement,
  ExplanationSectionProps
>(function ExplanationSection({ className }, ref) {
  return (
    <section
      ref={ref}
      id="explanation"
      className={cn('py-24 border-t border-border', className)}
    >
      <div className="max-w-[1400px] mx-auto px-6">
        <SectionHeading
          label="What you're looking at"
          title="A live view of the Syncular sync engine."
          description="The dashboard above isn't a mockup. It's a simulation of what Syncular actually tracks at runtime. Every client connection, every commit, every conflict resolution -- observable in real-time."
        />

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* Connected Clients card */}
          <div className="dashboard-panel rounded-lg p-6">
            <div className="flex items-center gap-2 mb-4">
              <div className="w-8 h-8 rounded bg-healthy/10 flex items-center justify-center">
                <svg
                  className="w-4 h-4 text-healthy"
                  fill="currentColor"
                  viewBox="0 0 20 20"
                >
                  <circle cx={10} cy={10} r={4} />
                </svg>
              </div>
              <span className="font-display font-semibold text-white">
                Connected Clients
              </span>
            </div>
            <p className="text-sm text-neutral-400 leading-relaxed">
              Every device running Syncular maintains a persistent identity. You
              see their connection status (online, syncing, offline), when they
              last synced, and their total commit count. This is how you debug
              sync issues -- by observing state, not guessing.
            </p>
          </div>

          {/* Sync Topology card */}
          <div className="dashboard-panel rounded-lg p-6">
            <div className="flex items-center gap-2 mb-4">
              <div className="w-8 h-8 rounded bg-flow/10 flex items-center justify-center">
                <svg
                  className="w-4 h-4 text-flow"
                  fill="currentColor"
                  viewBox="0 0 20 20"
                >
                  <path d="M10 2a8 8 0 100 16 8 8 0 000-16zm0 2a6 6 0 110 12 6 6 0 010-12zm0 2a4 4 0 100 8 4 4 0 000-8z" />
                </svg>
              </div>
              <span className="font-display font-semibold text-white">
                Sync Topology
              </span>
            </div>
            <p className="text-sm text-neutral-400 leading-relaxed">
              The node graph shows the server at the center -- the singularity
              of your sync universe. Clients orbit around it. Connection line
              thickness reflects sync activity. Dashed lines mean offline. You
              see the shape of your system at a glance.
            </p>
          </div>

          {/* Commit Stream card */}
          <div className="dashboard-panel rounded-lg p-6">
            <div className="flex items-center gap-2 mb-4">
              <div className="w-8 h-8 rounded bg-syncing/10 flex items-center justify-center">
                <svg
                  className="w-4 h-4 text-syncing"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  viewBox="0 0 20 20"
                >
                  <path d="M4 4l4 4-4 4M10 16h6" />
                </svg>
              </div>
              <span className="font-display font-semibold text-white">
                Commit Stream
              </span>
            </div>
            <p className="text-sm text-neutral-400 leading-relaxed">
              A real-time log of every sync operation: pushes, pulls,
              acknowledgments, conflicts. Each entry shows the client, table,
              operation type, and commit count. Like a git log for your sync
              engine, flowing in real-time.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
});
