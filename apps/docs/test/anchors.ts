/**
 * The anchors a content page renders, read from its markdown source: every
 * `#` heading plus every `:::step{title}` (steps render their title as an h3).
 * Shared by the internal-link and redirect tests.
 */
// GitHub-slugger shape, matching Astro's markdown heading ids.
const slugify = (heading: string): string =>
  heading
    .toLowerCase()
    .replaceAll(/`/g, '')
    .replaceAll(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replaceAll(/\s/g, '-');

export function headingAnchors(markdown: string): Set<string> {
  const anchors = new Set<string>();
  for (const match of markdown.matchAll(/^#{1,6}\s+(.+)$/gm)) {
    if (match[1] !== undefined)
      anchors.add(slugify(match[1].replaceAll(/\[([^\]]*)\]\([^)]*\)/g, '$1')));
  }
  for (const match of markdown.matchAll(/^:+step\{[^}]*title="([^"]+)"/gm)) {
    if (match[1] !== undefined) anchors.add(slugify(match[1]));
  }
  return anchors;
}
