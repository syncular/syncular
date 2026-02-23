'use client';

import { forwardRef } from 'react';
import { cn } from '../lib/cn';
import { ArchitectureSection } from './architecture-section';
import { CodeSection } from './code-section';
import { ExplanationSection } from './explanation-section';
import { FooterBar } from './footer-bar';
import { HeroDashboardSection } from './hero-dashboard-section';
import { InstallSection } from './install-section';
import {
  ObservableUniverseHeader,
  type ObservableUniverseHeaderTopicLink,
} from './observable-universe-header';
import { useObservableUniverseSimulation } from './use-observable-universe-simulation';

export interface ObservableUniverseLandingProps {
  docsHref?: string;
  topicLinks?: ObservableUniverseHeaderTopicLink[];
  demoHref?: string;
  consoleHref?: string;
  githubHref?: string;
  githubStars?: number | null;
  className?: string;
}

export const ObservableUniverseLanding = forwardRef<
  HTMLDivElement,
  ObservableUniverseLandingProps
>(function ObservableUniverseLanding(
  {
    docsHref,
    topicLinks,
    demoHref,
    consoleHref,
    githubHref,
    githubStars,
    className,
  },
  ref
) {
  const { clients, entries, metrics, streamRate } =
    useObservableUniverseSimulation();

  return (
    <div
      ref={ref}
      className={cn('bg-surface text-foreground min-h-screen', className)}
    >
      <ObservableUniverseHeader
        topicLinks={topicLinks}
        demoHref={demoHref}
        consoleHref={consoleHref}
        githubHref={githubHref}
        githubStars={githubStars}
      />
      <HeroDashboardSection
        clients={clients}
        streamEntries={entries}
        metrics={metrics}
        streamRate={streamRate}
      />
      <ExplanationSection />
      <ArchitectureSection />
      <CodeSection />
      <InstallSection
        docsHref={docsHref}
        demoHref={demoHref}
        githubHref={githubHref}
      />
      <FooterBar />
    </div>
  );
});
