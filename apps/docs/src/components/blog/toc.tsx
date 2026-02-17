'use client';

import {
  AnchorProvider,
  ScrollProvider,
  TOCItem,
  type TOCItemType,
} from 'fumadocs-core/toc';
import { useRef } from 'react';

export function BlogTOC({ items }: { items: TOCItemType[] }) {
  const containerRef = useRef<HTMLDivElement>(null);

  if (items.length === 0) return null;

  return (
    <AnchorProvider toc={items}>
      <nav aria-label="Table of contents">
        <p className="mb-3 font-mono text-[10px] uppercase tracking-widest text-fd-muted-foreground">
          On this page
        </p>
        <div
          ref={containerRef}
          className="flex max-h-[calc(100vh-8rem)] flex-col overflow-y-auto"
        >
          <ScrollProvider containerRef={containerRef}>
            {items.map((item) => (
              <TOCItem
                key={item.url}
                href={item.url}
                className="border-s border-fd-foreground/10 py-1.5 text-sm text-fd-muted-foreground transition-colors data-[active=true]:border-fd-primary data-[active=true]:text-fd-primary"
                style={{
                  paddingLeft:
                    item.depth <= 2 ? 12 : item.depth === 3 ? 24 : 32,
                }}
              >
                {item.title}
              </TOCItem>
            ))}
          </ScrollProvider>
        </div>
      </nav>
    </AnchorProvider>
  );
}
