import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build as viteBuild } from 'vite';

// Minified browser graphs with SQLite external. On Bun 1.4.4 the client
// measures 164804 bytes and the worker 185930 bytes. The ceilings are the
// values at the start of the core review program; a change that grows a lane
// removes code to stay under them. Independently assert that ordinary imports
// exclude authority modules.
test('ordinary client, worker and native graphs exclude authority; only explicit opt-in retains it', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'syncular-authority-bundle-'));
  const root = resolve(import.meta.dir, '../../..');
  try {
    for (const [lane, source, optIn, ceiling] of [
      [
        'client',
        `export { SyncClient } from '${root}/packages/web-client/src/client.ts';`,
        false,
        167000,
      ],
      [
        'client-root',
        `export { SyncClient } from '${root}/packages/web-client/src/index.ts';`,
        false,
        167000,
      ],
      [
        'worker',
        `import { startSyncWorker } from '${root}/packages/web-client/src/worker-entry.ts'; startSyncWorker();`,
        false,
        187000,
      ],
      [
        'remote-worker',
        `import { startSyncWorker } from '${root}/packages/web-client/src/worker-remote.ts'; startSyncWorker();`,
        false,
        187000,
      ],
      [
        'authority-worker',
        `import { startSyncWorker } from '${root}/packages/web-client/src/worker-entry.ts'; import { defineAuthorityReads } from '${root}/packages/web-client/src/authority.ts'; startSyncWorker({ createAuthorityReads: defineAuthorityReads });`,
        true,
        Infinity,
      ],
      [
        'tauri',
        `export { createTauriSyncClient } from '${root}/packages/tauri/src/index.ts';`,
        false,
        Infinity,
      ],
      [
        'remote-tauri',
        `export { createTauriSyncClient } from '${root}/packages/tauri/src/remote.ts';`,
        false,
        Infinity,
      ],
      [
        'authority-tauri',
        `export { createTauriAuthoritySyncClient } from '${root}/packages/tauri/src/authority.ts';`,
        true,
        Infinity,
      ],
    ] as const) {
      const entry = join(directory, `${lane}.ts`);
      writeFileSync(entry, source);
      const authorityModules: string[] = [];
      const result = await Bun.build({
        entrypoints: [entry],
        target: 'browser',
        conditions: ['bun'],
        minify: true,
        external: [
          '@sqlite.org/sqlite-wasm',
          '@tauri-apps/api/core',
          '@tauri-apps/api/event',
        ],
        plugins: [
          {
            name: 'authority-module-evidence',
            setup(build) {
              // Resolve workspace packages explicitly from this temporary consumer.
              build.onResolve(
                { filter: /^@syncular\/(client|core)$/ },
                (args) => ({
                  path: join(
                    root,
                    'packages',
                    args.path.endsWith('/client') ? 'web-client' : 'core',
                    'src/index.ts',
                  ),
                }),
              );
              build.onLoad({ filter: /\/authority\.ts$/ }, (args) => {
                authorityModules.push(args.path);
                return undefined;
              });
            },
          },
        ],
      });
      expect(result.success).toBe(true);
      expect(result.outputs).toHaveLength(1);
      const bytes = new Uint8Array(await result.outputs[0]!.arrayBuffer());
      expect(bytes.length).toBeLessThanOrEqual(ceiling);
      if (lane === 'authority-tauri') {
        // The native bridge decodes the Rust snapshot; it does not bundle the TS reader.
        expect(authorityModules).toEqual([
          join(root, 'packages/tauri/src/authority.ts'),
        ]);
      } else {
        expect(authorityModules.length > 0).toBe(optIn);
      }
      const code = new TextDecoder().decode(bytes);
      // No production entry imports `@syncular/client/dev`.
      expect(code).not.toContain('client.profiler_in_production');
      for (const method of [
        'localAuthorityState',
        'attachLocalAuthority',
        'abandonLocalAuthorityAttach',
      ]) {
        if (lane === 'remote-worker' || lane === 'remote-tauri')
          expect(code).not.toContain(method);
        if (lane === 'worker' || lane === 'tauri')
          expect(code).toContain(method);
      }
      expect(code.includes('authority persisted evidence is invalid')).toBe(
        lane === 'authority-worker',
      );
      if (lane.includes('tauri'))
        expect(code.includes('authoritySnapshot accepts no arguments')).toBe(
          optIn,
        );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Vite production excludes optional local authority from remote entries', async () => {
  const root = resolve(import.meta.dir, '../../..');
  const directory = mkdtempSync(join(root, '.bundle-test-'));
  const previousNodeEnv = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    for (const [lane, source, includesAuthority] of [
      [
        'worker',
        `import { startSyncWorker } from '${root}/packages/web-client/src/worker-entry.ts'; startSyncWorker();`,
        true,
      ],
      [
        'remote-worker',
        `import { startSyncWorker } from '${root}/packages/web-client/src/worker-remote.ts'; startSyncWorker();`,
        false,
      ],
      [
        'tauri',
        `import { createTauriSyncClient } from '${root}/packages/tauri/src/index.ts'; globalThis.bundleProbe = createTauriSyncClient;`,
        true,
      ],
      [
        'remote-tauri',
        `import { createTauriSyncClient } from '${root}/packages/tauri/src/remote.ts'; globalThis.bundleProbe = createTauriSyncClient;`,
        false,
      ],
    ] as const) {
      const entry = join(directory, `${lane}.ts`);
      writeFileSync(entry, source);
      const result = await viteBuild({
        configFile: false,
        mode: 'production',
        logLevel: 'silent',
        resolve: { conditions: ['bun'] },
        build: {
          write: false,
          minify: true,
          rollupOptions: {
            input: entry,
            external: [
              '@sqlite.org/sqlite-wasm',
              '@tauri-apps/api/core',
              '@tauri-apps/api/event',
            ],
          },
        },
      });
      if (Array.isArray(result) || !('output' in result))
        throw new Error('expected one production Vite output');
      const code = result.output
        .filter((output) => output.type === 'chunk')
        .map((output) => output.code)
        .join('\n');
      for (const method of [
        'localAuthorityState',
        'attachLocalAuthority',
        'abandonLocalAuthorityAttach',
      ]) {
        expect(code.includes(method)).toBe(includesAuthority);
      }
      expect(code).not.toContain('__SYNCULAR__');
      expect(code).not.toContain('client.profiler_in_production');
    }
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    rmSync(directory, { recursive: true, force: true });
  }
});
