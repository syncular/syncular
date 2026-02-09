'use client';

import { forwardRef } from 'react';
import { cn } from '../lib/cn';

export interface InstallSectionProps {
  docsHref?: string;
  githubHref?: string;
  className?: string;
}

export const InstallSection = forwardRef<HTMLElement, InstallSectionProps>(
  function InstallSection(
    {
      docsHref = '/docs',
      githubHref = 'https://github.com/syncular/syncular',
      className,
    },
    ref
  ) {
    return (
      <section
        ref={ref}
        id="install"
        className={cn('py-24 border-t border-border', className)}
      >
        <div className="max-w-[1400px] mx-auto px-6 text-center">
          <span className="font-mono text-[11px] text-flow uppercase tracking-widest">
            Get started
          </span>
          <h2 className="font-display font-bold text-2xl md:text-3xl text-white mt-4">
            Install in one command.
          </h2>
          <p className="text-neutral-400 mt-4 max-w-lg mx-auto">
            Syncular is modular. Install the client, server, and transport
            packages you need.
          </p>

          <div className="mt-10 inline-block">
            <div className="code-block text-left" style={{ minWidth: 480 }}>
              <div className="code-header">
                <span className="w-2 h-2 rounded-full bg-healthy inline-block" />
                <span>terminal</span>
              </div>
              <pre className="font-mono text-sm px-6 py-4">
                <code>
                  <span className="text-neutral-500">$</span>{' '}
                  <span className="text-white">
                    bun add @syncular/client @syncular/server
                  </span>
                  {'\n'}
                  <span className="text-neutral-500">$</span>{' '}
                  <span className="text-white">
                    bun add @syncular/transport-http
                  </span>
                  {'\n'}
                  <span className="text-neutral-600">
                    # Optional: WebSocket transport for real-time
                  </span>
                  {'\n'}
                  <span className="text-neutral-500">$</span>{' '}
                  <span className="text-white">
                    bun add @syncular/transport-ws
                  </span>
                </code>
              </pre>
            </div>
          </div>

          <div className="mt-10 flex items-center justify-center gap-4">
            {docsHref ? (
              <a
                href={docsHref}
                className="font-display font-medium text-sm bg-flow text-white px-6 py-2.5 rounded hover:bg-blue-600 transition-colors"
              >
                Read the docs
              </a>
            ) : null}
            {githubHref ? (
              <a
                href={githubHref}
                className="font-display font-medium text-sm border border-border text-neutral-300 px-6 py-2.5 rounded hover:border-neutral-500 hover:text-white transition-colors"
              >
                View on GitHub
              </a>
            ) : null}
          </div>
        </div>
      </section>
    );
  }
);
