'use client';

import { forwardRef } from 'react';
import { cn } from '../lib/cn';
import { SectionHeading } from './section-heading';

export interface ExplanationSectionProps {
  className?: string;
}

const features = [
  {
    title: 'Instant UI',
    color: 'healthy',
    description:
      'Queries hit local SQLite in <1ms. No loading spinners, no network in the hot path.',
  },
  {
    title: 'Offline by default',
    color: 'flow',
    description:
      'Writes queue in a local outbox. Sync happens when connectivity returns.',
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
      'Every change tagged with scope values. Pulls return only what\u2019s requested and allowed.',
  },
  {
    title: 'Blob storage',
    color: 'violet-400',
    description:
      'Sync binary files alongside structured data. Adapters for filesystem, database, and S3-compatible storage (S3/R2/MinIO).',
  },
  {
    title: 'End-to-end encryption',
    color: 'pink-400',
    description:
      'Field-level E2E encryption (XChaCha20-Poly1305) with BIP39 key sharing.',
  },
  {
    title: 'Observability',
    color: 'healthy',
    description:
      'Pluggable telemetry \u2014 logs, traces, metrics, exceptions. Sentry adapter or bring your own.',
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
