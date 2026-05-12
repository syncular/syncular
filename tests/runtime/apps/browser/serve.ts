/**
 * Browser runtime asset server.
 *
 * Builds and serves the wa-sqlite dialect + test entry point with COOP/COEP headers.
 * Started as a subprocess by the test coordinator.
 */

import path from 'node:path';
import {
  getWaSqliteWasmPaths,
  getWaSqliteWorkerEntrypointPaths,
} from '@syncular/dialect-wa-sqlite';

const portArg = process.argv.find((a) => a.startsWith('--port='));
const port = portArg ? Number.parseInt(portArg.split('=')[1]!, 10) : 0;
const repoRoot = path.resolve(import.meta.dir, '../../../..');
const rustPackageRoot = path.join(repoRoot, 'rust/bindings/browser');
const rustPackageWasmDir = path.join(rustPackageRoot, 'dist/wasm');

const rustWasmBuild = Bun.spawnSync(['bun', 'run', 'build:wasm:dev'], {
  cwd: rustPackageRoot,
  env: process.env,
  stdout: 'pipe',
  stderr: 'pipe',
});

if (rustWasmBuild.exitCode !== 0) {
  console.error('Failed to build Syncular Rust WASM client:');
  console.error(rustWasmBuild.stdout.toString());
  console.error(rustWasmBuild.stderr.toString());
  process.exit(1);
}

// Build the browser entry point
const entryBuild = await Bun.build({
  entrypoints: [path.join(import.meta.dir, 'entry.ts')],
  target: 'browser',
  format: 'esm',
  conditions: ['bun'],
});

if (!entryBuild.success) {
  console.error('Failed to build entry:', entryBuild.logs);
  process.exit(1);
}

const rustOwnedWorkerBuild = await Bun.build({
  entrypoints: [path.join(import.meta.dir, 'rust-owned-worker.ts')],
  target: 'browser',
  format: 'esm',
  conditions: ['bun'],
});

if (!rustOwnedWorkerBuild.success) {
  console.error(
    'Failed to build rust-owned worker:',
    rustOwnedWorkerBuild.logs
  );
  process.exit(1);
}

const syncularV2WorkerBuild = await Bun.build({
  entrypoints: [path.join(rustPackageRoot, 'src/worker-entry.ts')],
  target: 'browser',
  format: 'esm',
  conditions: ['bun'],
});

if (!syncularV2WorkerBuild.success) {
  console.error(
    'Failed to build Syncular v2 worker:',
    syncularV2WorkerBuild.logs
  );
  process.exit(1);
}

// Build the wa-sqlite worker
const { moduleWorkerPath } = getWaSqliteWorkerEntrypointPaths();
const workerBuild = await Bun.build({
  entrypoints: [moduleWorkerPath],
  target: 'browser',
  format: 'esm',
  splitting: false,
  publicPath: '/wasqlite/',
  conditions: ['bun'],
  naming: {
    entry: 'worker.js',
    chunk: 'chunk-[hash].js',
    asset: 'asset-[hash].[ext]',
  },
});

if (!workerBuild.success) {
  console.error('Failed to build worker:', workerBuild.logs);
  process.exit(1);
}
assertSingleWorkerBundle(workerBuild.outputs.map((output) => output.path));

// Get WASM file paths
const { asyncWasmPath, syncWasmPath } = getWaSqliteWasmPaths();

// Create asset map for worker chunks
const workerAssets = new Map<string, (typeof workerBuild.outputs)[0]>();
for (const output of workerBuild.outputs) {
  const name = output.path.split('/').at(-1);
  if (name) workerAssets.set(name, output);
}

const COOP_COEP_HEADERS = {
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-embedder-policy': 'require-corp',
  'cross-origin-resource-policy': 'cross-origin',
  'cache-control': 'no-cache',
};

const HTML = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Runtime Test</title></head>
<body>
<script type="module" src="/entry.js"></script>
</body>
</html>`;

const server = Bun.serve({
  port,
  fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' },
      });
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(HTML, {
        headers: { ...COOP_COEP_HEADERS, 'content-type': 'text/html' },
      });
    }

    if (url.pathname === '/entry.js') {
      return new Response(entryBuild.outputs[0], {
        headers: {
          ...COOP_COEP_HEADERS,
          'content-type': 'application/javascript',
        },
      });
    }

    if (url.pathname === '/rust-owned-worker.js') {
      return new Response(rustOwnedWorkerBuild.outputs[0], {
        headers: {
          ...COOP_COEP_HEADERS,
          'content-type': 'application/javascript',
        },
      });
    }

    if (url.pathname === '/syncular-v2-worker.js') {
      return new Response(syncularV2WorkerBuild.outputs[0], {
        headers: {
          ...COOP_COEP_HEADERS,
          'content-type': 'application/javascript',
        },
      });
    }

    if (url.pathname === '/wasqlite/wa-sqlite-async.wasm') {
      return new Response(Bun.file(asyncWasmPath), {
        headers: { ...COOP_COEP_HEADERS, 'content-type': 'application/wasm' },
      });
    }

    if (url.pathname === '/wasqlite/wa-sqlite.wasm') {
      return new Response(Bun.file(syncWasmPath), {
        headers: { ...COOP_COEP_HEADERS, 'content-type': 'application/wasm' },
      });
    }

    if (url.pathname === '/wasm/syncular_v2.js') {
      return new Response(
        Bun.file(path.join(rustPackageWasmDir, 'syncular_v2.js')),
        {
          headers: {
            ...COOP_COEP_HEADERS,
            'content-type': 'application/javascript',
          },
        }
      );
    }

    if (url.pathname === '/wasm/syncular_v2_bg.wasm') {
      return new Response(
        Bun.file(path.join(rustPackageWasmDir, 'syncular_v2_bg.wasm')),
        {
          headers: { ...COOP_COEP_HEADERS, 'content-type': 'application/wasm' },
        }
      );
    }

    // Worker chunks
    if (url.pathname.startsWith('/wasqlite/')) {
      const name = url.pathname.slice('/wasqlite/'.length);
      const asset = workerAssets.get(name);
      if (asset) {
        return new Response(asset, {
          headers: {
            ...COOP_COEP_HEADERS,
            'content-type': 'application/javascript',
          },
        });
      }
    }

    return new Response('Not found', { status: 404 });
  },
});

console.log(`READY:${server.port}`);

function assertSingleWorkerBundle(outputPaths: readonly string[]): void {
  const outputNames = outputPaths
    .map((outputPath) => outputPath.split('/').at(-1))
    .filter((name): name is string => Boolean(name));
  const extraOutputs = outputNames.filter((name) => name !== 'worker.js');

  if (extraOutputs.length === 0) return;

  throw new Error(
    `[runtime-browser] wa-sqlite worker build produced split artifacts (${extraOutputs.join(', ')}). ` +
      'This can trigger Bun ESM duplicate-export crashes in module workers. Keep worker bundling unsplit.'
  );
}
