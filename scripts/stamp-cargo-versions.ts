/**
 * Stamps publishable Rust crates with the same release version used by npm.
 *
 * Usage:
 *   bun scripts/stamp-cargo-versions.ts <suffix>
 *   bun scripts/stamp-cargo-versions.ts --version <version>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  computeStampedVersion,
  normalizeReleaseVersion,
} from './version-utils';

type CargoCrate = {
  name: string;
  manifestPath: string;
};

const repoRoot = join(import.meta.dirname, '..');
const crates: CargoCrate[] = [
  {
    name: 'syncular',
    manifestPath: 'rust/crates/syncular/Cargo.toml',
  },
  {
    name: 'syncular-protocol',
    manifestPath: 'rust/crates/protocol/Cargo.toml',
  },
  {
    name: 'syncular-codegen',
    manifestPath: 'rust/crates/codegen/Cargo.toml',
  },
  {
    name: 'syncular-runtime',
    manifestPath: 'rust/crates/runtime/Cargo.toml',
  },
  {
    name: 'syncular-testkit',
    manifestPath: 'rust/crates/testkit/Cargo.toml',
  },
  {
    name: 'syncular-client',
    manifestPath: 'rust/crates/client/Cargo.toml',
  },
];

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const version = resolveVersion(args.filter((arg) => arg !== '--dry-run'));
if (!version) {
  console.error(
    'Usage: bun scripts/stamp-cargo-versions.ts <suffix> | --version <version>'
  );
  process.exit(1);
}

const internalCrateNames = new Set(crates.map((crate) => crate.name));

console.log(`Stamping Cargo crate version: ${version}\n`);

for (const crate of crates) {
  const absolutePath = join(repoRoot, crate.manifestPath);
  const manifest = readFileSync(absolutePath, 'utf-8');
  const stamped = stampManifest(manifest, crate.name, version);
  if (!dryRun) {
    writeFileSync(absolutePath, stamped);
  }
  console.log(`  ${crate.name} → ${version}${dryRun ? ' (dry run)' : ''}`);
}

function resolveVersion(args: string[]): string | null {
  if (args[0] === '--version') {
    const exactVersion = args[1];
    return exactVersion ? normalizeReleaseVersion(exactVersion) : null;
  }

  const [suffix] = args;
  return suffix ? computeStampedVersion(suffix) : null;
}

function stampManifest(
  manifest: string,
  crateName: string,
  version: string
): string {
  const packageVersionPattern =
    /(\[package\][\s\S]*?\nversion\s*=\s*")[^"]+(")/;
  if (!packageVersionPattern.test(manifest)) {
    throw new Error(`Missing [package] version in ${crateName}`);
  }

  let stamped = manifest.replace(packageVersionPattern, `$1${version}$2`);

  for (const dependencyName of internalCrateNames) {
    if (dependencyName === crateName) {
      continue;
    }

    const dependencyPattern = new RegExp(
      `(^\\s*${escapeRegExp(dependencyName)}\\s*=\\s*\\{[^\\n]*version\\s*=\\s*")[^"]+(")`,
      'gm'
    );
    stamped = stamped.replace(dependencyPattern, `$1${version}$2`);
  }

  return stamped;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
