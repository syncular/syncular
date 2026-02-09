import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourcePath = fileURLToPath(
  new URL('../assets/icon.svg', import.meta.url)
);

const targetPaths = [
  fileURLToPath(new URL('../apps/demo/icon.svg', import.meta.url)),
  fileURLToPath(new URL('../apps/console/icon.svg', import.meta.url)),
  fileURLToPath(new URL('../apps/docs/src/app/icon.svg', import.meta.url)),
];

for (const targetPath of targetPaths) {
  mkdirSync(dirname(targetPath), { recursive: true });
  copyFileSync(sourcePath, targetPath);
  console.log(`[icons] copied ${relative(process.cwd(), targetPath)}`);
}
