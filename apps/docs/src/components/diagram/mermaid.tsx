'use client';

import { startTransition, useEffect, useMemo, useRef, useState } from 'react';

type MermaidProps = {
  caption?: string;
  chart?: string;
  children?: string;
  className?: string;
};

type DiagramKind = 'flowchart' | 'sequence' | 'generic';

function getDiagramKind(source: string): DiagramKind {
  const trimmed = source.trimStart();

  if (trimmed.startsWith('sequenceDiagram')) {
    return 'sequence';
  }

  if (trimmed.startsWith('flowchart') || trimmed.startsWith('graph')) {
    return 'flowchart';
  }

  return 'generic';
}

function getDiagramWidthCap(kind: DiagramKind) {
  switch (kind) {
    case 'sequence':
      return 840;
    case 'flowchart':
      return 720;
    default:
      return 760;
  }
}

function getMermaidTheme() {
  return document.documentElement.classList.contains('dark')
    ? 'dark'
    : 'neutral';
}

async function loadMermaid() {
  const mod = await import('mermaid');
  return mod.default;
}

export function Mermaid({ caption, chart, children, className }: MermaidProps) {
  const source = (chart ?? children ?? '').trim();
  const diagramKind = useMemo(() => getDiagramKind(source), [source]);
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>(
    'loading'
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!source) return;

    let cancelled = false;

    const renderDiagram = async () => {
      try {
        startTransition(() => {
          setStatus('loading');
          setError(null);
        });

        const mermaid = await loadMermaid();

        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: getMermaidTheme(),
          fontFamily:
            'var(--font-inter-tight), ui-sans-serif, system-ui, sans-serif',
          flowchart: {
            curve: 'linear',
            htmlLabels: false,
            nodeSpacing: 18,
            rankSpacing: 22,
            padding: 8,
            useMaxWidth: true,
          },
          sequence: {
            diagramMarginX: 12,
            diagramMarginY: 12,
            actorMargin: 18,
            width: 108,
            height: 34,
            boxMargin: 6,
            boxTextMargin: 5,
            noteMargin: 6,
            messageMargin: 14,
            mirrorActors: false,
            useMaxWidth: true,
          },
          themeVariables: {
            fontSize: '12px',
            primaryColor: '#101016',
            primaryTextColor: '#f4f4f5',
            primaryBorderColor: '#3f3f46',
            secondaryColor: '#0c0c12',
            secondaryTextColor: '#f4f4f5',
            secondaryBorderColor: '#2a2a34',
            tertiaryColor: '#09090b',
            tertiaryTextColor: '#f4f4f5',
            tertiaryBorderColor: '#232329',
            noteBkgColor: '#111118',
            noteBorderColor: '#2f2f3b',
            clusterBkg: '#050507',
            clusterBorder: '#232329',
            actorBkg: '#101016',
            actorBorder: '#3f3f46',
            actorTextColor: '#f4f4f5',
            signalColor: '#d8b4fe',
            signalTextColor: '#f4f4f5',
            labelBoxBkgColor: '#050507',
            labelBoxBorderColor: '#232329',
            edgeLabelBackground: '#050507',
            lineColor: '#c084fc',
          },
        });

        const { svg: nextSvg, bindFunctions } = await mermaid.render(
          `syncular-diagram-${Math.random().toString(36).slice(2)}`,
          source
        );

        if (cancelled) return;

        const container = containerRef.current;
        if (container) {
          const doc = new DOMParser().parseFromString(nextSvg, 'text/html');
          const svgElement = doc.body.querySelector('svg');
          if (!svgElement) {
            throw new Error('Failed to render diagram.');
          }
          const widthCap = getDiagramWidthCap(diagramKind);
          const figure = container.closest<HTMLElement>('.sync-diagram');
          const viewBox = svgElement.getAttribute('viewBox');
          const [, , viewBoxWidth] = viewBox?.split(/\s+/) ?? [];
          const intrinsicWidth = Number.parseFloat(viewBoxWidth ?? '');
          const fittedWidth =
            Number.isFinite(intrinsicWidth) && intrinsicWidth > 0
              ? Math.min(intrinsicWidth, widthCap)
              : widthCap;

          figure?.style.setProperty(
            '--sync-diagram-fit-width',
            `${fittedWidth}px`
          );
          figure?.setAttribute('data-diagram-kind', diagramKind);

          svgElement.removeAttribute('width');
          svgElement.removeAttribute('height');
          svgElement.setAttribute('preserveAspectRatio', 'xMidYMid meet');
          svgElement.classList.add('sync-diagram__svg');
          container.replaceChildren(document.importNode(svgElement, true));
          if (bindFunctions) bindFunctions(container);
        }

        startTransition(() => {
          setStatus('ready');
          setError(null);
        });
      } catch (err) {
        if (cancelled) return;

        containerRef.current?.replaceChildren();

        startTransition(() => {
          setStatus('error');
          setError(
            err instanceof Error ? err.message : 'Failed to render diagram.'
          );
        });
      }
    };

    void renderDiagram();

    const observer = new MutationObserver(() => {
      void renderDiagram();
    });

    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-theme'],
    });

    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [diagramKind, source]);

  return (
    <figure className={['sync-diagram', className].filter(Boolean).join(' ')}>
      <div className="sync-diagram__canvas">
        <div
          className="sync-diagram__mount"
          hidden={status !== 'ready'}
          ref={containerRef}
        />
        {status === 'error' ? (
          <div className="sync-diagram__fallback">
            <p className="sync-diagram__error">{error}</p>
            <pre>{source}</pre>
          </div>
        ) : null}
        {status === 'loading' ? (
          <div className="sync-diagram__loading">Rendering diagram...</div>
        ) : null}
      </div>
      {caption ? (
        <figcaption className="sync-diagram__caption">{caption}</figcaption>
      ) : null}
    </figure>
  );
}
