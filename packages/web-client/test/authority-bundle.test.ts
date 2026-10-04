import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Bun 1.4.0, minified browser graphs with SQLite external. The 0.30.14 tagged
// source measures 146310 bytes for the client and 162403 for the worker.
// Keep those raw ceilings; opting out must restore the pre-authority payload.
test('ordinary client, worker and native graphs exclude authority; only explicit opt-in retains it', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'syncular-authority-bundle-'));
  const root = resolve(import.meta.dir, '../../..');
  try {
    for (const [lane, source, optIn, ceiling] of [
      [
        'client',
        `export { SyncClient } from '${root}/packages/web-client/src/client.ts';`,
        false,
        146310,
      ],
      [
        'client-root',
        `export { SyncClient } from '${root}/packages/web-client/src/index.ts';`,
        false,
        146310,
      ],
      [
        'worker',
        `import { startSyncWorker } from '${root}/packages/web-client/src/worker-entry.ts'; startSyncWorker();`,
        false,
        162403,
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
