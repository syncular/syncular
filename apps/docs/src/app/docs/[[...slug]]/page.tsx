import type { TOCItemType } from 'fumadocs-core/toc';
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
} from 'fumadocs-ui/layouts/docs/page';
import type { MDXContent } from 'mdx/types';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { LLMCopyButton, ViewOptions } from '@/components/ai/page-actions';
import { createRelativeLink } from '@/lib/fumadocs-compat';
import { getPageImage, source } from '@/lib/source';
import { getMDXComponents } from '@/mdx-components';

// Extended page data type for fumadocs-mdx
interface ExtendedPageData {
  title: string;
  description?: string;
  body: MDXContent;
  toc: TOCItemType[];
  full?: boolean;
}

export default async function Page(props: {
  params: Promise<{ slug?: string[] }>;
}) {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  // Type assertion needed due to fumadocs-mdx/fumadocs-core type inference gap
  const pageData = page.data as ExtendedPageData;
  const MDX = pageData.body;
  const gitConfig = {
    user: 'syncular',
    repo: 'syncular',
    branch: 'main',
  };

  return (
    <DocsPage toc={pageData.toc} full={pageData.full}>
      <DocsTitle>{pageData.title}</DocsTitle>
      <DocsDescription className="mb-0">{pageData.description}</DocsDescription>
      <div className="flex flex-row gap-2 items-center border-b pb-6">
        <LLMCopyButton markdownUrl={`${page.url}.mdx`} />
        <ViewOptions
          markdownUrl={`${page.url}.mdx`}
          githubUrl={`https://github.com/${gitConfig.user}/${gitConfig.repo}/blob/${gitConfig.branch}/apps/docs/content/docs/${page.path}`}
        />
      </div>
      <DocsBody>
        <MDX
          components={getMDXComponents({
            a: createRelativeLink(source, page),
          })}
        />
      </DocsBody>
    </DocsPage>
  );
}

export async function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata(props: {
  params: Promise<{ slug?: string[] }>;
}): Promise<Metadata> {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  return {
    title: page.data.title,
    description: page.data.description,
    openGraph: {
      images: getPageImage(page).url,
    },
  };
}
