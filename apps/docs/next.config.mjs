import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  transpilePackages: ['shiki', '@syncular/ui'],
  reactStrictMode: true,
};

export default withMDX(config);
