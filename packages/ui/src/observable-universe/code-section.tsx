'use client';

import { forwardRef } from 'react';
import { cn } from '../lib/cn';
import { SectionHeading } from './section-heading';

export interface CodeSectionProps {
  className?: string;
}

interface CodeBlock {
  filename: string;
  description: string;
  dotColor: string;
  content: React.ReactNode;
}

const codeBlocks: CodeBlock[] = [
  {
    filename: 'client.ts',
    description: 'Setup the client',
    dotColor: 'bg-healthy',
    content: (
      <>
        <span className="text-violet-400">import</span>{' '}
        <span className="text-neutral-300">{'{ createClient }'}</span>{' '}
        <span className="text-violet-400">from</span>{' '}
        <span className="text-emerald-400">&apos;@syncular/client&apos;</span>
        {'\n'}
        <span className="text-violet-400">import</span>{' '}
        <span className="text-neutral-300">{'{ createHttpTransport }'}</span>{' '}
        <span className="text-violet-400">from</span>{' '}
        <span className="text-emerald-400">
          &apos;@syncular/transport-http&apos;
        </span>
        {'\n\n'}
        <span className="text-violet-400">const</span>{' '}
        <span className="text-blue-300">client</span>{' '}
        <span className="text-neutral-500">=</span>{' '}
        <span className="text-yellow-300">createClient</span>
        <span className="text-neutral-500">{'({'}</span>
        {'\n'}
        {'  '}
        <span className="text-neutral-300">transport:</span>{' '}
        <span className="text-yellow-300">createHttpTransport</span>
        <span className="text-neutral-500">{'({'}</span>
        {'\n'}
        {'    '}
        <span className="text-neutral-300">baseUrl:</span>{' '}
        <span className="text-emerald-400">
          &apos;https://api.example.com&apos;
        </span>
        {'\n'}
        {'  '}
        <span className="text-neutral-500">{'})'}</span>
        <span className="text-neutral-500">,</span>
        {'\n'}
        {'  '}
        <span className="text-neutral-300">tables:</span>{' '}
        <span className="text-neutral-500">{'{'}</span>{' '}
        <span className="text-neutral-300">todos:</span>{' '}
        <span className="text-neutral-500">{'{}'}</span>
        <span className="text-neutral-500">,</span>{' '}
        <span className="text-neutral-300">projects:</span>{' '}
        <span className="text-neutral-500">{'{}'}</span>{' '}
        <span className="text-neutral-500">{'}'}</span>
        {'\n'}
        <span className="text-neutral-500">{'})'}</span>
      </>
    ),
  },
  {
    filename: 'mutation.ts',
    description: 'Make a mutation',
    dotColor: 'bg-syncing',
    content: (
      <>
        <span className="text-neutral-500">
          {'// Writes go to local SQLite first, then sync'}
        </span>
        {'\n'}
        <span className="text-violet-400">await</span>{' '}
        <span className="text-blue-300">client</span>
        <span className="text-neutral-500">.</span>
        <span className="text-blue-300">db</span>
        {'\n'}
        {'  '}
        <span className="text-neutral-500">.</span>
        <span className="text-yellow-300">insertInto</span>
        <span className="text-neutral-500">(</span>
        <span className="text-emerald-400">&apos;todos&apos;</span>
        <span className="text-neutral-500">)</span>
        {'\n'}
        {'  '}
        <span className="text-neutral-500">.</span>
        <span className="text-yellow-300">values</span>
        <span className="text-neutral-500">({'{'}</span>
        {'\n'}
        {'    '}
        <span className="text-neutral-300">id:</span>{' '}
        <span className="text-yellow-300">crypto</span>
        <span className="text-neutral-500">.</span>
        <span className="text-yellow-300">randomUUID</span>
        <span className="text-neutral-500">()</span>
        <span className="text-neutral-500">,</span>
        {'\n'}
        {'    '}
        <span className="text-neutral-300">title:</span>{' '}
        <span className="text-emerald-400">&apos;Ship the feature&apos;</span>
        <span className="text-neutral-500">,</span>
        {'\n'}
        {'    '}
        <span className="text-neutral-300">done:</span>{' '}
        <span className="text-orange-400">false</span>
        {'\n'}
        {'  '}
        <span className="text-neutral-500">{'})'}</span>
        {'\n'}
        {'  '}
        <span className="text-neutral-500">.</span>
        <span className="text-yellow-300">execute</span>
        <span className="text-neutral-500">()</span>
      </>
    ),
  },
  {
    filename: 'component.tsx',
    description: 'Reactive query (React)',
    dotColor: 'bg-flow',
    content: (
      <>
        <span className="text-violet-400">import</span>{' '}
        <span className="text-neutral-300">{'{ useQuery }'}</span>{' '}
        <span className="text-violet-400">from</span>{' '}
        <span className="text-emerald-400">
          &apos;@syncular/client-react&apos;
        </span>
        {'\n\n'}
        <span className="text-violet-400">function</span>{' '}
        <span className="text-yellow-300">TodoList</span>
        <span className="text-neutral-500">() {'{'}</span>
        {'\n'}
        {'  '}
        <span className="text-violet-400">const</span>{' '}
        <span className="text-blue-300">todos</span>{' '}
        <span className="text-neutral-500">=</span>{' '}
        <span className="text-yellow-300">useQuery</span>
        <span className="text-neutral-500">(</span>
        {'\n'}
        {'    '}
        <span className="text-neutral-500">(</span>
        <span className="text-orange-300">db</span>
        <span className="text-neutral-500">) =&gt;</span>{' '}
        <span className="text-orange-300">db</span>
        <span className="text-neutral-500">.</span>
        <span className="text-yellow-300">selectFrom</span>
        <span className="text-neutral-500">(</span>
        <span className="text-emerald-400">&apos;todos&apos;</span>
        <span className="text-neutral-500">).</span>
        <span className="text-yellow-300">selectAll</span>
        <span className="text-neutral-500">().</span>
        <span className="text-yellow-300">execute</span>
        <span className="text-neutral-500">()</span>
        {'\n'}
        {'  '}
        <span className="text-neutral-500">)</span>
        {'\n'}
        {'  '}
        <span className="text-neutral-500">
          {'// Re-renders when any client pushes changes'}
        </span>
        {'\n'}
        {'  '}
        <span className="text-violet-400">return</span>{' '}
        <span className="text-neutral-300">todos</span>
        <span className="text-neutral-500">.</span>
        <span className="text-yellow-300">map</span>
        <span className="text-neutral-500">((</span>
        <span className="text-orange-300">t</span>
        <span className="text-neutral-500">) =&gt; &lt;</span>
        <span className="text-blue-300">Todo</span>{' '}
        <span className="text-neutral-300">key</span>
        <span className="text-neutral-500">=&#123;</span>
        <span className="text-orange-300">t</span>
        <span className="text-neutral-500">.</span>
        <span className="text-neutral-300">id</span>
        <span className="text-neutral-500">&#125;</span>{' '}
        <span className="text-neutral-300">todo</span>
        <span className="text-neutral-500">=&#123;</span>
        <span className="text-orange-300">t</span>
        <span className="text-neutral-500">&#125; /&gt;)</span>
        {'\n'}
        <span className="text-neutral-500">{'}'}</span>
      </>
    ),
  },
  {
    filename: 'server.ts',
    description: 'Server setup',
    dotColor: 'bg-violet-400',
    content: (
      <>
        <span className="text-violet-400">import</span>{' '}
        <span className="text-neutral-300">{'{ createServer }'}</span>{' '}
        <span className="text-violet-400">from</span>{' '}
        <span className="text-emerald-400">&apos;@syncular/server&apos;</span>
        {'\n'}
        <span className="text-violet-400">import</span>{' '}
        <span className="text-neutral-300">{'{ createHonoApp }'}</span>{' '}
        <span className="text-violet-400">from</span>{' '}
        <span className="text-emerald-400">
          &apos;@syncular/server-hono&apos;
        </span>
        {'\n\n'}
        <span className="text-violet-400">const</span>{' '}
        <span className="text-blue-300">server</span>{' '}
        <span className="text-neutral-500">=</span>{' '}
        <span className="text-yellow-300">createServer</span>
        <span className="text-neutral-500">({'{'}</span>
        {'\n'}
        {'  '}
        <span className="text-neutral-300">dialect:</span>{' '}
        <span className="text-emerald-400">&apos;sqlite&apos;</span>
        <span className="text-neutral-500">,</span>
        {'\n'}
        {'  '}
        <span className="text-neutral-300">tables:</span>{' '}
        <span className="text-neutral-500">{'{'}</span>
        {'\n'}
        {'    '}
        <span className="text-neutral-300">todos:</span>{' '}
        <span className="text-neutral-500">{'{'}</span>{' '}
        <span className="text-neutral-300">columns:</span>{' '}
        <span className="text-neutral-500">{'{'}</span>{' '}
        <span className="text-neutral-300">title:</span>{' '}
        <span className="text-emerald-400">&apos;text&apos;</span>
        <span className="text-neutral-500">,</span>{' '}
        <span className="text-neutral-300">done:</span>{' '}
        <span className="text-emerald-400">&apos;boolean&apos;</span>{' '}
        <span className="text-neutral-500">
          {'}'} {'}'},
        </span>
        {'\n'}
        {'    '}
        <span className="text-neutral-300">projects:</span>{' '}
        <span className="text-neutral-500">{'{'}</span>{' '}
        <span className="text-neutral-300">columns:</span>{' '}
        <span className="text-neutral-500">{'{'}</span>{' '}
        <span className="text-neutral-300">name:</span>{' '}
        <span className="text-emerald-400">&apos;text&apos;</span>{' '}
        <span className="text-neutral-500">
          {'}'} {'}'}
        </span>
        {'\n'}
        {'  '}
        <span className="text-neutral-500">{'}'}</span>
        {'\n'}
        <span className="text-neutral-500">{'})'}</span>
        {'\n\n'}
        <span className="text-violet-400">export default</span>{' '}
        <span className="text-yellow-300">createHonoApp</span>
        <span className="text-neutral-500">({'{'}</span>{' '}
        <span className="text-neutral-300">server</span>{' '}
        <span className="text-neutral-500">{'})'}</span>
      </>
    ),
  },
];

export const CodeSection = forwardRef<HTMLElement, CodeSectionProps>(
  function CodeSection({ className }, ref) {
    return (
      <section
        ref={ref}
        id="code"
        className={cn('py-24 border-t border-border', className)}
      >
        <div className="max-w-[1400px] mx-auto px-6">
          <SectionHeading
            label="Developer experience"
            title="Simple code. Observable power."
            description="All that dashboard complexity comes from a handful of lines. Syncular handles the hard parts -- conflict resolution, offline queuing, incremental sync -- so you write normal database code."
          />

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {codeBlocks.map((block) => (
              <div key={block.filename} className="code-block">
                <div className="code-header">
                  <span
                    className={cn(
                      'w-2 h-2 rounded-full inline-block',
                      block.dotColor
                    )}
                  />
                  <span>{block.filename}</span>
                  <span className="ml-auto text-neutral-600">
                    {block.description}
                  </span>
                </div>
                <pre
                  className="font-mono text-[13px]"
                  style={{ padding: '1.25rem', lineHeight: 1.7 }}
                >
                  <code>{block.content}</code>
                </pre>
              </div>
            ))}
          </div>
        </div>
      </section>
    );
  }
);
