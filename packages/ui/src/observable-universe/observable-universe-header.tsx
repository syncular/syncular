'use client';

import { ExternalLink, Github, Star } from 'lucide-react';
import { forwardRef } from 'react';
import { cn } from '../lib/cn';
import { UI_VERSION } from '../version';

export interface ObservableUniverseHeaderTopicLink {
  label: string;
  href: string;
}

export interface ObservableUniverseHeaderProps {
  topicLinks?: ObservableUniverseHeaderTopicLink[];
  demoHref?: string;
  consoleHref?: string;
  githubHref?: string;
  githubStars?: number | null;
  className?: string;
}

const DEFAULT_TOPIC_LINKS: ObservableUniverseHeaderTopicLink[] = [
  { label: 'Introduction', href: '/docs/introduction' },
  { label: 'Build', href: '/docs/build' },
  { label: 'Client SDK', href: '/docs/client-sdk' },
  { label: 'Server', href: '/docs/server' },
  { label: 'API', href: '/docs/api' },
];

function isExternalHref(href: string): boolean {
  return href.startsWith('http://') || href.startsWith('https://');
}

function formatCompactCount(value: number): string {
  if (value < 1000) return value.toString();
  if (value < 10_000) {
    const short = (value / 1000).toFixed(1);
    return `${short.endsWith('.0') ? short.slice(0, -2) : short}k`;
  }
  if (value < 1_000_000) {
    return `${Math.floor(value / 1000)}k`;
  }
  const short = (value / 1_000_000).toFixed(1);
  return `${short.endsWith('.0') ? short.slice(0, -2) : short}m`;
}

export const ObservableUniverseHeader = forwardRef<
  HTMLElement,
  ObservableUniverseHeaderProps
>(function ObservableUniverseHeader(
  {
    topicLinks = DEFAULT_TOPIC_LINKS,
    demoHref,
    consoleHref,
    githubHref = 'https://github.com/syncular/syncular',
    githubStars,
    className,
  },
  ref
) {
  const formattedStars =
    typeof githubStars === 'number' ? formatCompactCount(githubStars) : null;

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
        <a href="/" className="flex items-center gap-3 shrink-0">
          <span className="font-display font-bold text-white text-sm tracking-tight">
            syncular
          </span>
          <span
            className="w-1.5 h-1.5 rounded-full bg-amber-400 inline-block"
            style={{ boxShadow: '0 0 6px #f59e0b' }}
          />
          <span className="font-mono text-[10px] text-amber-300/80 uppercase tracking-widest">
            alpha
          </span>
          <span className="font-mono text-[10px] text-neutral-500 tracking-wider">
            v{UI_VERSION}
          </span>
        </a>

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
              target={isExternalHref(demoHref) ? '_blank' : undefined}
              rel={isExternalHref(demoHref) ? 'noreferrer noopener' : undefined}
              className="font-mono text-[11px] text-white transition-colors bg-purple-600 hover:bg-purple-500 px-3 py-1 rounded flex items-center gap-1.5"
            >
              Demo
              <ExternalLink className="size-2.5 opacity-50" />
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
              className={cn(
                'text-neutral-400 hover:text-white transition-colors border border-border rounded inline-flex items-center',
                formattedStars ? 'px-2.5 py-1 gap-1.5' : 'p-1.5'
              )}
              aria-label={
                formattedStars ? `GitHub (${formattedStars} stars)` : 'GitHub'
              }
            >
              <Github className="size-3.5" />
              {formattedStars ? (
                <span className="font-mono text-[10px] text-neutral-300 inline-flex items-center gap-1">
                  <Star className="size-2.5" />
                  {formattedStars}
                </span>
              ) : null}
            </a>
          ) : null}
        </div>
      </div>
    </nav>
  );
});
