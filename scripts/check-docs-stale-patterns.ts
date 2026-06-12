#!/usr/bin/env bun
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

type StalePattern = {
  pattern: RegExp;
  message: string;
};

const repoRoot = resolve(join(import.meta.dirname, '..'));
const publicDocRoots = ['apps/docs/content/docs'];
const packageRoots = ['packages', 'plugins', 'rust/crates'];
const rustReferenceFiles = [
  'rust/docs/reference/LOCAL_PROJECT_INTEGRATION.md',
  'rust/docs/reference/BLANK_APP_API_REVIEW.md',
];

const stalePatterns: StalePattern[] = [
  {
    pattern: /\bsyncular-typegen\s+codegen-config\b/,
    message: 'Use the unified `syncular generate` command in app-facing docs.',
  },
  {
    pattern: /@syncular\/client-react(?![-\w])/,
    message: 'Use the published `@syncular/react` package name.',
  },
  {
    pattern: /packages\/client-react(?![-\w])/,
    message: 'Use the current `packages/react` workspace path.',
  },
  {
    pattern: /\/docs\/api\//,
    message:
      'Reference generated APIs under `/docs/reference`, not `/docs/api`.',
  },
  {
    pattern: /\bjson-row-frame\b|\bframed JSON rows\b/i,
    message: 'JSON row-frame protocol wording is stale.',
  },
  {
    pattern: /@syncular\/client-expo\b/,
    message: 'React Native docs should use `@syncular/client-react-native`.',
  },
  {
    pattern:
      /\bsyncular\/(?:dialect-wa-sqlite|transport-ws|server-dialect-neon)\b/,
    message: 'Deleted umbrella package aliases must not be suggested.',
  },
  {
    pattern:
      /\bsyncular\/dialect-(?:better-sqlite3|bun-sqlite|d1|libsql|neon|pglite|sqlite3)\b/,
    message:
      'The per-driver dialect packages were merged into `@syncular/dialects` subpaths (e.g. `@syncular/dialects/pglite`).',
  },
  {
    pattern:
      /(?:\bfrom\s+|\bimport\s+|\brequire\(\s*)['"]syncular(?:\/[^'"]*)?['"]/,
    message:
      'The `syncular` package is CLI-only (`npx syncular generate`); import from the scoped `@syncular/*` packages instead.',
  },
  {
    pattern: /\/start\/(?:adoption-paths|fresh-apps|basic-setup|good-fit)\b/,
    message:
      'Retired start/ pages: link to /start/pick-your-path (was adoption-paths, fresh-apps), /start/is-syncular-for-me (was good-fit), or /start/installation (was basic-setup).',
  },
  {
    pattern: /\/server\/setup-with-hono\b/,
    message:
      'Retired server page: link to /server/getting-started (was setup-with-hono).',
  },
];

const searchableExtensions = new Set(['.md', '.mdx', '.json', '.ts', '.tsx']);

function hasSearchableExtension(path: string): boolean {
  return [...searchableExtensions].some((extension) =>
    path.endsWith(extension)
  );
}

function shouldSkip(path: string): boolean {
  return (
    path.includes('/node_modules/') ||
    path.includes('/dist/') ||
    path.includes('/target/') ||
    path.includes('/generated/') ||
    path.includes('/work-packages/')
  );
}

async function walk(path: string): Promise<string[]> {
  if (shouldSkip(path)) {
    return [];
  }

  const info = await stat(path);
  if (info.isFile()) {
    return hasSearchableExtension(path) ? [path] : [];
  }
  if (!info.isDirectory()) {
    return [];
  }

  const entries = await readdir(path);
  const nested = await Promise.all(
    entries.map((entry) => walk(join(path, entry)))
  );
  return nested.flat();
}

async function walkPackageDocs(path: string): Promise<string[]> {
  if (shouldSkip(path)) {
    return [];
  }

  const info = await stat(path);
  if (info.isFile()) {
    return path.endsWith('/README.md') || path.endsWith('/package.json')
      ? [path]
      : [];
  }
  if (!info.isDirectory()) {
    return [];
  }

  const entries = await readdir(path);
  const nested = await Promise.all(
    entries.map((entry) => walkPackageDocs(join(path, entry)))
  );
  return nested.flat();
}

const files = (
  await Promise.all(
    [
      ...publicDocRoots.map((root) => walk(join(repoRoot, root))),
      ...packageRoots.map((root) => walkPackageDocs(join(repoRoot, root))),
      ...rustReferenceFiles.map((file) =>
        stat(join(repoRoot, file))
          .then(() => [join(repoRoot, file)])
          .catch(() => [])
      ),
    ].map((readFiles) => readFiles.catch(() => []))
  )
).flat();

const findings: string[] = [];
for (const file of files) {
  const text = await readFile(file, 'utf8');
  for (const stalePattern of stalePatterns) {
    if (!stalePattern.pattern.test(text)) {
      continue;
    }
    findings.push(
      `${relative(repoRoot, file)}: ${stalePattern.message} (${stalePattern.pattern})`
    );
  }
}

if (findings.length > 0) {
  throw new Error(`Stale docs/API patterns found:\n${findings.join('\n')}`);
}

console.log(`[docs:stale-check] scanned ${files.length} files`);
