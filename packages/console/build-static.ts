#!/usr/bin/env bun
import { cpSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import plugin from 'bun-plugin-tailwind';

const outdir = path.join(process.cwd(), 'web-dist');

if (existsSync(outdir)) {
  await rm(outdir, { recursive: true, force: true });
}

const result = await Bun.build({
  entrypoints: [path.join(process.cwd(), 'index.html')],
  outdir,
  plugins: [plugin],
  minify: true,
  target: 'browser',
  sourcemap: 'none',
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  publicPath: '/',
});

await stampSentryMetaTags(path.join(outdir, 'index.html'));

const faviconDir = path.resolve(process.cwd(), '../../assets/favicon');
for (const file of readdirSync(faviconDir)) {
  cpSync(path.join(faviconDir, file), path.join(outdir, file));
}

if (!result.success) {
  throw new Error('Failed to build console distributable assets');
}

async function stampSentryMetaTags(indexPath: string): Promise<void> {
  const replacements = [
    {
      name: 'syncular-sentry-dsn',
      value: process.env.SYNCULAR_SENTRY_DSN ?? '',
    },
    {
      name: 'syncular-sentry-environment',
      value: process.env.SYNCULAR_SENTRY_ENVIRONMENT ?? '',
    },
    {
      name: 'syncular-sentry-release',
      value: process.env.SYNCULAR_SENTRY_RELEASE ?? '',
    },
  ];

  let html = readFileSync(indexPath, 'utf8');
  for (const replacement of replacements) {
    const escapedValue = replacement.value
      .replaceAll('&', '&amp;')
      .replaceAll('"', '&quot;');
    const pattern = new RegExp(
      `<meta name="${replacement.name}" content="[^"]*"\\s*/?>`
    );
    html = html.replace(
      pattern,
      `<meta name="${replacement.name}" content="${escapedValue}" />`
    );
  }

  await Bun.write(indexPath, html);
}
