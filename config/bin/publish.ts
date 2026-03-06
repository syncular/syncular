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

function readPackageMeta(): { name: string; version: string } {
  const packageJsonPath = join(process.cwd(), 'package.json');
  const raw = readFileSync(packageJsonPath, 'utf8');
  const parsed = JSON.parse(raw) as { name?: string; version?: string };

  if (typeof parsed.name !== 'string' || parsed.name.length === 0) {
    throw new Error(`Missing valid package name in ${packageJsonPath}.`);
  }

  if (typeof parsed.version !== 'string' || parsed.version.length === 0) {
    throw new Error(`Missing valid package version in ${packageJsonPath}.`);
  }

  return { name: parsed.name, version: parsed.version };
}

async function readPublishedVersion(
  packageName: string
): Promise<string | null> {
  const result =
    await $`npm view ${packageName} version --registry https://registry.npmjs.org/ --json`.nothrow();
  if (result.exitCode === 0) {
    const raw = decodeOutput(result.stdout).trim();
    if (raw.length === 0) {
      return null;
    }

    const parsed = JSON.parse(raw) as string | string[];
    if (typeof parsed === 'string') {
      return parsed;
    }

    if (parsed.length === 0) {
      return null;
    }

    return parsed[parsed.length - 1] ?? null;
  }

  const stderr = decodeOutput(result.stderr);
  if (stderr.includes('E404') || stderr.includes('404 Not Found')) {
    return null;
  }

  const stdout = decodeOutput(result.stdout);
  throw new Error(
    `Failed to query npm for ${packageName} (exit ${result.exitCode}).\nstdout:\n${stdout}\nstderr:\n${stderr}`
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
const packageMeta = readPackageMeta();
const publishResult =
  await $`npm publish ${tarball} --tag latest --provenance`.nothrow();
if (publishResult.exitCode !== 0) {
  const stderr = decodeOutput(publishResult.stderr);
  const stdout = decodeOutput(publishResult.stdout);
  const stderrLower = stderr.toLowerCase();

  const isVersionAlreadyPublished =
    stderrLower.includes(
      'you cannot publish over the previously published versions'
    ) ||
    stderrLower.includes(
      'cannot publish over the previously published versions'
    );

  if (isVersionAlreadyPublished) {
    const publishedVersion = await readPublishedVersion(packageMeta.name);
    if (publishedVersion === packageMeta.version) {
      console.warn(
        `[syncular-publish] ${packageMeta.name}@${packageMeta.version} is already published; skipping.`
      );
      await $`rm -f ${tarball}`;
      process.exit(0);
    }
  }

  throw new Error(
    `npm publish failed for ${packageMeta.name}@${packageMeta.version} (exit ${publishResult.exitCode}).\nstdout:\n${stdout}\nstderr:\n${stderr}`
  );
}

await $`rm -f ${tarball}`;
