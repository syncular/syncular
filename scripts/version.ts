#!/usr/bin/env bun
/**
 * Syncular release-version authority.
 *
 * The root package.json is the only authored release version. Every managed
 * child manifest and internal dependency constraint is committed as 0.0.0.
 * Release jobs run `materialize` in their ephemeral checkout, which reflects
 * the root version into npm, Cargo, Flutter, and lockfile metadata before any
 * artifact is packed or published.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const VERSION_PLACEHOLDER = '0.0.0';

const scriptDir = dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = join(scriptDir, '..');

export const managedNpmManifestPaths = [
  'packages/conformance/package.json',
  'packages/core/package.json',
  'packages/crdt-yjs/package.json',
  'packages/create-app/package.json',
  'packages/crypto/package.json',
  'packages/react/package.json',
  'packages/server-hono/package.json',
  'packages/server-workers/package.json',
  'packages/server/package.json',
  'packages/tauri/package.json',
  'packages/testing/package.json',
  'packages/typegen/package.json',
  'packages/web-client/package.json',
  'bindings/react-native/package.json',
  'editors/vscode-syql/package.json',
] as const;

export const bunWorkspaceManifestPaths = managedNpmManifestPaths.filter(
  (path) => path !== 'editors/vscode-syql/package.json',
);

export const managedCargoPackages = [
  {
    name: 'syncular-ssp2',
    manifest: 'rust/crates/ssp2/Cargo.toml',
    locks: ['rust/Cargo.lock', 'bindings/tauri/Cargo.lock'],
  },
  {
    name: 'syncular-client',
    manifest: 'rust/crates/client/Cargo.toml',
    locks: ['rust/Cargo.lock', 'bindings/tauri/Cargo.lock'],
  },
  {
    name: 'syncular-command',
    manifest: 'rust/crates/command/Cargo.toml',
    locks: ['rust/Cargo.lock', 'bindings/tauri/Cargo.lock'],
  },
  {
    name: 'syncular-ffi',
    manifest: 'rust/crates/ffi/Cargo.toml',
    locks: ['rust/Cargo.lock'],
  },
  {
    name: 'syncular',
    manifest: 'rust/crates/syncular/Cargo.toml',
    locks: ['rust/Cargo.lock'],
  },
  {
    name: 'tauri-plugin-syncular',
    manifest: 'bindings/tauri/plugin/Cargo.toml',
    locks: ['bindings/tauri/Cargo.lock'],
  },
] as const;

export const managedFlutterManifestPaths = [
  'bindings/flutter/syncular/pubspec.yaml',
] as const;

const managedArtifactVersionTextPaths = [
  { path: 'packages/react/src/runtime-version.ts', occurrences: 1 },
  {
    path: 'packages/create-app/template/tauri/src-tauri/Cargo.toml',
    occurrences: 1,
  },
  { path: 'bindings/tauri/README.md', occurrences: 1 },
] as const;

const managedBuildTimeVersionTextPaths = [
  { path: 'apps/docs/src/content/platform-rust.md', occurrences: 3 },
  { path: 'apps/docs/src/content/platform-tauri.md', occurrences: 1 },
  { path: 'apps/docs/src/content/platform-ffi.md', occurrences: 1 },
  { path: 'apps/demo/src/frontend/index.html', occurrences: 1 },
] as const;

const internalCargoConstraintPaths = [
  'rust/crates/client/Cargo.toml',
  'rust/crates/command/Cargo.toml',
  'rust/crates/ffi/Cargo.toml',
  'bindings/tauri/plugin/Cargo.toml',
] as const;

const internalCargoNames = new Set(
  managedCargoPackages.map((entry) => entry.name),
);

export type VersionMode = 'source' | 'materialized';

interface JsonManifest {
  readonly name?: string;
  version?: string;
  readonly [key: string]: unknown;
}

function absolute(path: string): string {
  return join(repositoryRoot, path);
}

async function readText(path: string): Promise<string> {
  return readFile(absolute(path), 'utf8');
}

async function readJson(path: string): Promise<JsonManifest> {
  return JSON.parse(await readText(path)) as JsonManifest;
}

export function isReleaseVersion(value: string): boolean {
  return /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
    value,
  );
}

export async function readRootVersion(): Promise<string> {
  const rootPackage = await readJson('package.json');
  const version = rootPackage.version;
  if (typeof version !== 'string' || !isReleaseVersion(version)) {
    throw new Error(
      'root package.json must contain a valid full SemVer `version`',
    );
  }
  if (version === VERSION_PLACEHOLDER) {
    throw new Error('root package.json must not use the 0.0.0 placeholder');
  }
  return version;
}

function packageVersion(text: string, path: string): string {
  const lines = text.split('\n');
  const packageStart = lines.findIndex((line) => line.trim() === '[package]');
  const packageEnd = lines.findIndex(
    (line, index) => index > packageStart && /^\s*\[/.test(line),
  );
  const section = lines.slice(
    packageStart + 1,
    packageEnd < 0 ? undefined : packageEnd,
  );
  const version = section
    .find((line) => /^version\s*=/.test(line))
    ?.match(/^version\s*=\s*"([^"]+)"\s*$/)?.[1];
  if (version === undefined) {
    throw new Error(`${path}: missing [package] version`);
  }
  return version;
}

function internalCargoConstraintVersions(
  text: string,
): ReadonlyArray<{ readonly line: number; readonly version: string }> {
  const versions: Array<{ line: number; version: string }> = [];
  for (const [index, line] of text.split('\n').entries()) {
    if (!line.includes('path =')) continue;
    if (![...internalCargoNames].some((name) => line.includes(name))) continue;
    const version = line.match(/\bversion\s*=\s*"([^"]+)"/)?.[1];
    if (version !== undefined) versions.push({ line: index + 1, version });
  }
  return versions;
}

export function materializeCargoManifest(
  text: string,
  version: string,
): string {
  let inPackageSection = false;
  let packageVersionSeen = false;
  const lines = text.split('\n').map((line) => {
    if (/^\s*\[/.test(line)) inPackageSection = line.trim() === '[package]';
    if (
      inPackageSection &&
      !packageVersionSeen &&
      /^version\s*=\s*"[^"]+"\s*$/.test(line)
    ) {
      packageVersionSeen = true;
      return `version = "${version}"`;
    }
    if (
      line.includes('path =') &&
      [...internalCargoNames].some((name) => line.includes(name)) &&
      /\bversion\s*=\s*"[^"]+"/.test(line)
    ) {
      return line.replace(/\bversion\s*=\s*"[^"]+"/, `version = "${version}"`);
    }
    return line;
  });
  if (!packageVersionSeen)
    throw new Error('Cargo manifest has no package version');
  return lines.join('\n');
}

export function materializeCargoLock(
  text: string,
  packageNames: readonly string[],
  version: string,
): string {
  let result = text;
  for (const name of packageNames) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(
      `(\\[\\[package\\]\\]\\nname = "${escaped}"\\nversion = ")[^"]+("(?:\\n|$))`,
      'g',
    );
    let count = 0;
    result = result.replace(
      pattern,
      (_match, before: string, after: string) => {
        count += 1;
        return `${before}${version}${after}`;
      },
    );
    if (count !== 1) {
      throw new Error(
        `Cargo.lock expected exactly one ${name} package, found ${count}`,
      );
    }
  }
  return result;
}

export function materializeBunLockWorkspace(
  text: string,
  workspacePath: string,
  version: string,
): string {
  const marker = `    "${workspacePath}": {`;
  const start = text.indexOf(marker);
  if (start < 0) throw new Error(`bun.lock has no ${workspacePath} workspace`);
  const next = text.indexOf('\n    "', start + marker.length);
  const end = next < 0 ? text.length : next;
  const block = text.slice(start, end);
  let replacements = 0;
  const updated = block.replace(
    /("version": ")[^"]+("[,\n])/,
    (_match, before: string, after: string) => {
      replacements += 1;
      return `${before}${version}${after}`;
    },
  );
  if (replacements !== 1) {
    throw new Error(
      `bun.lock workspace ${workspacePath} expected one version stamp`,
    );
  }
  return `${text.slice(0, start)}${updated}${text.slice(end)}`;
}

function lockPackageVersion(
  text: string,
  packageName: string,
  path: string,
): string {
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = [
    ...text.matchAll(
      new RegExp(
        `\\[\\[package\\]\\]\\nname = "${escaped}"\\nversion = "([^"]+)"`,
        'g',
      ),
    ),
  ];
  if (matches.length !== 1) {
    throw new Error(
      `${path}: expected one ${packageName} package, found ${matches.length}`,
    );
  }
  return matches[0]?.[1] ?? '';
}

function parseBunLock(text: string): {
  readonly workspaces?: Readonly<Record<string, { readonly version?: string }>>;
} {
  return JSON.parse(text.replace(/,(\s*[}\]])/g, '$1')) as {
    readonly workspaces?: Readonly<
      Record<string, { readonly version?: string }>
    >;
  };
}

function expectedVersion(mode: VersionMode, rootVersion: string): string {
  return mode === 'source' ? VERSION_PLACEHOLDER : rootVersion;
}

function countOccurrences(text: string, value: string): number {
  return text.split(value).length - 1;
}

export async function checkVersionState(mode: VersionMode): Promise<string> {
  const rootVersion = await readRootVersion();
  const expected = expectedVersion(mode, rootVersion);
  const errors: string[] = [];

  const managedPackageManifests = new Set<string>(
    managedNpmManifestPaths.filter((path) => path.startsWith('packages/')),
  );
  for (const entry of await readdir(absolute('packages'), {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory()) continue;
    const path = `packages/${entry.name}/package.json`;
    try {
      await readFile(absolute(path));
      if (!managedPackageManifests.has(path)) {
        errors.push(`${path}: package is not managed by scripts/version.ts`);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw error;
    }
  }

  for (const path of managedNpmManifestPaths) {
    const manifest = await readJson(path);
    if (manifest.version !== expected) {
      errors.push(`${path}: ${manifest.version ?? '<missing>'} != ${expected}`);
    }
  }

  for (const entry of managedCargoPackages) {
    const text = await readText(entry.manifest);
    const version = packageVersion(text, entry.manifest);
    if (version !== expected) {
      errors.push(`${entry.manifest}: ${version} != ${expected}`);
    }
  }

  for (const path of internalCargoConstraintPaths) {
    const text = await readText(path);
    for (const constraint of internalCargoConstraintVersions(text)) {
      if (constraint.version !== expected) {
        errors.push(
          `${path}:${constraint.line}: internal constraint ${constraint.version} != ${expected}`,
        );
      }
    }
  }

  for (const path of managedFlutterManifestPaths) {
    const text = await readText(path);
    const version = text.match(/^version:\s*([^\s]+)\s*$/m)?.[1];
    if (version !== expected) {
      errors.push(`${path}: ${version ?? '<missing>'} != ${expected}`);
    }
  }

  for (const entry of managedArtifactVersionTextPaths) {
    const text = await readText(entry.path);
    const count = countOccurrences(text, expected);
    if (count !== entry.occurrences) {
      errors.push(
        `${entry.path}: expected ${entry.occurrences} ${expected} artifact reference(s), found ${count}`,
      );
    }
  }

  // Site sources remain placeholders in both modes: their build pipeline
  // reflects the root version without mutating committed documentation.
  for (const entry of managedBuildTimeVersionTextPaths) {
    const text = await readText(entry.path);
    const count = countOccurrences(text, VERSION_PLACEHOLDER);
    if (count !== entry.occurrences) {
      errors.push(
        `${entry.path}: expected ${entry.occurrences} build-time placeholder(s), found ${count}`,
      );
    }
  }

  const bunLockText = await readText('bun.lock');
  const bunLock = parseBunLock(bunLockText);
  for (const manifestPath of bunWorkspaceManifestPaths) {
    const workspacePath = dirname(manifestPath);
    const version = bunLock.workspaces?.[workspacePath]?.version;
    if (version !== expected) {
      errors.push(
        `bun.lock ${workspacePath}: ${version ?? '<missing>'} != ${expected}`,
      );
    }
  }

  const locks = new Map<string, string>();
  for (const entry of managedCargoPackages) {
    for (const path of entry.locks) {
      const text = locks.get(path) ?? (await readText(path));
      locks.set(path, text);
      const version = lockPackageVersion(text, entry.name, path);
      if (version !== expected) {
        errors.push(`${path} ${entry.name}: ${version} != ${expected}`);
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `version state is not ${mode} (root ${rootVersion}):\n${errors
        .map((error) => `  ${error}`)
        .join('\n')}`,
    );
  }
  return rootVersion;
}

export async function materializeVersion(): Promise<string> {
  const rootVersion = await checkVersionState('source');

  for (const path of managedNpmManifestPaths) {
    const manifest = await readJson(path);
    manifest.version = rootVersion;
    await writeFile(absolute(path), `${JSON.stringify(manifest, null, 2)}\n`);
  }

  for (const entry of managedCargoPackages) {
    const text = await readText(entry.manifest);
    await writeFile(
      absolute(entry.manifest),
      materializeCargoManifest(text, rootVersion),
    );
  }

  for (const path of managedFlutterManifestPaths) {
    const text = await readText(path);
    const updated = text.replace(
      /^version:\s*[^\s]+\s*$/m,
      `version: ${rootVersion}`,
    );
    if (updated === text) throw new Error(`${path}: no version to materialize`);
    await writeFile(absolute(path), updated);
  }

  for (const entry of managedArtifactVersionTextPaths) {
    const text = await readText(entry.path);
    const count = countOccurrences(text, VERSION_PLACEHOLDER);
    if (count !== entry.occurrences) {
      throw new Error(
        `${entry.path}: expected ${entry.occurrences} artifact placeholder(s), found ${count}`,
      );
    }
    await writeFile(
      absolute(entry.path),
      text.replaceAll(VERSION_PLACEHOLDER, rootVersion),
    );
  }

  let bunLock = await readText('bun.lock');
  for (const manifestPath of bunWorkspaceManifestPaths) {
    bunLock = materializeBunLockWorkspace(
      bunLock,
      dirname(manifestPath),
      rootVersion,
    );
  }
  await writeFile(absolute('bun.lock'), bunLock);

  const packagesByLock = new Map<string, string[]>();
  for (const entry of managedCargoPackages) {
    for (const lock of entry.locks) {
      const names = packagesByLock.get(lock) ?? [];
      names.push(entry.name);
      packagesByLock.set(lock, names);
    }
  }
  for (const [path, names] of packagesByLock) {
    const text = await readText(path);
    await writeFile(
      absolute(path),
      materializeCargoLock(text, names, rootVersion),
    );
  }

  await checkVersionState('materialized');
  return rootVersion;
}

function usage(): string {
  return `usage: bun scripts/version.ts <command>\n\ncommands:\n  print                    print the root release version\n  check                    require committed 0.0.0 placeholders\n  check --materialized     require root versions in release metadata\n  assert-tag <vX.Y.Z>      require the tag to match root package.json\n  materialize              reflect root version in this ephemeral checkout`;
}

async function main(): Promise<void> {
  const [command, ...args] = Bun.argv.slice(2);
  if (command === 'print' && args.length === 0) {
    console.log(await readRootVersion());
    return;
  }
  if (command === 'check') {
    if (
      !(
        args.length === 0 ||
        (args.length === 1 && args[0] === '--materialized')
      )
    ) {
      throw new Error(usage());
    }
    const mode: VersionMode =
      args[0] === '--materialized' ? 'materialized' : 'source';
    const version = await checkVersionState(mode);
    console.log(`version: ${mode} metadata is valid for ${version}`);
    return;
  }
  if (command === 'assert-tag') {
    const tag = args[0];
    if (tag === undefined || args.length !== 1) throw new Error(usage());
    const version = await readRootVersion();
    if (tag !== `v${version}`) {
      throw new Error(`tag ${tag} does not match root version v${version}`);
    }
    console.log(`version: tag ${tag} matches root package.json`);
    return;
  }
  if (command === 'materialize' && args.length === 0) {
    const version = await materializeVersion();
    console.log(
      `version: materialized ${version} into the ephemeral release checkout`,
    );
    return;
  }
  throw new Error(usage());
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  });
}
