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

function readNpmTag(): string {
  const tag = (
    process.env.SYNCULAR_NPM_TAG ??
    process.env.npm_config_tag ??
    process.env.NPM_CONFIG_TAG ??
    'latest'
  ).trim();

  if (!/^[a-zA-Z0-9._-]+$/.test(tag)) {
    throw new Error(`Invalid npm tag: ${tag}`);
  }

  return tag;
}

function readDryRun(): boolean {
  const args = new Set(process.argv.slice(2));
  if (args.has('--dry-run')) {
    return true;
  }

  const value = (process.env.SYNCULAR_PUBLISH_DRY_RUN ?? '')
    .trim()
    .toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

async function listTarballFiles(tarball: string): Promise<string[]> {
  const result = await $`tar -tzf ${tarball}`.nothrow();
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to inspect npm package archive ${tarball}.\nstderr:\n${decodeOutput(result.stderr)}`
    );
  }

  return decodeOutput(result.stdout)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function isForbiddenPackageFile(path: string): boolean {
  const packagePath = path.replace(/^package\//, '');
  if (
    packagePath.startsWith('node_modules/') ||
    packagePath.startsWith('.context/') ||
    packagePath.startsWith('.turbo/') ||
    packagePath.startsWith('tests/') ||
    packagePath.startsWith('test/') ||
    packagePath.includes('/tests/') ||
    packagePath.includes('/test/') ||
    packagePath.includes('/__tests__/')
  ) {
    return true;
  }

  return /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(packagePath);
}

async function verifyTarballContents(tarball: string): Promise<void> {
  const files = await listTarballFiles(tarball);
  const badFiles = files.filter(isForbiddenPackageFile);
  if (badFiles.length > 0) {
    throw new Error(
      `npm package archive includes release junk:\n${badFiles.join('\n')}`
    );
  }
}

async function isPublishedVersion(
  packageName: string,
  version: string
): Promise<boolean> {
  const packageSpec = `${packageName}@${version}`;
  const result =
    await $`npm view ${packageSpec} version --registry https://registry.npmjs.org/ --json`.nothrow();
  if (result.exitCode === 0) {
    const raw = decodeOutput(result.stdout).trim();
    if (raw.length === 0) {
      return false;
    }

    const parsed = JSON.parse(raw) as string | string[];
    if (typeof parsed === 'string') {
      return parsed === version;
    }

    return parsed.includes(version);
  }

  const stderr = decodeOutput(result.stderr);
  if (stderr.includes('E404') || stderr.includes('404 Not Found')) {
    return false;
  }

  const stdout = decodeOutput(result.stdout);
  throw new Error(
    `Failed to query npm for ${packageSpec} (exit ${result.exitCode}).\nstdout:\n${stdout}\nstderr:\n${stderr}`
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
await verifyTarballContents(tarball);
const packageMeta = readPackageMeta();
const npmTag = readNpmTag();
const dryRun = readDryRun();
if (dryRun) {
  console.log(
    `[syncular-publish] dry-run publishing ${packageMeta.name}@${packageMeta.version} with npm tag ${npmTag}`
  );
}
const publishResult = dryRun
  ? await $`npm publish ${tarball} --tag ${npmTag} --dry-run`.nothrow()
  : await $`npm publish ${tarball} --tag ${npmTag} --provenance`.nothrow();
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
    if (await isPublishedVersion(packageMeta.name, packageMeta.version)) {
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
