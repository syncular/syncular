#!/usr/bin/env bun
import { cpSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { build } from 'vite';

const outdir = path.join(process.cwd(), 'web-dist');
const packageDistDir = path.join(process.cwd(), 'dist');

if (existsSync(outdir)) {
  await rm(outdir, { recursive: true, force: true });
}

await build({
  configFile: false,
  root: process.cwd(),
  plugins: [react(), tailwindcss()],
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  build: {
    outDir: outdir,
    emptyOutDir: true,
    minify: true,
    sourcemap: false,
    rollupOptions: {
      input: path.join(process.cwd(), 'index.html'),
    },
  },
});

await stampSentryMetaTags(path.join(outdir, 'index.html'));
await emitCompiledStyles(path.join(outdir, 'index.html'));

const faviconDir = path.resolve(process.cwd(), '../../assets/favicon');
for (const file of readdirSync(faviconDir)) {
  cpSync(path.join(faviconDir, file), path.join(outdir, file));
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

async function emitCompiledStyles(indexPath: string): Promise<void> {
  const indexHtml = readFileSync(indexPath, 'utf8');
  const stylesheetHrefs = [
    ...new Set(
      [...indexHtml.matchAll(/href="([^"]+\.css)"/g)].map((match) => match[1])
    ),
  ];

  if (stylesheetHrefs.length === 0) {
    throw new Error(
      'Unable to locate compiled stylesheet in web-dist/index.html'
    );
  }

  const compiledStyles = stylesheetHrefs
    .map((href) => {
      const normalizedHref = href.startsWith('/')
        ? href.slice(1)
        : href.startsWith('./')
          ? href.slice(2)
          : href;
      const compiledStylesPath = path.join(outdir, normalizedHref);
      if (!existsSync(compiledStylesPath)) {
        throw new Error(`Compiled stylesheet missing: ${compiledStylesPath}`);
      }
      return readFileSync(compiledStylesPath, 'utf8');
    })
    .join('\n');

  if (!existsSync(packageDistDir)) {
    await mkdir(packageDistDir, { recursive: true });
  }

  await Bun.write(path.join(packageDistDir, 'styles.css'), compiledStyles);
  await Bun.write(path.join(outdir, 'console.css'), compiledStyles);
}
