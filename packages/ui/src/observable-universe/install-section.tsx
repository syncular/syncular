'use client';

import { forwardRef } from 'react';
import { cn } from '../lib/cn';

export interface InstallSectionProps {
  docsHref?: string;
  demoHref?: string;
  githubHref?: string;
  className?: string;
}

export const InstallSection = forwardRef<HTMLElement, InstallSectionProps>(
  function InstallSection(
    {
      docsHref = '/docs',
      demoHref,
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
            Syncular is modular. Install only what you need.
          </h2>

          <div className="mt-10 grid grid-cols-1 lg:grid-cols-2 gap-6 max-w-4xl mx-auto text-left">
            {/* Server install */}
            <div className="code-block">
              <div className="code-header">
                <span className="w-2 h-2 rounded-full bg-healthy inline-block" />
                <span>Server</span>
              </div>
              <pre className="font-mono text-sm px-6 py-4">
                <code>
                  <span className="text-neutral-500">$</span>{' '}
                  <span className="text-white">bun add @syncular/server \</span>
                  {'\n'}
                  <span className="text-white">
                    {'  '}@syncular/server-hono \
                  </span>
                  {'\n'}
                  <span className="text-white">
                    {'  '}@syncular/server-dialect-postgres \
                  </span>
                  {'\n'}
                  <span className="text-white">{'  '}kysely pg hono</span>
                </code>
              </pre>
            </div>

            {/* Client install */}
            <div className="code-block">
              <div className="code-header">
                <span className="w-2 h-2 rounded-full bg-flow inline-block" />
                <span>Client</span>
              </div>
              <pre className="font-mono text-sm px-6 py-4">
                <code>
                  <span className="text-neutral-500">$</span>{' '}
                  <span className="text-white">bun add @syncular/client \</span>
                  {'\n'}
                  <span className="text-white">
                    {'  '}@syncular/client-react \
                  </span>
                  {'\n'}
                  <span className="text-white">
                    {'  '}@syncular/transport-http \
                  </span>
                  {'\n'}
                  <span className="text-white">
                    {'  '}@syncular/dialect-wa-sqlite kysely
                  </span>
                </code>
              </pre>
            </div>
          </div>

          <div className="mt-10 flex items-center justify-center gap-4 flex-wrap">
            {docsHref ? (
              <a
                href={docsHref}
                className="font-display font-medium text-sm bg-flow text-white px-6 py-2.5 rounded hover:bg-blue-600 transition-colors"
              >
                Read the docs
              </a>
            ) : null}
            {demoHref ? (
              <a
                href={demoHref}
                className="font-display font-medium text-sm border border-flow text-flow px-6 py-2.5 rounded hover:bg-flow/10 transition-colors"
              >
                Try the demo
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
