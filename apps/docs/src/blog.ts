/**
 * Blog helpers shared by the index (pages/blog/index.astro) and the post
 * page (pages/blog/[slug].astro): frontmatter shape, ordering, reading time,
 * the chapter list, and the article HTML the post layout renders.
 */
import type { MarkdownHeading } from 'astro';

export interface BlogFrontmatter {
  readonly title: string;
  /** Search and social description; one or two sentences. */
  readonly description: string;
  /** One line under the title and on the index card; defaults to the description. */
  readonly summary?: string;
  readonly author: string;
  readonly publishedAt: string;
}

export interface Chapter {
  readonly slug: string;
  readonly text: string;
  readonly sections: readonly {
    readonly slug: string;
    readonly text: string;
  }[];
}

/** Minutes at 230 words per minute, counting prose only: code, HTML, and frontmatter excluded. */
export function readingMinutes(markdown: string): number {
  const prose = markdown
    .replace(/^---\n[\s\S]*?\n---\n/, '')
    .replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\s*$/gm, '')
    .replace(/<[^>]+>/g, ' ');
  const words = prose.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)?.length ?? 0;
  return Math.max(1, Math.round(words / 230));
}

export const formatDate = (
  value: string,
  month: 'long' | 'short' = 'long',
): string =>
  new Intl.DateTimeFormat('en', {
    year: 'numeric',
    month,
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${value}T00:00:00Z`));

/** h2 headings become chapters; h3 headings nest under the chapter above them. */
export function chaptersOf(headings: readonly MarkdownHeading[]): Chapter[] {
  const chapters: {
    slug: string;
    text: string;
    sections: { slug: string; text: string }[];
  }[] = [];
  for (const heading of headings) {
    if (heading.depth === 2) {
      chapters.push({ slug: heading.slug, text: heading.text, sections: [] });
    } else if (heading.depth === 3) {
      chapters
        .at(-1)
        ?.sections.push({ slug: heading.slug, text: heading.text });
    }
  }
  return chapters;
}

/**
 * The rendered post without its `# Title` (the layout renders the title with
 * the date and summary), and with an anchor link on every h2 and h3.
 */
export function articleHtml(html: string): string {
  return html
    .replace(/<h1\b[^>]*>[\s\S]*?<\/h1>\s*/, '')
    .replace(
      /<h([23]) id="([^"]+)">([\s\S]*?)<\/h\1>/g,
      (_, level: string, id: string, inner: string) =>
        `<h${level} id="${id}">${inner}<a class="heading-anchor" href="#${id}" aria-label="Link to this section">#</a></h${level}>`,
    );
}
