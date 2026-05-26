import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  transpilePackages: ['shiki', '@syncular/ui'],
  reactStrictMode: true,
  async rewrites() {
    return [
      {
        source: '/index.mdx',
        destination: '/llms.mdx',
      },
      {
        source: '/:path*.mdx',
        destination: '/llms.mdx/:path*',
      },
    ];
  },
};

export default withMDX(config);
