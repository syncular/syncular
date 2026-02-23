import { copyFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const faviconDir = fileURLToPath(new URL('../assets/favicon', import.meta.url));

const targets = [
  fileURLToPath(new URL('../apps/docs/public', import.meta.url)),
  fileURLToPath(new URL('../apps/demo', import.meta.url)),
  fileURLToPath(new URL('../apps/console', import.meta.url)),
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

// Clean up legacy icon.svg files from previous sync:icons runs
const legacyPaths = [
  fileURLToPath(new URL('../apps/docs/src/app/icon.svg', import.meta.url)),
  fileURLToPath(new URL('../apps/demo/icon.svg', import.meta.url)),
  fileURLToPath(new URL('../apps/console/icon.svg', import.meta.url)),
];

for (const legacyPath of legacyPaths) {
  try {
    unlinkSync(legacyPath);
    console.log(
      `[icons] removed legacy ${relative(process.cwd(), legacyPath)}`
    );
  } catch {
    // Already removed or never existed
  }
}
