#!/usr/bin/env bun
/**
 * Check that no .jsx or .html files exist in packages (we use .tsx)
 */

import { Glob } from 'bun';

const patterns = ['packages/**/*.jsx', 'packages/**/*.html'];
let found = false;

for (const pattern of patterns) {
  const glob = new Glob(pattern);
  for await (const file of glob.scan('.')) {
    console.error(`Found disallowed file: ${file}`);
    found = true;
  }
}

if (found) {
  console.error('\nError: .jsx and .html files are not allowed in packages/');
  console.error('Use .tsx for React components instead.');
  process.exit(1);
}

console.log('✓ No .jsx or .html files found in packages/');
