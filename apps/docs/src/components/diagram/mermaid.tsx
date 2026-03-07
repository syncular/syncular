'use client';

import { startTransition, useEffect, useRef, useState } from 'react';

type MermaidProps = {
  caption?: string;
  chart?: string;
  children?: string;
  className?: string;
};

function getMermaidTheme() {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'neutral';
}

async function loadMermaid() {
  const mod = await import('mermaid');
  return mod.default;
}

export function Mermaid({ caption, chart, children, className }: MermaidProps) {
  const source = (chart ?? children ?? '').trim();
  const containerRef = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!source) return;

    let cancelled = false;

    const renderDiagram = async () => {
      try {
        const mermaid = await loadMermaid();

        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: getMermaidTheme(),
          fontFamily: 'var(--font-inter-tight), ui-sans-serif, system-ui, sans-serif',
          flowchart: {
            curve: 'basis',
            htmlLabels: false,
            nodeSpacing: 36,
            rankSpacing: 48,
            useMaxWidth: false,
          },
          sequence: {
            diagramMarginX: 28,
            diagramMarginY: 20,
            actorMargin: 48,
            width: 180,
            height: 56,
            boxMargin: 12,
            boxTextMargin: 8,
            noteMargin: 12,
            messageMargin: 28,
            mirrorActors: false,
            useMaxWidth: false,
          },
          themeVariables: {
            fontSize: '15px',
            lineColor: '#a855f7',
          },
        });

        const { svg: nextSvg, bindFunctions } = await mermaid.render(
          `syncular-diagram-${Math.random().toString(36).slice(2)}`,
          source
        );

        if (cancelled) return;

        startTransition(() => {
          setSvg(nextSvg);
          setError(null);
        });

        queueMicrotask(() => {
          if (cancelled) return;
          const container = containerRef.current;
          if (container && bindFunctions) bindFunctions(container);
        });
      } catch (err) {
        if (cancelled) return;

        startTransition(() => {
          setSvg(null);
          setError(err instanceof Error ? err.message : 'Failed to render diagram.');
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
  }, [source]);

  return (
    <figure className={['sync-diagram', className].filter(Boolean).join(' ')}>
      <div className="sync-diagram__canvas" ref={containerRef}>
        {svg ? (
          <div dangerouslySetInnerHTML={{ __html: svg }} />
        ) : error ? (
          <div className="sync-diagram__fallback">
            <p className="sync-diagram__error">{error}</p>
            <pre>{source}</pre>
          </div>
        ) : (
          <div className="sync-diagram__loading">Rendering diagram...</div>
        )}
      </div>
      {caption ? <figcaption className="sync-diagram__caption">{caption}</figcaption> : null}
    </figure>
  );
}
