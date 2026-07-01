#!/usr/bin/env bun
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const repoRoot = resolve(join(import.meta.dirname, '..'));
const workDir = resolve(
  process.env.SYNCULAR_FRAMEWORK_IMPORT_SMOKE_DIR ??
    `.context/framework-import-smokes/run-${process.pid}`
);
const keep = process.argv.includes('--keep');

async function run(
  command: string,
  args: string[],
  options: { cwd: string; env?: Record<string, string | undefined> }
): Promise<void> {
  console.log(`[framework-import-smokes] $ ${[command, ...args].join(' ')}`);
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: 'inherit',
      env: { ...process.env, ...options.env },
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(`${command} exited with status ${code ?? 'unknown'}`));
    });
  });
}

async function linkPackage(appDir: string, name: string, target: string) {
  if (!existsSync(target)) {
    throw new Error(`Cannot link ${name}; missing ${target}`);
  }
  const destination = join(appDir, 'node_modules', ...name.split('/'));
  await rm(destination, { recursive: true, force: true });
  await mkdir(dirname(destination), { recursive: true });
  await symlink(target, destination, 'dir');
}

function workspaceDependencyPath(name: string): string {
  const bunStore = join(repoRoot, 'node_modules/.bun');
  const bunStoreName = name.replace('/', '+');
  const bunStoreCandidates = existsSync(bunStore)
    ? Array.from(
        new Bun.Glob(`${bunStoreName}@*/node_modules/${name}`).scanSync({
          cwd: bunStore,
        })
      ).map((candidate) => join(bunStore, candidate))
    : [];
  const candidates = [
    join(repoRoot, 'node_modules', name),
    join(repoRoot, 'apps/docs/node_modules', name),
    join(repoRoot, 'packages/client/node_modules', name),
    join(repoRoot, 'packages/server/node_modules', name),
    join(repoRoot, 'packages/create-syncular-app/node_modules', name),
    join(repoRoot, 'packages/console/node_modules', name),
    ...bunStoreCandidates,
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(
      `Cannot resolve workspace dependency ${name}; tried ${candidates.join(', ')}`
    );
  }
  return found;
}

async function writeNextApp(appDir: string): Promise<void> {
  await mkdir(join(appDir, 'app'), { recursive: true });
  await writeFile(
    join(appDir, 'package.json'),
    `${JSON.stringify(
      {
        private: true,
        type: 'module',
        scripts: {
          build: 'next build',
        },
        dependencies: {
          '@syncular/client': 'workspace:*',
          '@syncular/core': 'workspace:*',
          '@syncular/server': 'workspace:*',
          next: 'workspace:*',
          react: 'workspace:*',
          'react-dom': 'workspace:*',
        },
      },
      null,
      2
    )}\n`,
    'utf8'
  );
  await writeFile(
    join(appDir, 'next.config.mjs'),
    `import { resolve } from 'node:path';

const repoRoot = ${JSON.stringify(repoRoot)};

const nextConfig = {
  output: 'standalone',
  transpilePackages: ['@syncular/client', '@syncular/core', '@syncular/server'],
  webpack: (config) => {
    config.resolve.alias = {
      ...(config.resolve.alias ?? {}),
      '@syncular/client': resolve(repoRoot, 'packages/client/src/index.ts'),
      '@syncular/core': resolve(repoRoot, 'packages/core/src/index.ts'),
      '@syncular/core/http': resolve(
        repoRoot,
        'packages/core/src/http/index.ts'
      ),
      '@syncular/core/http/blob': resolve(
        repoRoot,
        'packages/core/src/http/blob.ts'
      ),
      '@syncular/core/sentry': resolve(repoRoot, 'packages/core/src/sentry.ts'),
      '@syncular/server': resolve(repoRoot, 'packages/server/src/index.ts'),
    };
    return config;
  },
};

export default nextConfig;
`,
    'utf8'
  );
  await writeFile(
    join(appDir, 'app', 'layout.js'),
    `export const metadata = {
  title: 'Syncular framework import smoke',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`,
    'utf8'
  );
  await writeFile(
    join(appDir, 'app', 'page.js'),
    `import {
  getSyncularBrowserHealth,
  getSyncularSupportBundle,
} from '@syncular/client';
import { ensureSyncSchema } from '@syncular/server';

export const dynamic = 'force-static';

export default function Page() {
  const checks = [
    ['client health', getSyncularBrowserHealth],
    ['client support bundle', getSyncularSupportBundle],
    ['server schema', ensureSyncSchema],
  ];
  for (const [label, value] of checks) {
    if (typeof value !== 'function') {
      throw new Error(label + ' root import was not a function');
    }
  }
  return <main>Syncular root imports are SSR-safe.</main>;
}
`,
    'utf8'
  );
}

async function writeViteApp(appDir: string): Promise<void> {
  await mkdir(join(appDir, 'src'), { recursive: true });
  await writeFile(
    join(appDir, 'package.json'),
    `${JSON.stringify(
      {
        private: true,
        type: 'module',
        scripts: {
          build: 'vite build',
        },
        dependencies: {
          '@syncular/client': 'workspace:*',
          '@syncular/core': 'workspace:*',
          vite: 'workspace:*',
        },
      },
      null,
      2
    )}\n`,
    'utf8'
  );
  await writeFile(
    join(appDir, 'index.html'),
    `<div id="app"></div><script type="module" src="/src/main.ts"></script>\n`,
    'utf8'
  );
  await writeFile(
    join(appDir, 'src', 'main.ts'),
    `import {
  getSyncularBrowserHealth,
  getSyncularSupportBundle,
} from '@syncular/client';

const checks = [
  ['client health', getSyncularBrowserHealth],
  ['client support bundle', getSyncularSupportBundle],
] as const;

for (const [label, value] of checks) {
  if (typeof value !== 'function') {
    throw new Error(label + ' root import was not a function');
  }
}

document
  .querySelector('#app')
  ?.setAttribute('data-syncular-vite-root-import', 'ready');
`,
    'utf8'
  );
}

async function writeCloudflareWorkerApp(appDir: string): Promise<void> {
  await mkdir(join(appDir, 'src'), { recursive: true });
  await writeFile(
    join(appDir, 'package.json'),
    `${JSON.stringify(
      {
        private: true,
        type: 'module',
        dependencies: {
          '@syncular/core': 'workspace:*',
          '@syncular/server': 'workspace:*',
          hono: 'workspace:*',
          wrangler: 'workspace:*',
        },
      },
      null,
      2
    )}\n`,
    'utf8'
  );
  await writeFile(
    join(appDir, 'src', 'worker.ts'),
    `import {
  SyncDurableObject,
  createSyncWorker,
} from '@syncular/server/cloudflare';

type Env = Record<string, never>;

export class SyncularSmokeDurableObject extends SyncDurableObject<Env> {
  setup() {}
}

export default createSyncWorker<Env>((app) => {
  app.get('/syncular-framework-import-smoke', (c) =>
    c.text('syncular-cloudflare-root-import-ready')
  );
});
`,
    'utf8'
  );
}

async function linkSyncularWorkspacePackages(appDir: string): Promise<void> {
  await linkPackage(
    appDir,
    '@syncular/client',
    join(repoRoot, 'packages/client')
  );
  await linkPackage(appDir, '@syncular/core', join(repoRoot, 'packages/core'));
}

async function linkSyncularServerWorkspacePackages(
  appDir: string
): Promise<void> {
  await linkPackage(appDir, '@syncular/core', join(repoRoot, 'packages/core'));
  await linkPackage(
    appDir,
    '@syncular/server',
    join(repoRoot, 'packages/server')
  );
}

async function runNextRootImportSmoke(): Promise<void> {
  const appDir = join(workDir, 'next-root-imports');
  await mkdir(appDir, { recursive: true });
  await writeNextApp(appDir);

  await linkSyncularWorkspacePackages(appDir);
  await linkPackage(
    appDir,
    '@syncular/server',
    join(repoRoot, 'packages/server')
  );
  await linkPackage(appDir, 'next', workspaceDependencyPath('next'));
  await linkPackage(appDir, 'react', workspaceDependencyPath('react'));
  await linkPackage(appDir, 'react-dom', workspaceDependencyPath('react-dom'));

  await run(
    'node',
    [join(appDir, 'node_modules/next/dist/bin/next'), 'build', '--webpack'],
    {
      cwd: appDir,
      env: {
        NEXT_TELEMETRY_DISABLED: '1',
      },
    }
  );
  console.log('[framework-import-smokes] Next root import smoke passed');
}

async function runViteClientRootImportSmoke(): Promise<void> {
  const appDir = join(workDir, 'vite-client-root-imports');
  await mkdir(appDir, { recursive: true });
  await writeViteApp(appDir);

  await linkSyncularWorkspacePackages(appDir);
  await linkPackage(appDir, 'vite', workspaceDependencyPath('vite'));

  await run('node', [join(appDir, 'node_modules/vite/bin/vite.js'), 'build'], {
    cwd: appDir,
  });

  const bundleDir = join(appDir, 'dist/assets');
  const bundleNames = Array.from(
    new Bun.Glob('*.js').scanSync({ cwd: bundleDir })
  );
  for (const bundleName of bundleNames) {
    const bundle = await Bun.file(join(bundleDir, bundleName)).text();
    if (bundle.includes('data-syncular-vite-root-import')) {
      console.log('[framework-import-smokes] Vite root import smoke passed');
      return;
    }
  }

  throw new Error(
    `Vite build did not contain the Syncular root import marker in ${bundleDir}`
  );
}

async function runCloudflareWorkerImportSmoke(): Promise<void> {
  const appDir = join(workDir, 'cloudflare-worker-root-imports');
  await mkdir(appDir, { recursive: true });
  await writeCloudflareWorkerApp(appDir);

  await linkSyncularServerWorkspacePackages(appDir);
  await linkPackage(appDir, 'hono', workspaceDependencyPath('hono'));
  await linkPackage(appDir, 'wrangler', workspaceDependencyPath('wrangler'));

  const outDir = join(appDir, 'dist');
  await run(
    'node',
    [
      join(appDir, 'node_modules/wrangler/bin/wrangler.js'),
      'deploy',
      'src/worker.ts',
      '--dry-run',
      '--outdir',
      outDir,
      '--name',
      'syncular-framework-import-smoke',
      '--compatibility-date',
      '2026-01-01',
    ],
    {
      cwd: appDir,
      env: {
        WRANGLER_SEND_METRICS: 'false',
      },
    }
  );

  const bundleNames = Array.from(
    new Bun.Glob('**/*.js').scanSync({ cwd: outDir })
  );
  for (const bundleName of bundleNames) {
    const bundle = await Bun.file(join(outDir, bundleName)).text();
    if (bundle.includes('syncular-cloudflare-root-import-ready')) {
      console.log(
        '[framework-import-smokes] Cloudflare Worker root import smoke passed'
      );
      return;
    }
  }

  throw new Error(
    `Cloudflare dry-run build did not contain the Syncular root import marker in ${outDir}`
  );
}

async function main(): Promise<void> {
  await rm(workDir, { recursive: true, force: true });
  try {
    await runNextRootImportSmoke();
    await runViteClientRootImportSmoke();
    await runCloudflareWorkerImportSmoke();
  } finally {
    if (!keep) {
      await rm(workDir, { recursive: true, force: true });
    } else {
      console.log(`[framework-import-smokes] keeping ${workDir}`);
    }
  }
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[framework-import-smokes] ${message}`);
  process.exitCode = 1;
}
