#!/usr/bin/env bun
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

type BoundaryTarget = {
  label: string;
  entrypoint: string;
  forbiddenPathPatterns: RegExp[];
  forbiddenSpecifiers: string[];
};

type ImportEdge = {
  from: string;
  specifier: string;
};

const repoRoot = resolve(join(import.meta.dirname, '..'));

const targets: BoundaryTarget[] = [
  {
    label: '@syncular/client root',
    entrypoint: 'packages/client/src/index.ts',
    forbiddenPathPatterns: [
      /^packages\/client\/src\/crdt-yjs(?:\/|$)/,
      /^packages\/client\/src\/react(?:\/|$)/,
      /^packages\/client\/src\/react-native(?:\/|$)/,
      /^packages\/client\/src\/tauri(?:\/|$)/,
      /^packages\/client\/src\/sentry\.ts$/,
      /^packages\/client\/src\/worker-entry\.ts$/,
    ],
    forbiddenSpecifiers: [
      '@sentry/react',
      '@syncular/client/crdt-yjs',
      '@syncular/client/react',
      '@syncular/client/react-native',
      '@syncular/client/sentry',
      '@syncular/client/tauri',
      '@syncular/client/worker',
      'react',
      'react-native',
      'yjs',
    ],
  },
  {
    label: '@syncular/server root',
    entrypoint: 'packages/server/src/index.ts',
    forbiddenPathPatterns: [
      /^packages\/server\/src\/better-sqlite3\.ts$/,
      /^packages\/server\/src\/bun-sqlite\.ts$/,
      /^packages\/server\/src\/cloudflare(?:\/|$)/,
      /^packages\/server\/src\/crdt-yjs(?:\/|$)/,
      /^packages\/server\/src\/d1\.ts$/,
      /^packages\/server\/src\/filesystem(?:\/|$)/,
      /^packages\/server\/src\/hono(?:\/|$)/,
      /^packages\/server\/src\/libsql\.ts$/,
      /^packages\/server\/src\/neon\.ts$/,
      /^packages\/server\/src\/pglite\.ts$/,
      /^packages\/server\/src\/postgres(?:\/|$)/,
      /^packages\/server\/src\/relay(?:\/|$)/,
      /^packages\/server\/src\/s3(?:\/|$)/,
      /^packages\/server\/src\/service-worker(?:\/|$)/,
      /^packages\/server\/src\/snapshot-artifacts\/sqlite-bun\.ts$/,
      /^packages\/server\/src\/sqlite(?:\/|$)/,
      /^packages\/server\/src\/sqlite3\.ts$/,
    ],
    forbiddenSpecifiers: [
      '@cloudflare/workers-types',
      '@electric-sql/pglite',
      '@electric-sql/pglite/live',
      '@neondatabase/serverless',
      '@sentry/cloudflare',
      '@syncular/server/better-sqlite3',
      '@syncular/server/bun-sqlite',
      '@syncular/server/cloudflare',
      '@syncular/server/crdt-yjs',
      '@syncular/server/d1',
      '@syncular/server/filesystem',
      '@syncular/server/hono',
      '@syncular/server/libsql',
      '@syncular/server/neon',
      '@syncular/server/pglite',
      '@syncular/server/postgres',
      '@syncular/server/relay',
      '@syncular/server/s3',
      '@syncular/server/service-worker',
      '@syncular/server/sqlite',
      '@syncular/server/sqlite3',
      '@standard-community/standard-json',
      '@standard-community/standard-openapi',
      'better-sqlite3',
      'bun:sqlite',
      'hono',
      'hono-openapi',
      'kysely-bun-sqlite',
      'kysely-neon',
      'kysely-pglite-dialect',
      'libsql',
      'sqlite3',
      'yjs',
    ],
  },
];

const staticImportPattern =
  /\b(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g;
const dynamicImportPattern = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

async function main(): Promise<void> {
  const failures: string[] = [];

  for (const target of targets) {
    const result = await walkImportGraph(target);
    failures.push(...result.failures);
    console.log(
      `[imports:check] ${target.label}: checked ${result.filesChecked} files`
    );
  }

  if (failures.length > 0) {
    console.error(
      `\n[imports:check] optional import boundary failures:\n${failures
        .map((failure) => `- ${failure}`)
        .join('\n')}`
    );
    process.exitCode = 1;
  }
}

async function walkImportGraph(target: BoundaryTarget): Promise<{
  failures: string[];
  filesChecked: number;
}> {
  const entrypoint = resolve(repoRoot, target.entrypoint);
  const seen = new Set<string>();
  const queue = [entrypoint];
  const failures: string[] = [];

  while (queue.length > 0) {
    const file = queue.shift()!;
    const relativeFile = normalizePath(relative(repoRoot, file));
    if (seen.has(file)) continue;
    seen.add(file);

    for (const pattern of target.forbiddenPathPatterns) {
      if (pattern.test(relativeFile)) {
        failures.push(
          `${target.label} reaches optional module ${relativeFile}`
        );
      }
    }

    const source = await readFile(file, 'utf8');
    for (const edge of staticImportEdges(source, relativeFile)) {
      if (isForbiddenSpecifier(edge.specifier, target.forbiddenSpecifiers)) {
        failures.push(
          `${target.label} imports optional specifier ${edge.specifier} from ${edge.from}`
        );
      }

      const resolved = resolveLocalImport(edge.specifier, file);
      if (resolved) queue.push(resolved);
    }
  }

  return {
    failures,
    filesChecked: seen.size,
  };
}

function staticImportEdges(source: string, from: string): ImportEdge[] {
  const scanSource = stripComments(source);
  const edges: ImportEdge[] = [];
  for (const pattern of [staticImportPattern, dynamicImportPattern]) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(scanSource))) {
      const specifier = match[1];
      if (specifier) edges.push({ from, specifier });
    }
  }
  return edges;
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function isForbiddenSpecifier(
  specifier: string,
  forbiddenSpecifiers: readonly string[]
): boolean {
  return forbiddenSpecifiers.some(
    (forbidden) =>
      specifier === forbidden || specifier.startsWith(`${forbidden}/`)
  );
}

function resolveLocalImport(
  specifier: string,
  fromFile: string
): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.d.ts`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
    join(base, 'index.d.ts'),
  ];
  for (const candidate of candidates) {
    if (isFile(candidate)) return candidate;
  }
  throw new Error(
    `Could not resolve local import ${JSON.stringify(specifier)} from ${normalizePath(
      relative(repoRoot, fromFile)
    )}`
  );
}

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/');
}

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

await main();
