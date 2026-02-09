/**
 * Bun plugin that resolves @syncular/* workspace packages from source (./src/index.ts)
 * instead of dist (./dist/index.js) during browser bundling.
 *
 * Bun's HTML bundler uses the "import" export condition which points to dist/.
 * In development we want to resolve from source so we don't need to build packages first.
 */

import { existsSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import type { BunPlugin } from 'bun';

const PACKAGES_DIR = resolve(import.meta.dir, '../../../packages');

export default {
  name: 'workspace-source',
  setup(build) {
    build.onResolve({ filter: /^@syncular\// }, (args) => {
      const pkgName = args.path.slice('@syncular/'.length);
      // Handle sub-path imports like @syncular/ui/demo
      const slashIndex = pkgName.indexOf('/');
      if (slashIndex === -1) {
        return { path: resolve(PACKAGES_DIR, pkgName, 'src/index.ts') };
      }
      const dir = pkgName.slice(0, slashIndex);
      const subpath = pkgName.slice(slashIndex + 1);
      const base = resolve(PACKAGES_DIR, dir, 'src', subpath);
      // If the subpath has a file extension, use it directly
      if (extname(subpath)) return { path: base };
      // Otherwise check if it's a directory with an index.ts
      const withIndex = resolve(base, 'index.ts');
      if (existsSync(withIndex)) return { path: withIndex };
      return { path: base };
    });
  },
} satisfies BunPlugin;
