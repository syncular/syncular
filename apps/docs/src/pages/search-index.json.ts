// The docs search index: every content page split into heading sections,
// in sidebar order (pages outside the sidebar last). Built to a static
// /search-index.json that the ⌘K dialog fetches on first open.
import type { MarkdownInstance } from 'astro';
import { nav } from '../nav';
import { searchSections } from '../search';

export async function GET(): Promise<Response> {
  const mods = import.meta.glob<MarkdownInstance<Record<string, never>>>(
    '../content/*.md',
    { eager: true },
  );
  const order = nav.flatMap((section) =>
    section.items.map((item) => item.slug),
  );
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
  return Response.json(sections.flat());
}
