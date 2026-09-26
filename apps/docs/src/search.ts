// Docs search: the build splits every rendered page into heading sections
// (src/pages/search-index.json.ts), and the ⌘K dialog (components/Search.astro)
// ranks those sections in the browser. Both halves and the tests share this
// module.

export interface SearchSection {
  readonly page: string;
  readonly heading: string;
  readonly href: string;
  readonly text: string;
}

export interface SearchHit {
  readonly section: SearchSection;
  readonly excerpt: string;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

const plainText = (html: string): string =>
  html
    .replaceAll(/<[^>]+>/g, ' ')
    .replaceAll(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
      if (name.startsWith('#x') || name.startsWith('#X')) {
        return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
      }
      if (name.startsWith('#')) {
        return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
      }
      return ENTITIES[name.toLowerCase()] ?? entity;
    })
    .replaceAll(/\s+/g, ' ')
    .replaceAll(/ ([.,;:!?)\]])/g, '$1')
    .trim();

/** Split one rendered page at its h1–h3 headings; the h1 section is the intro. */
export function searchSections(
  page: string,
  slug: string,
  html: string,
): SearchSection[] {
  const headings = [
    ...html.matchAll(/<h([1-3])\b[^>]*\bid="([^"]*)"[^>]*>([\s\S]*?)<\/h\1>/g),
  ];
  return headings.flatMap((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = headings[index + 1]?.index ?? html.length;
    const text = plainText(html.slice(start, end));
    const heading = plainText(match[3] ?? '');
    if (text === '' && match[1] !== '1') return [];
    return [
      {
        page,
        heading: match[1] === '1' ? page : heading,
        href: match[1] === '1' ? `/${slug}/` : `/${slug}/#${match[2]}`,
        text,
      },
    ];
  });
}

const terms = (query: string): string[] =>
  query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term !== '');

const occurrences = (haystack: string, term: string): number => {
  let count = 0;
  for (
    let at = haystack.indexOf(term);
    at !== -1 && count < 5;
    at = haystack.indexOf(term, at + term.length)
  ) {
    count++;
  }
  return count;
};

/**
 * Rank sections for a query. Every term must appear in the section's page
 * title, heading, or body; heading hits outrank title hits, which outrank
 * body hits. Ties keep index order (nav order).
 */
export function searchIndex(
  sections: readonly SearchSection[],
  query: string,
  limit = 20,
): SearchHit[] {
  const wanted = terms(query);
  if (wanted.length === 0) return [];
  const phrase = wanted.join(' ');
  const scored: { section: SearchSection; score: number; order: number }[] = [];
  sections.forEach((section, order) => {
    const heading = section.heading.toLowerCase();
    const page = section.page.toLowerCase();
    const text = section.text.toLowerCase();
    let score = heading.includes(phrase) ? 20 : 0;
    for (const term of wanted) {
      const inHeading = heading.includes(term);
      const inPage = page.includes(term);
      const inText = occurrences(text, term);
      if (!inHeading && !inPage && inText === 0) return;
      score += (inHeading ? 10 : 0) + (inPage ? 4 : 0) + inText;
    }
    scored.push({ section, score, order });
  });
  return scored
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, limit)
    .map(({ section }) => ({
      section,
      excerpt: excerpt(section.text, wanted),
    }));
}

const excerpt = (text: string, wanted: readonly string[]): string => {
  const lower = text.toLowerCase();
  const at = Math.min(
    ...wanted.map((term) => {
      const index = lower.indexOf(term);
      return index === -1 ? Number.POSITIVE_INFINITY : index;
    }),
  );
  if (!Number.isFinite(at)) return text.slice(0, 140);
  const start = Math.max(0, at - 50);
  return `${start > 0 ? '…' : ''}${text.slice(start, start + 140)}${start + 140 < text.length ? '…' : ''}`;
};

const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

/** HTML-escape `text` and wrap every query-term occurrence in `<mark>`. */
export function highlight(text: string, query: string): string {
  const wanted = terms(query).map((term) =>
    term.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  );
  if (wanted.length === 0) return escapeHtml(text);
  return text
    .split(new RegExp(`(${wanted.join('|')})`, 'gi'))
    .map((part, index) =>
      index % 2 === 1 ? `<mark>${escapeHtml(part)}</mark>` : escapeHtml(part),
    )
    .join('');
}
