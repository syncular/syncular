'use client';

import { forwardRef } from 'react';
import { cn } from '../lib/cn';
import { SectionHeading } from './section-heading';

export interface CodeSectionProps {
  className?: string;
}

const dialects = [
  { dialect: 'Postgres', runtime: 'Node.js / Bun / Edge' },
  { dialect: 'SQLite', runtime: 'Node.js / Bun' },
  { dialect: 'wa-sqlite', runtime: 'Browser (WASM)', clientOnly: true },
  { dialect: 'PGlite', runtime: 'Browser (WASM)' },
  { dialect: 'better-sqlite3', runtime: 'Node.js / Electron' },
  { dialect: 'sqlite3', runtime: 'Node.js' },
  { dialect: 'Bun SQLite', runtime: 'Bun' },
  { dialect: 'Expo SQLite', runtime: 'React Native', clientOnly: true },
  { dialect: 'Nitro SQLite', runtime: 'React Native', clientOnly: true },
  { dialect: 'LibSQL', runtime: 'Turso / LibSQL' },
  { dialect: 'Neon', runtime: 'Neon Postgres (serverless)' },
  { dialect: 'D1', runtime: 'Cloudflare Workers' },
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
            label="Runs everywhere"
            title="Pick the dialect for your runtime. Mix and match client and server."
          />

          <div className="max-w-3xl">
            <div className="dashboard-panel rounded-lg overflow-hidden">
              <div className="px-6 py-4 border-b border-border">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-flow inline-block" />
                  <span className="font-mono text-[11px] text-flow uppercase tracking-wider">
                    Supported dialects
                  </span>
                </div>
              </div>
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left text-[11px] font-mono text-neutral-500 uppercase tracking-wider px-6 py-3">
                      Dialect
                    </th>
                    <th className="text-left text-[11px] font-mono text-neutral-500 uppercase tracking-wider px-6 py-3">
                      Runtime
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {dialects.map((row) => (
                    <tr key={row.dialect} className="border-b border-border/50">
                      <td className="px-6 py-3 font-mono text-sm text-white">
                        {row.dialect}
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
