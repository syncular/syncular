import { Badge } from '@syncular/ui/primitives';
import { ArrowRight } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { blog } from '@/lib/source';

export const metadata: Metadata = {
  title: 'Blog',
  description:
    'Engineering notes on offline-first architecture, sync, and production learnings.',
};

function formatDate(date: string | Date): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(date));
}

export default function BlogIndexPage() {
  const posts = [...blog.getPages()].sort((a, b) => {
    const dateA = new Date(a.data.date ?? 0);
    const dateB = new Date(b.data.date ?? 0);
    return dateB.getTime() - dateA.getTime();
  });

  return (
    <main className="mx-auto w-full max-w-3xl px-4 pb-24 pt-20 md:px-8">
      <header className="mb-16 animate-fade-up">
        <Badge variant="flow" className="mb-5">
          Engineering Journal
        </Badge>
        <h1
          className="mb-4 text-4xl font-bold tracking-tight md:text-5xl"
          style={{ fontFamily: 'var(--font-syne), sans-serif' }}
        >
          Blog
        </h1>
        <p className="max-w-xl text-base leading-relaxed text-muted-foreground md:text-lg">
          Long-form writeups on offline-first architecture, sync tradeoffs, and
          practical lessons from building Syncular.
        </p>
      </header>

      {posts.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-card/40 p-10 text-center text-sm text-muted-foreground">
          No posts yet. Check back soon.
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          {posts.map((post, i) => (
            <Link
              key={post.url}
              href={post.url}
              className="group -mx-4 flex flex-col rounded-xl p-4 transition-colors hover:bg-white/[0.03] md:-mx-6 md:p-6"
              style={{ animationDelay: `${i * 80}ms` }}
            >
              <div className="mb-3 flex items-center gap-3">
                {post.data.date ? (
                  <time
                    dateTime={String(post.data.date)}
                    className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground"
                  >
                    {formatDate(post.data.date)}
                  </time>
                ) : null}
                {post.data.author ? (
                  <>
                    <span className="text-border">&middot;</span>
                    <span className="font-mono text-[11px] text-muted-foreground">
                      {post.data.author}
                    </span>
                  </>
                ) : null}
              </div>
              <h2
                className="mb-2 text-xl font-semibold tracking-tight text-foreground transition-colors group-hover:text-white md:text-2xl"
                style={{ fontFamily: 'var(--font-syne), sans-serif' }}
              >
                {post.data.title}
              </h2>
              {post.data.description ? (
                <p className="mb-4 max-w-2xl text-sm leading-relaxed text-muted-foreground md:text-base">
                  {post.data.description}
                </p>
              ) : null}
              <span className="inline-flex items-center gap-1.5 text-sm font-medium text-purple-400 transition-all group-hover:gap-2.5">
                Read post
                <ArrowRight className="h-3.5 w-3.5" />
              </span>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
