#!/usr/bin/env bun
/**
 * Enforce shared UI primitives usage.
 * App-local primitive folders are not allowed.
 */

import { existsSync } from 'node:fs';
import { Glob } from 'bun';

const forbiddenDirs = [
  'console/src/components/hero-ui',
  'apps/docs/src/components/hero-ui',
];

let hasErrors = false;

for (const directory of forbiddenDirs) {
  if (!existsSync(directory)) {
    continue;
  }

  hasErrors = true;
  console.error(`Forbidden UI directory found: ${directory}`);

  const glob = new Glob(`${directory}/**/*`);
  for await (const entry of glob.scan('.')) {
    console.error(`  - ${entry}`);
  }
}

if (hasErrors) {
  console.error('\nError: app-local primitive folders are not allowed.');
  console.error(
    'Move reusable primitives to packages/hero-ui and import from @syncular/ui.'
  );
  process.exit(1);
}

console.log('✓ No app-local duplicate UI primitive folders found');
