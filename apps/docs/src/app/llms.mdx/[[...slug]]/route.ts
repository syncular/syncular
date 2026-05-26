import { notFound } from 'next/navigation';
import { getLLMText, source } from '@/lib/source';

export const revalidate = false;

function normalizeSlug(slug?: string[]) {
  const normalized = [...(slug ?? [])];
  const last = normalized.at(-1);

  if (last?.endsWith('.mdx')) {
    normalized[normalized.length - 1] = last.slice(0, -'.mdx'.length);
  }

  return normalized.length === 1 && normalized[0] === 'index' ? [] : normalized;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug?: string[] }> }
) {
  const { slug } = await params;
  const page = source.getPage(normalizeSlug(slug));
  if (!page) notFound();

  return new Response(await getLLMText(page), {
    headers: {
      'Content-Type': 'text/markdown',
    },
  });
}

export function generateStaticParams() {
  return source.generateParams();
}
