'use client';

import { forwardRef } from 'react';
import { cn } from '../lib/cn';

export interface ObservableUniverseHeaderTopicLink {
  label: string;
  href: string;
}

export interface ObservableUniverseHeaderProps {
  topicLinks?: ObservableUniverseHeaderTopicLink[];
  demoHref?: string;
  consoleHref?: string;
  githubHref?: string;
  className?: string;
}

const DEFAULT_TOPIC_LINKS: ObservableUniverseHeaderTopicLink[] = [
  { label: 'Overview', href: '/docs' },
  { label: 'Introduction', href: '/docs/introduction' },
  { label: 'Guides', href: '/docs/guides' },
  { label: 'SDK', href: '/docs/sdk' },
  { label: 'Server', href: '/docs/server' },
  { label: 'API', href: '/docs/api' },
];

function isExternalHref(href: string): boolean {
  return href.startsWith('http://') || href.startsWith('https://');
}

export const ObservableUniverseHeader = forwardRef<
  HTMLElement,
  ObservableUniverseHeaderProps
>(function ObservableUniverseHeader(
  {
    topicLinks = DEFAULT_TOPIC_LINKS,
    demoHref = '/demo',
    consoleHref = '/console',
    githubHref = 'https://github.com/syncular/syncular',
    className,
  },
  ref
) {
  return (
    <nav
      ref={ref}
      className={cn(
        'fixed top-0 left-0 right-0 z-50 border-b border-border',
        className
      )}
      style={{
        background: 'rgba(12,12,12,0.92)',
        backdropFilter: 'blur(12px)',
      }}
    >
      <div className="max-w-[1400px] mx-auto px-6 h-12 flex items-center gap-4">
        <div className="flex items-center gap-3 shrink-0">
          <span className="font-display font-bold text-white text-sm tracking-tight">
            syncular
          </span>
          <span
            className="w-1.5 h-1.5 rounded-full bg-healthy inline-block"
            style={{ boxShadow: '0 0 6px #22c55e' }}
          />
          <span className="font-mono text-[10px] text-healthy/70 uppercase tracking-widest">
            operational
          </span>
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-5 overflow-x-auto whitespace-nowrap [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
            {topicLinks.map((topic) => (
              <a
                key={`${topic.label}:${topic.href}`}
                href={topic.href}
                className="font-mono text-[11px] text-neutral-500 hover:text-white transition-colors uppercase tracking-wider"
              >
                {topic.label}
              </a>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {demoHref ? (
            <a
              href={demoHref}
              className="font-mono text-[11px] text-neutral-400 hover:text-white transition-colors border border-border px-2.5 py-1 rounded"
            >
              Demo
            </a>
          ) : null}
          {consoleHref ? (
            <a
              href={consoleHref}
              className="font-mono text-[11px] text-flow hover:text-white transition-colors border border-flow/40 px-2.5 py-1 rounded"
            >
              Console
            </a>
          ) : null}
          {githubHref ? (
            <a
              href={githubHref}
              target={isExternalHref(githubHref) ? '_blank' : undefined}
              rel={
                isExternalHref(githubHref) ? 'noreferrer noopener' : undefined
              }
              className="font-mono text-[11px] text-neutral-400 hover:text-white transition-colors border border-border px-2.5 py-1 rounded"
            >
              GitHub
            </a>
          ) : null}
        </div>
      </div>
    </nav>
  );
});
