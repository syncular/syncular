import { Badge } from '@syncular/ui/primitives';
import defaultMdxComponents from 'fumadocs-ui/mdx';
import { ArrowLeft } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BlogTOC } from '@/components/blog/toc';
import { blog } from '@/lib/source';

function formatDate(date: string | Date): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(date));
}

export default async function BlogPostPage(props: {
  params: Promise<{ slug: string }>;
}) {
  const params = await props.params;
  const page = blog.getPage([params.slug]);

  if (!page) notFound();

  const Mdx = page.data.body;

  return (
    <main className="mx-auto w-full max-w-6xl px-4 pb-24 pt-16 md:px-8">
      <Link
        href="/blog"
        className="mb-10 inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to blog
      </Link>

      <header className="mb-12 max-w-3xl animate-fade-up">
        <div className="mb-4 flex items-center gap-3">
          {page.data.date ? (
            <Badge variant="default">
              <time dateTime={String(page.data.date)}>
                {formatDate(page.data.date)}
              </time>
            </Badge>
          ) : null}
          {page.data.author ? (
            <span className="font-mono text-[11px] text-muted-foreground">
              by {page.data.author}
            </span>
          ) : null}
        </div>
        <h1
          className="mb-4 text-3xl font-bold tracking-tight text-foreground md:text-4xl lg:text-5xl"
          style={{ fontFamily: 'var(--font-syne), sans-serif' }}
        >
          {page.data.title}
        </h1>
        {page.data.description ? (
          <p
            className="max-w-2xl text-lg leading-relaxed text-muted-foreground"
            style={{ fontFamily: 'var(--font-inter-tight), sans-serif' }}
          >
            {page.data.description}
          </p>
        ) : null}
      </header>

      <div className="flex gap-12">
        <article className="blog-prose min-w-0 max-w-3xl flex-1">
          <Mdx components={defaultMdxComponents} />
        </article>

        <aside className="hidden w-52 shrink-0 xl:block">
          <div className="sticky top-24">
            <BlogTOC items={page.data.toc} />
          </div>
        </aside>
      </div>
    </main>
  );
}

export function generateStaticParams(): { slug: string }[] {
  return blog.getPages().map((page) => ({
    slug: page.slugs[0],
  }));
}

export async function generateMetadata(props: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const params = await props.params;
  const page = blog.getPage([params.slug]);

  if (!page) notFound();

  return {
    title: page.data.title,
    description: page.data.description,
  };
}
