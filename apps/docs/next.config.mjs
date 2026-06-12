import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  transpilePackages: ['shiki', '@syncular/ui'],
  reactStrictMode: true,
  async redirects() {
    return [
      {
        source: '/docs',
        destination: '/',
        permanent: true,
      },
      {
        source: '/docs/:path*',
        destination: '/:path*',
        permanent: true,
      },
      // Retired start/ slugs (2026-06 docs restructure, Phase 1).
      {
        source: '/start/adoption-paths',
        destination: '/start/pick-your-path',
        permanent: true,
      },
      {
        source: '/start/fresh-apps',
        destination: '/start/pick-your-path',
        permanent: true,
      },
      {
        source: '/start/good-fit',
        destination: '/start/is-syncular-for-me',
        permanent: true,
      },
      {
        source: '/start/basic-setup',
        destination: '/start/installation',
        permanent: true,
      },
      // Retired server/ slugs (2026-06 docs restructure, Phase 3).
      {
        source: '/server/setup-with-hono',
        destination: '/server/getting-started',
        permanent: true,
      },
      // Retired reference/cli slugs (2026-06 docs restructure, Phase 6).
      // These documented `syncular create|migrate|console` subcommands that
      // do not exist; the CLI ships `generate` and `codegen install` only.
      {
        source: '/reference/cli/create',
        destination: '/start/quick-start',
        permanent: true,
      },
      {
        source: '/reference/cli/migrate',
        destination: '/reference/cli',
        permanent: true,
      },
      {
        source: '/reference/cli/console',
        destination: '/reference/cli',
        permanent: true,
      },
    ];
  },
};

export default withMDX(config);
