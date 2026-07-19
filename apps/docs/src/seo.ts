export const DEFAULT_DESCRIPTION =
  'Offline-first SQL sync with local SQLite, a server-authoritative commit log, and scope-based authorization across web and native apps.';

export function markdownDescription(
  markdown: string,
  fallback = DEFAULT_DESCRIPTION,
): string {
  const paragraphs = markdown
    .replace(/^---\s*[\s\S]*?\s*---\s*/, '')
    .split(/\n\s*\n/);

  const paragraph = paragraphs.find((block) => {
    const value = block.trim();
    return (
      value.length > 0 &&
      !/^(?:#{1,6}\s|```|~~~|>|[-*+]\s|\d+[.)]\s|\|)/.test(value)
    );
  });

  if (!paragraph) return fallback;

  const plain = paragraph
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[`*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (plain.length <= 180) return plain;

  const candidate = plain.slice(0, 181);
  const sentenceEnd = Math.max(
    candidate.lastIndexOf('. '),
    candidate.lastIndexOf('? '),
    candidate.lastIndexOf('! '),
  );
  if (sentenceEnd >= 90) return candidate.slice(0, sentenceEnd + 1);

  return `${plain.slice(0, 177).replace(/\s+\S*$/, '')}…`;
}
