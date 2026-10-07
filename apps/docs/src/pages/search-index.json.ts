// The docs search index: every content page split into heading sections,
// in sidebar order (pages outside the sidebar last), then the blog posts.
// Built to a static /search-index.json that the ⌘K dialog fetches on first
// open.
import type { MarkdownInstance } from 'astro';
import { navPages } from '../nav';
import { searchSections } from '../search';

export async function GET(): Promise<Response> {
  const mods = import.meta.glob<MarkdownInstance<Record<string, never>>>(
    '../content/*.md',
    { eager: true },
  );
  const order = navPages.map((entry) => entry.slug);
  const rank = (slug: string) => {
    const index = order.indexOf(slug);
    return index === -1 ? order.length : index;
  };
  const pages = Object.entries(mods)
    .map(([path, mod]) => ({
      slug: path.split('/').pop()?.replace(/\.md$/, '') ?? '',
      mod,
    }))
    .sort((a, b) => rank(a.slug) - rank(b.slug));
  const sections = await Promise.all(
    pages.map(async ({ slug, mod }) =>
      searchSections(
        mod.getHeadings().find((h) => h.depth === 1)?.text ?? slug,
        slug,
        await mod.compiledContent(),
      ),
    ),
  );
  // Blog posts follow the docs pages, newest first.
  const posts = Object.entries(
    import.meta.glob<MarkdownInstance<{ publishedAt: string }>>(
      '../content/blog/*.md',
      { eager: true },
    ),
  ).sort(([, a], [, b]) =>
    b.frontmatter.publishedAt.localeCompare(a.frontmatter.publishedAt),
  );
  const postSections = await Promise.all(
    posts.map(async ([path, mod]) =>
      searchSections(
        mod.getHeadings().find((h) => h.depth === 1)?.text ?? 'Blog',
        `blog/${path.split('/').pop()?.replace(/\.md$/, '') ?? ''}`,
        await mod.compiledContent(),
      ),
    ),
  );
  return Response.json([...sections.flat(), ...postSections.flat()]);
}
