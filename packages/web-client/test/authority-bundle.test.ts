import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Bun 1.4.0, minified browser graphs with SQLite external. After the §12
// local-authority seam and the queued-insert marker, the client measures
// 163029 bytes and the worker 181505 bytes on Bun 1.4.0 (162385 and 181182 on
// Bun 1.4.4). The ceilings round up from the maximum observed in source and
// materialized builds. Independently assert that ordinary imports
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
        164000,
      ],
      [
        'client-root',
        `export { SyncClient } from '${root}/packages/web-client/src/index.ts';`,
        false,
        164000,
      ],
      [
        'worker',
        `import { startSyncWorker } from '${root}/packages/web-client/src/worker-entry.ts'; startSyncWorker();`,
        false,
        182000,
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
