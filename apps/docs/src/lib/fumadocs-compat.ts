import type { LoaderConfig, LoaderOutput, Page } from 'fumadocs-core/source';
import { createRelativeLink as createRelativeLinkUnsafe } from 'fumadocs-ui/mdx';
import type { ComponentProps, FC } from 'react';

type AnchorComponent = FC<ComponentProps<'a'>>;

/**
 * Fumadocs 16.6.3 currently widens `createRelativeLink` input to `LoaderOutput<LoaderConfig>`.
 * This wrapper keeps call sites strongly typed and contains the compatibility cast in one place.
 */
export function createRelativeLink<Config extends LoaderConfig>(
  source: LoaderOutput<Config>,
  page: Page<Config['source']['pageData']>,
  OverrideLink?: AnchorComponent
): AnchorComponent {
  return createRelativeLinkUnsafe(
    source as unknown as LoaderOutput<LoaderConfig>,
    page as unknown as Page,
    OverrideLink
  );
}
