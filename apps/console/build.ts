#!/usr/bin/env bun
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import plugin from 'bun-plugin-tailwind';

const formatFileSize = (bytes: number): string => {
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(2)} ${units[unitIndex]}`;
};

console.log('\n🚀 Starting build process...\n');

const outdir = path.join(process.cwd(), 'dist');

if (existsSync(outdir)) {
  console.log(`🗑️ Cleaning previous build at ${outdir}`);
  await rm(outdir, { recursive: true, force: true });
}

const start = performance.now();

const result = await Bun.build({
  entrypoints: [path.join(__dirname, 'index.html')],
  outdir,
  plugins: [plugin],
  minify: true,
  target: 'browser',
  sourcemap: 'linked',
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  publicPath: '/',
});

const end = performance.now();

await stampSentryMetaTags(path.join(outdir, 'index.html'));

// Copy favicon assets (referenced via absolute paths in HTML)
const faviconDir = path.resolve(__dirname, '../../assets/favicon');
const faviconOutDir = path.join(outdir, 'assets');
mkdirSync(faviconOutDir, { recursive: true });
for (const file of readdirSync(faviconDir)) {
  cpSync(path.join(faviconDir, file), path.join(faviconOutDir, file));
}

const outputTable = result.outputs.map((output) => ({
  File: path.relative(process.cwd(), output.path),
  Type: output.kind,
  Size: formatFileSize(output.size),
}));

console.table(outputTable);
const buildTime = (end - start).toFixed(2);

console.log(`\n✅ Build completed in ${buildTime}ms\n`);

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
