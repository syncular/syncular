/**
 * Post-`changeset version` sync. Changesets owns the committed package.json
 * versions; this script propagates the new release version into everything
 * Changesets does not know about:
 *
 *   1. Verifies the fixed-group invariant (every publishable package carries
 *      the same version).
 *   2. Root package.json version (base version for ephemeral CI stamping in
 *      deploy.yml and staging releases via scripts/stamp-versions.ts).
 *   3. The runtime contract constants in
 *      packages/client/src/wasm-bindings/runtime-contract.ts.
 *   4. create-syncular-app's FALLBACK_SYNCULAR_VERSION_RANGE.
 *   5. Cargo crate versions via scripts/stamp-cargo-versions.ts.
 *   6. Committed codegen outputs that embed the crate version
 *      (syncularNativeExpectedCrateVersion in generated Swift/Kotlin) —
 *      regenerated with the freshly stamped workspace syncular-codegen so
 *      version bumps stop breaking `rust:codegen:check`.
 *
 * Usage: bun scripts/sync-versions.ts
 * (wired into the root `version` script: `changeset version && bun scripts/sync-versions.ts`)
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { listWorkspacePackageJsonPaths } from './version-utils';

type PackageJson = {
  name?: string;
  version?: string;
  private?: boolean;
  scripts?: Record<string, string | undefined>;
  publishConfig?: { access?: string };
};

const repoRoot = join(import.meta.dirname, '..');

function isPublishableWorkspacePackage(pkg: PackageJson): boolean {
  if (pkg.private === true || typeof pkg.version !== 'string') {
    return false;
  }

  const releaseScript = pkg.scripts?.release;
  return (
    typeof releaseScript === 'string' &&
    releaseScript.trim().length > 0 &&
    pkg.publishConfig?.access === 'public'
  );
}

function readReleaseVersion(): string {
  const versions = new Map<string, string>();
  for (const packageJsonPath of packageJsonPaths) {
    const pkg = JSON.parse(
      readFileSync(packageJsonPath, 'utf8')
    ) as PackageJson;
    if (!isPublishableWorkspacePackage(pkg)) {
      continue;
    }
    if (typeof pkg.name === 'string' && typeof pkg.version === 'string') {
      versions.set(pkg.name, pkg.version);
    }
  }

  const distinct = new Set(versions.values());
  if (versions.size === 0 || distinct.size !== 1) {
    const detail = [...versions.entries()]
      .map(([name, version]) => `  ${name} → ${version}`)
      .join('\n');
    throw new Error(
      `Publishable packages must share one version (fixed Changesets group). Found:\n${detail}`
    );
  }

  const [version] = distinct;
  if (!version || version === '0.0.0') {
    throw new Error(
      `Refusing to sync placeholder version ${version}. Run \`bunx changeset version\` first.`
    );
  }
  return version;
}

function syncRootPackageVersion(version: string): void {
  const rootPackageJsonPath = join(repoRoot, 'package.json');
  const pkg = JSON.parse(readFileSync(rootPackageJsonPath, 'utf8')) as Record<
    string,
    unknown
  >;
  pkg.version = version;
  writeFileSync(rootPackageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`  root package.json → ${version}`);
}

function replaceConstant(
  source: string,
  pattern: RegExp,
  replacement: string,
  label: string,
  filePath: string
): string {
  if (!pattern.test(source)) {
    throw new Error(`Could not find ${label} in ${filePath}`);
  }
  return source.replace(pattern, replacement);
}

function syncRuntimeContract(version: string): void {
  const runtimeContractPath = join(
    repoRoot,
    'packages/client/src/wasm-bindings/runtime-contract.ts'
  );
  let source = readFileSync(runtimeContractPath, 'utf8');
  source = replaceConstant(
    source,
    /export const SYNCULAR_CLIENT_PACKAGE_VERSION = ['"][^'"]+['"];/,
    `export const SYNCULAR_CLIENT_PACKAGE_VERSION = '${version}';`,
    'SYNCULAR_CLIENT_PACKAGE_VERSION',
    runtimeContractPath
  );
  writeFileSync(runtimeContractPath, source);
  console.log(`  runtime contract → ${version}`);
}

function syncCreateAppFallbackRange(version: string): void {
  const cliPath = join(repoRoot, 'packages/create-syncular-app/src/cli.ts');
  let source = readFileSync(cliPath, 'utf8');
  source = replaceConstant(
    source,
    /const FALLBACK_SYNCULAR_VERSION_RANGE = ['"][^'"]+['"];/,
    `const FALLBACK_SYNCULAR_VERSION_RANGE = '^${version}';`,
    'FALLBACK_SYNCULAR_VERSION_RANGE',
    cliPath
  );
  writeFileSync(cliPath, source);
  console.log(`  create-syncular-app fallback range → ^${version}`);
}

function syncCargoVersions(version: string): void {
  const result = spawnSync(
    'bun',
    ['scripts/stamp-cargo-versions.ts', '--version', version],
    { cwd: repoRoot, stdio: 'inherit' }
  );
  if (result.status !== 0) {
    throw new Error(`stamp-cargo-versions.ts exited with ${result.status}`);
  }
}

/**
 * In-repo manifests with committed `generated/` output. The Rust codegen
 * stamps env!("CARGO_PKG_VERSION") into the generated Swift/Kotlin
 * (`syncularNativeExpectedCrateVersion`), so these must be regenerated after
 * every crate version stamp or `rust:codegen:check` goes red on the next bump.
 */
const GENERATED_MANIFEST_DIRS = [
  'rust/examples/todo-app',
  'apps/demo',
  'packages/create-syncular-app/template',
];

function regenerateVersionedCodegenOutputs(): void {
  for (const manifestDir of GENERATED_MANIFEST_DIRS) {
    const result = spawnSync(
      'cargo',
      [
        'run',
        '--manifest-path',
        join(repoRoot, 'rust/Cargo.toml'),
        '-p',
        'syncular-codegen',
        '--',
        '--manifest-dir',
        join(repoRoot, manifestDir),
      ],
      { cwd: repoRoot, stdio: 'inherit' }
    );
    if (result.status !== 0) {
      throw new Error(
        `syncular-codegen failed for ${manifestDir} (exit ${result.status})`
      );
    }
    console.log(`  regenerated codegen outputs → ${manifestDir}`);
  }
}

const packageJsonPaths = await listWorkspacePackageJsonPaths();
const version = readReleaseVersion();
console.log(`Syncing release version: ${version}\n`);
syncRootPackageVersion(version);
syncRuntimeContract(version);
syncCreateAppFallbackRange(version);
syncCargoVersions(version);
regenerateVersionedCodegenOutputs();
