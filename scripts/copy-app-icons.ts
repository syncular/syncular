import { copyFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const faviconDir = fileURLToPath(new URL('../assets/favicon', import.meta.url));

const targets = [
  fileURLToPath(new URL('../apps/docs/public/assets', import.meta.url)),
  fileURLToPath(new URL('../apps/demo/assets', import.meta.url)),
  fileURLToPath(new URL('../apps/console/assets', import.meta.url)),
];

// Copy all favicon assets to each app
const files = readdirSync(faviconDir);
for (const targetDir of targets) {
  mkdirSync(targetDir, { recursive: true });
  for (const file of files) {
    copyFileSync(join(faviconDir, file), join(targetDir, file));
    console.log(
      `[icons] copied ${relative(process.cwd(), join(targetDir, file))}`
    );
  }
}

// Clean up legacy files from previous locations (root-level copies + old icon.svg)
const legacyRoots = [
  fileURLToPath(new URL('../apps/docs/public', import.meta.url)),
  fileURLToPath(new URL('../apps/demo', import.meta.url)),
  fileURLToPath(new URL('../apps/console', import.meta.url)),
];

for (const root of legacyRoots) {
  for (const file of files) {
    try {
      unlinkSync(join(root, file));
      console.log(
        `[icons] removed legacy ${relative(process.cwd(), join(root, file))}`
      );
    } catch {
      // Already removed or never existed
    }
  }
}
