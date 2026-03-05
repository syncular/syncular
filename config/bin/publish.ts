#!/usr/bin/env bun
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { $ } from 'bun';
import { fixEsmImportsInDirectory } from '../lib/esm-imports';

function listTarballs(): string[] {
  return readdirSync(process.cwd())
    .filter((entry) => entry.endsWith('.tgz'))
    .sort((left, right) => left.localeCompare(right));
}

function decodeOutput(
  value: string | Uint8Array | ArrayBufferLike | null | undefined
): string {
  if (typeof value === 'string') {
    return value;
  }

  if (value instanceof Uint8Array) {
    return new TextDecoder().decode(value);
  }

  if (value instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(value));
  }

  if (value == null) {
    return '';
  }

  return String(value);
}

function readPackageName(): string {
  const packageJsonPath = join(process.cwd(), 'package.json');
  const raw = readFileSync(packageJsonPath, 'utf8');
  const parsed = JSON.parse(raw) as { name?: string };
  if (typeof parsed.name !== 'string' || parsed.name.length === 0) {
    throw new Error(`Missing valid package name in ${packageJsonPath}.`);
  }
  return parsed.name;
}

async function packageExistsOnNpm(packageName: string): Promise<boolean> {
  const result =
    await $`npm view ${packageName} version --registry https://registry.npmjs.org/`.nothrow();
  if (result.exitCode === 0) {
    return true;
  }

  const stderr = decodeOutput(result.stderr);
  if (stderr.includes('E404') || stderr.includes('404 Not Found')) {
    return false;
  }

  const stdout = decodeOutput(result.stdout);
  throw new Error(
    `Failed to check npm package existence for ${packageName} (exit ${result.exitCode}).\nstdout:\n${stdout}\nstderr:\n${stderr}`
  );
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
const packageName = readPackageName();
const publishResult =
  await $`npm publish ${tarball} --tag latest --provenance`.nothrow();
if (publishResult.exitCode !== 0) {
  const stderr = decodeOutput(publishResult.stderr);
  const stdout = decodeOutput(publishResult.stdout);

  if (stderr.includes('ENEEDAUTH')) {
    const packageExists = await packageExistsOnNpm(packageName);
    if (!packageExists) {
      console.warn(
        `[syncular-publish] Skipping first publish for ${packageName}: npm trusted publishing is not configured for this package yet.`
      );
      console.warn(
        '[syncular-publish] Bootstrap the package once with an npm automation token, then rerun release.'
      );
      await $`rm -f ${tarball}`;
      process.exit(0);
    }
  }

  throw new Error(
    `npm publish failed for ${packageName} (exit ${publishResult.exitCode}).\nstdout:\n${stdout}\nstderr:\n${stderr}`
  );
}

await $`rm -f ${tarball}`;
