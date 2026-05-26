'use client';

import { forwardRef } from 'react';
import { cn } from '../lib/cn';
import { SectionHeading } from './section-heading';

export interface CodeSectionProps {
  className?: string;
}

const runtimes = [
  {
    surface: 'Browser / React',
    runtime: 'Rust WASM Worker owns SQLite; TypeScript uses Kysely',
    href: 'https://docs.syncular.dev/clients/javascript/browser',
  },
  {
    surface: 'Electron',
    runtime: 'Desktop TypeScript UI over a Rust-owned local runtime',
    href: 'https://docs.syncular.dev/clients/javascript/electron',
  },
  {
    surface: 'React Native / Expo',
    runtime: 'JavaScript UI bridge to a native Syncular runtime',
    href: 'https://docs.syncular.dev/clients/javascript/react-native-expo',
  },
  {
    surface: 'Tauri',
    runtime: 'Renderer facade over the Rust host runtime',
    href: 'https://docs.syncular.dev/clients/javascript/tauri',
  },
  {
    surface: 'Native Rust',
    runtime: 'Generated Rust client, Diesel reads, real SQLite state',
    href: 'https://docs.syncular.dev/clients/rust',
  },
  {
    surface: 'Server',
    runtime: 'Hono routes, table handlers, Postgres or SQLite dialects',
    href: 'https://docs.syncular.dev/server/setup-with-hono',
  },
  {
    surface: 'Operations',
    runtime: 'Console, diagnostics, telemetry, prune, and compact',
    href: 'https://docs.syncular.dev/operate',
  },
];

export const CodeSection = forwardRef<HTMLElement, CodeSectionProps>(
  function CodeSection({ className }, ref) {
    return (
      <section
        ref={ref}
        id="databases"
        className={cn('py-24 border-t border-border', className)}
      >
        <div className="max-w-[1400px] mx-auto px-6">
          <SectionHeading
            label="Host surfaces"
            title="Pick the host API. Keep the sync engine in Rust."
          />

          <div className="max-w-3xl">
            <div className="dashboard-panel rounded-lg overflow-hidden">
              <div className="px-6 py-4 border-b border-border">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-flow inline-block" />
                  <span className="font-mono text-[11px] text-flow uppercase tracking-wider">
                    Supported runtimes
                  </span>
                </div>
              </div>
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left text-[11px] font-mono text-neutral-500 uppercase tracking-wider px-6 py-3">
                      Surface
                    </th>
                    <th className="text-left text-[11px] font-mono text-neutral-500 uppercase tracking-wider px-6 py-3">
                      Runtime
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {runtimes.map((row) => (
                    <tr key={row.surface} className="border-b border-border/50">
                      <td className="px-6 py-3 font-mono text-sm text-white">
                        <a
                          href={row.href}
                          className="underline decoration-border underline-offset-4 transition-colors hover:text-flow hover:decoration-flow"
                        >
                          {row.surface}
                        </a>
                      </td>
                      <td className="px-6 py-3 text-sm text-neutral-400">
                        {row.runtime}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </section>
    );
  }
);
