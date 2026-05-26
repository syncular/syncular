'use client';

import { forwardRef } from 'react';
import { cn } from '../lib/cn';
import { SectionHeading } from './section-heading';

export interface ExplanationSectionProps {
  className?: string;
}

const features = [
  {
    title: 'Rust-owned local state',
    color: 'healthy',
    description:
      'The client runtime owns SQLite, the outbox, subscriptions, and local apply. JavaScript and Rust APIs sit above the same engine.',
  },
  {
    title: 'Typed local reads',
    color: 'flow',
    description:
      'Use Kysely from TypeScript apps or generated Diesel types from Rust apps while reads stay local.',
  },
  {
    title: 'Commit-log sync',
    color: 'flow',
    description:
      'Append-only log of changes. Incremental pulls. Easy to reason about and debug.',
  },
  {
    title: 'Scope-based auth',
    color: 'syncing',
    description:
      "Every change is tagged with scope values. Pulls return only what's requested and allowed.",
  },
  {
    title: 'Blob storage',
    color: 'violet-400',
    description:
      'Sync binary files alongside structured data with content hashes and server-side storage adapters.',
  },
  {
    title: 'Field encryption',
    color: 'pink-400',
    description:
      'Encrypt selected fields, CRDT streams, and blobs inside the runtime instead of hand-rolling app code.',
  },
  {
    title: 'Observability',
    color: 'healthy',
    description:
      'Capture diagnostics, runtime freshness, logs, traces, metrics, and exceptions from production clients.',
  },
  {
    title: 'Admin console',
    color: 'flow',
    description:
      'Inspect commits, clients, and events. Trigger prune/compact and debug sync in production.',
  },
] as const;

function colorClasses(color: string) {
  switch (color) {
    case 'healthy':
      return { bg: 'bg-healthy/10', text: 'text-healthy' };
    case 'flow':
      return { bg: 'bg-flow/10', text: 'text-flow' };
    case 'syncing':
      return { bg: 'bg-syncing/10', text: 'text-syncing' };
    case 'violet-400':
      return { bg: 'bg-violet-400/10', text: 'text-violet-400' };
    case 'pink-400':
      return { bg: 'bg-pink-400/10', text: 'text-pink-400' };
    default:
      return { bg: 'bg-flow/10', text: 'text-flow' };
  }
}

export const ExplanationSection = forwardRef<
  HTMLElement,
  ExplanationSectionProps
>(function ExplanationSection({ className }, ref) {
  return (
    <section
      ref={ref}
      id="why-syncular"
      className={cn('py-24 border-t border-border', className)}
    >
      <div className="max-w-[1400px] mx-auto px-6">
        <SectionHeading
          label="Why Syncular"
          title="Everything you need for offline-first sync. Nothing you don't."
        />

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
          {features.map((feature) => {
            const colors = colorClasses(feature.color);
            return (
              <div
                key={feature.title}
                className="dashboard-panel rounded-lg p-6"
              >
                <div className="flex items-center gap-2 mb-4">
                  <div
                    className={cn(
                      'w-8 h-8 rounded flex items-center justify-center',
                      colors.bg
                    )}
                  >
                    <div
                      className={cn('w-2 h-2 rounded-full', colors.text)}
                      style={{ backgroundColor: 'currentColor' }}
                    />
                  </div>
                  <span className="font-display font-semibold text-white text-sm">
                    {feature.title}
                  </span>
                </div>
                <p className="text-sm text-neutral-400 leading-relaxed">
                  {feature.description}
                </p>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
});
