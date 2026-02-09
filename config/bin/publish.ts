#!/usr/bin/env bun
import { readdirSync } from 'node:fs';
import { $ } from 'bun';
import { fixEsmImportsInDirectory } from '../lib/esm-imports';

function listTarballs(): string[] {
  return readdirSync(process.cwd())
    .filter((entry) => entry.endsWith('.tgz'))
    .sort((left, right) => left.localeCompare(right));
}

fixEsmImportsInDirectory('dist');

await $`bun pm pack --destination .`;
const tarballs = listTarballs();

if (tarballs.length !== 1) {
  const found = tarballs.length === 0 ? 'none' : tarballs.join(', ');
  throw new Error(
    `Expected exactly one package archive (*.tgz), found ${tarballs.length} (${found}).`
  );
}

const [tarball] = tarballs;
await $`npm publish ${tarball} --tag latest --provenance`;
await $`rm -f ${tarball}`;
