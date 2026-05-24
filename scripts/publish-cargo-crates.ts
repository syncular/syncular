#!/usr/bin/env bun
/**
 * Publishes Syncular Rust crates in dependency order.
 *
 * Use --dry-run in checks and --allow-dirty after release version stamping.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const allowDirty = args.has('--allow-dirty');
const skipExisting = !args.has('--no-skip-existing');

for (const crate of crates) {
  const version = readManifestVersion(crate);
  if (!dryRun && skipExisting && isVersionPublished(crate.name, version)) {
    console.warn(
      `[publish-cargo-crates] ${crate.name}@${version} is already published; skipping.`
    );
    continue;
  }

  const publishArgs = [
    'publish',
    '--manifest-path',
    crate.manifestPath,
    ...(dryRun ? ['--dry-run'] : []),
    ...(allowDirty ? ['--allow-dirty'] : []),
  ];

  console.log(
    `[publish-cargo-crates] cargo ${publishArgs.join(' ')} (${crate.name}@${version})`
  );
  runCargo(publishArgs);
}

function readManifestVersion(crate: CargoCrate): string {
  const manifestPath = join(repoRoot, crate.manifestPath);
  const manifest = readFileSync(manifestPath, 'utf-8');
  const match = manifest.match(/\[package\][\s\S]*?\nversion\s*=\s*"([^"]+)"/);
  if (!match?.[1]) {
    throw new Error(`Missing package version in ${crate.manifestPath}`);
  }
  return match[1];
}

function isVersionPublished(crateName: string, version: string): boolean {
  const result = Bun.spawnSync({
    cmd: ['cargo', 'info', `${crateName}@${version}`],
    cwd: repoRoot,
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
  });

  if (result.exitCode !== 0) {
    return false;
  }

  const stdout = new TextDecoder().decode(result.stdout);
  return stdout.includes(`version: ${version}`);
}

function runCargo(cargoArgs: string[]): void {
  const result = Bun.spawnSync({
    cmd: ['cargo', ...cargoArgs],
    cwd: repoRoot,
    stdout: 'inherit',
    stderr: 'inherit',
    env: process.env,
  });

  if (result.exitCode !== 0) {
    process.exit(result.exitCode);
  }
}
