import { docs } from 'fumadocs-mdx:collections/server';
import { type InferPageType, loader } from 'fumadocs-core/source';
import { lucideIconsPlugin } from 'fumadocs-core/source/lucide-icons';

export const source = loader({
  baseUrl: '/',
  source: docs.toFumadocsSource(),
  plugins: [lucideIconsPlugin()],
});

// Extended page type with fumadocs-mdx methods
interface ExtendedPageData {
  title: string;
  description?: string;
  getText: (type: 'raw' | 'processed') => Promise<string>;
}

type ExtendedPage = Omit<InferPageType<typeof source>, 'data'> & {
  data: ExtendedPageData;
};

export function getPageImage(page: InferPageType<typeof source>) {
  const segments = [...page.slugs, 'image.png'];

  return {
    segments,
    url: `/og/${segments.join('/')}`,
  };
}

export function getPageMarkdownUrl(page: InferPageType<typeof source>) {
  return page.slugs.length === 0 ? '/index.mdx' : `${page.url}.mdx`;
}

export async function getLLMText(page: InferPageType<typeof source>) {
  // Type assertion needed due to fumadocs-mdx/fumadocs-core type inference gap
  const extendedPage = page as ExtendedPage;
  const processed = await extendedPage.data.getText('processed');

  return `# ${extendedPage.data.title}

${processed}`;
}
