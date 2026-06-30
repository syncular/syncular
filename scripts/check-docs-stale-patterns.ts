#!/usr/bin/env bun
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

type StalePattern = {
  pattern: RegExp;
  message: string;
};

const repoRoot = resolve(join(import.meta.dirname, '..'));
const rootReferenceFiles = ['README.md'];
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
    pattern: /generated\/syncular\.browser|syncular\.browser\.ts\b/,
    message:
      'Use the starter-proven generated module path `src/generated/syncular.generated.ts`.',
  },
  {
    pattern: /@syncular\/client-react(?![-\w])/,
    message: 'Use the `@syncular/client/react` subpath.',
  },
  {
    pattern: /packages\/client-react(?![-\w])/,
    message: 'React helpers now live under `packages/client/src/react`.',
  },
  {
    pattern:
      /@syncular\/(?:client-javascript-bindings|client-crdt-adapters|client-react-native|client-tauri|react)\b/,
    message:
      'Client add-ons now live in `@syncular/client` subpaths: `/react`, `/react-native`, `/tauri`, and `/crdt-yjs`.',
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
    message: 'React Native docs should use `@syncular/client/react-native`.',
  },
  {
    pattern: /@syncular\/dialects\b/,
    message:
      'Database driver helpers now live in `@syncular/server/<driver>` subpaths.',
  },
  {
    pattern:
      /@syncular\/(?:server-hono|server-cloudflare|server-service-worker|server-dialect-(?:sqlite|postgres)|server-storage-(?:filesystem|s3)|server-plugin-yjs|relay|transport-http)\b/,
    message:
      'Server add-ons now live in `@syncular/server` subpaths; HTTP transport lives in `@syncular/core/http`.',
  },
  {
    pattern: /@syncular\/observability-sentry\b/,
    message:
      'Sentry adapters now live in `@syncular/client/sentry` and `@syncular/server/cloudflare/sentry`.',
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
      'Database driver helpers now live in `@syncular/server/<driver>` subpaths (e.g. `@syncular/server/pglite`).',
  },
  {
    pattern:
      /(?:\bfrom\s+|\bimport\s+|\brequire\(\s*)['"]syncular(?:\/[^'"]*)?['"]/,
    message:
      'The `syncular` package is CLI-only (`npx syncular generate`); import from the scoped `@syncular/*` packages instead.',
  },
  {
    pattern: /\bUmbrella package with re-exports\b|\bone-package imports\b/,
    message:
      'The `syncular` package is CLI-only; do not describe it as an import umbrella.',
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
  {
    pattern: /\/reference\/cli\/(?:create|migrate)\b/,
    message:
      'Retired reference/cli pages: the CLI has no create/migrate subcommands. Link /start/quick-start (scaffolding via create-syncular-app), /features/migrations, or /reference/cli.',
  },
  {
    pattern: /\bsyncular (?:create|migrate|doctor|dev|typegen|login|deploy)\b/,
    message:
      'The syncular CLI only ships `generate` and `codegen install`. Scaffolding is `bunx create-syncular-app`; migrations/console are app-owned.',
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
      ...rootReferenceFiles.map((file) =>
        stat(join(repoRoot, file))
          .then(() => [join(repoRoot, file)])
          .catch(() => [])
      ),
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
